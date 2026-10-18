// The project config file and its edit history. Every write is one compare-and-set: under an
// exclusive lock, the file's current revision (the digest of its bytes) must equal the revision the
// caller read; the new bytes are written atomically and read back; a receipt keeps the exact prior
// bytes so the edit can be reverted.
import { DEFAULT_PARSE_LIMITS } from "../../contract/untrusted.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import type { SchemaProblem } from "../../contract/schema.ts";
import { validateConfigDocument } from "../../generated/validators.ts";
import type { ForgeError, ParseLimits } from "../../generated/types.ts";
import type { ClockPort } from "../../ports/clock.ts";
import type { ConfigCodecPort } from "../../ports/config-codec.ts";
import type { ConfigFiles } from "./files.ts";
import { digestBytes, isObject, type JsonObject } from "./pointer.ts";

export const CONFIG_FILE = ".forge/config.yaml";
export const HISTORY_DIR = ".forge/config-history";
export const LOCK_FILE = ".forge/config.lock";
const RECEIPT_VERSION = "forge.config-receipt/1";
const HISTORY_KEPT = 100;

export interface ProjectConfig {
  /** Exact bytes on disk; undefined when the file does not exist. */
  readonly bytes: Uint8Array | undefined;
  /** Digest of the bytes; an absent file has the digest of no bytes. */
  readonly revision: string;
  /** The decoded document; undefined when the file is absent, empty or undecodable. */
  readonly document: JsonObject | undefined;
  /** Why the file could not be decoded; edits are refused until it is fixed or reverted. */
  readonly unreadable: ForgeError | undefined;
  /** Schema problems of a decoded document. */
  readonly problems: readonly SchemaProblem[];
}

export interface Receipt {
  readonly schemaVersion: typeof RECEIPT_VERSION;
  readonly id: string;
  readonly op: string;
  readonly at: string;
  /** Revision before the edit. */
  readonly from: string;
  /** Revision the edit produced. */
  readonly to: string;
  /** Exact prior bytes in base64; null when the file did not exist. */
  readonly before: string | null;
  /** The receipt this edit reverted, if it was a revert. */
  readonly reverts?: string;
}

export interface Planned {
  /** New file bytes, or null to remove the file. */
  readonly bytes: Uint8Array | null;
  readonly reverts?: string;
}

export interface Committed {
  readonly from: string;
  readonly to: string;
  /** Receipt id, or null when the bytes did not change. */
  readonly receipt: string | null;
  readonly fileRemoved: boolean;
}

export interface StoreDeps {
  readonly files: ConfigFiles;
  readonly codec: ConfigCodecPort;
  readonly clock: ClockPort;
  readonly limits?: ParseLimits;
}

const EMPTY = new Uint8Array();

export function readProject(deps: StoreDeps): ProjectConfig {
  const bytes = deps.files.read(CONFIG_FILE);
  const revision = digestBytes(bytes ?? EMPTY);
  const base = { bytes, revision, problems: [] };
  if (bytes === undefined)
    return { ...base, document: undefined, unreadable: undefined };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ...base,
      document: undefined,
      unreadable: {
        code: "INPUT_INVALID",
        message: `${CONFIG_FILE} is not valid UTF-8`,
        retry: "never",
      },
    };
  }
  if (text.trim() === "")
    return { ...base, document: undefined, unreadable: undefined };
  const decoded = deps.codec.decode(text, deps.limits ?? DEFAULT_PARSE_LIMITS);
  if (!decoded.ok) {
    return {
      ...base,
      document: undefined,
      unreadable: {
        ...decoded.error,
        message: `${CONFIG_FILE}: ${decoded.error.message}`,
      },
    };
  }
  if (decoded.value === null)
    return { ...base, document: undefined, unreadable: undefined };
  if (!isObject(decoded.value)) {
    return {
      ...base,
      document: undefined,
      unreadable: {
        code: "INPUT_INVALID",
        message: `${CONFIG_FILE} must hold a mapping at the top level`,
        retry: "never",
      },
    };
  }
  const checked = validateConfigDocument(decoded.value);
  return {
    ...base,
    document: decoded.value,
    unreadable: undefined,
    problems: checked.ok ? [] : checked.problems,
  };
}

export function revisionConflict(
  expected: string,
  observed: string,
): ForgeFailure {
  return new ForgeFailure({
    code: "REVISION_CONFLICT",
    message: `${CONFIG_FILE} changed since it was read (expected revision ${expected}, found ${observed})`,
    retry: "reconcile_first",
    expected,
    observed,
    reconcileWith: "config.show",
    repair:
      "read the config again with config show, then make the change against the new revision",
  });
}

function receiptPath(id: string): string {
  return `${HISTORY_DIR}/${id}.json`;
}

export function listReceipts(deps: StoreDeps): Receipt[] {
  const receipts: Receipt[] = [];
  for (const name of deps.files.list(HISTORY_DIR)) {
    if (!/^\d{6,}\.json$/.test(name)) continue;
    const bytes = deps.files.read(`${HISTORY_DIR}/${name}`);
    if (bytes === undefined) continue;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (isObject(value) && value.schemaVersion === RECEIPT_VERSION) {
        receipts.push(value as unknown as Receipt);
      }
    } catch {
      // a damaged receipt is skipped; it can never match a live revision anyway
    }
  }
  return receipts.sort((a, b) => a.id.localeCompare(b.id));
}

function nextId(receipts: readonly Receipt[]): string {
  const last = receipts.at(-1);
  const next = last === undefined ? 1 : Number.parseInt(last.id, 10) + 1;
  return String(next).padStart(6, "0");
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | null): boolean {
  if (a === undefined || b === null) return a === undefined && b === null;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * One compare-and-set edit. `plan` sees the config as it is under the lock and returns the new
 * bytes; it may throw a ForgeFailure to refuse.
 */
export function commit(
  deps: StoreDeps,
  op: string,
  expectRevision: string,
  plan: (current: ProjectConfig) => Planned,
): Committed {
  const lock = new TextEncoder().encode(
    JSON.stringify({ op, at: new Date(deps.clock.now()).toISOString() }),
  );
  if (!deps.files.createExclusive(LOCK_FILE, lock)) {
    throw new ForgeFailure({
      code: "REVISION_CONFLICT",
      message: `another config edit holds ${LOCK_FILE}`,
      retry: "reconcile_first",
      reconcileWith: "config.show",
      repair: `read the config again once that edit finishes; if no edit is running, a crashed one left ${LOCK_FILE} behind and it can be deleted`,
    });
  }
  try {
    const current = readProject(deps);
    if (current.revision !== expectRevision) {
      throw revisionConflict(expectRevision, current.revision);
    }
    const planned = plan(current);
    const to = digestBytes(planned.bytes ?? EMPTY);
    if (sameBytes(current.bytes, planned.bytes)) {
      return { from: current.revision, to, receipt: null, fileRemoved: false };
    }
    const receipts = listReceipts(deps);
    const id = nextId(receipts);
    const receipt: Receipt = {
      schemaVersion: RECEIPT_VERSION,
      id,
      op,
      at: new Date(deps.clock.now()).toISOString(),
      from: current.revision,
      to,
      before:
        current.bytes === undefined
          ? null
          : Buffer.from(current.bytes).toString("base64"),
      ...(planned.reverts === undefined ? {} : { reverts: planned.reverts }),
    };
    deps.files.write(
      receiptPath(id),
      new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`),
    );
    for (const old of receipts.slice(
      0,
      Math.max(0, receipts.length + 1 - HISTORY_KEPT),
    )) {
      deps.files.remove(receiptPath(old.id));
    }
    if (planned.bytes === null) deps.files.remove(CONFIG_FILE);
    else deps.files.write(CONFIG_FILE, planned.bytes);
    const readback = digestBytes(deps.files.read(CONFIG_FILE) ?? EMPTY);
    if (readback !== to) {
      throw new ForgeFailure({
        code: "INTERNAL",
        message: `${CONFIG_FILE} read back as ${readback} after writing ${to}`,
        retry: "reconcile_first",
        reconcileWith: "config.show",
      });
    }
    return {
      from: current.revision,
      to,
      receipt: id,
      fileRemoved: planned.bytes === null && current.bytes !== undefined,
    };
  } finally {
    deps.files.remove(LOCK_FILE);
  }
}

export function decodeReceiptBytes(receipt: Receipt): Uint8Array | null {
  return receipt.before === null
    ? null
    : new Uint8Array(Buffer.from(receipt.before, "base64"));
}
