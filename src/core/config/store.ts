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
import {
  MAX_CONFIG_FILE_BYTES,
  MAX_HISTORY_FILES,
  MAX_RECEIPT_FILE_BYTES,
  fileLimitExceeded,
  readProjectFile,
  type ConfigFiles,
} from "./files.ts";
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
  const bytes = readProjectFile(deps.files, CONFIG_FILE, MAX_CONFIG_FILE_BYTES);
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

export interface DamagedReceipt {
  readonly file: string;
  readonly problem: string;
}

export interface History {
  /** Receipts that are whole and whose prior bytes match their `from` revision, oldest first. */
  readonly receipts: readonly Receipt[];
  /** Receipt files that are not; they are reported and never applied. */
  readonly damaged: readonly DamagedReceipt[];
  /** The highest receipt number on disk, damaged files included, so a new id never reuses one. */
  readonly last: number;
}

const RECEIPT_NAME = /^(\d{6,})\.json$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "id",
  "op",
  "at",
  "from",
  "to",
  "before",
  "reverts",
]);

/** Why a parsed receipt cannot be trusted, or undefined when it can. */
function receiptProblem(value: unknown, id: string): string | undefined {
  if (!isObject(value)) return "it is not a JSON object";
  if (value.schemaVersion !== RECEIPT_VERSION)
    return `schemaVersion is not ${RECEIPT_VERSION}`;
  const extra = Object.keys(value).find((key) => !RECEIPT_KEYS.has(key));
  if (extra !== undefined) return `it has an unknown field "${extra}"`;
  if (value.id !== id) return `its id does not match its file name ${id}`;
  if (typeof value.op !== "string" || value.op === "") return "op is missing";
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at)))
    return "at is not a timestamp";
  if (typeof value.from !== "string" || !DIGEST.test(value.from))
    return "from is not a digest";
  if (typeof value.to !== "string" || !DIGEST.test(value.to))
    return "to is not a digest";
  if (
    value.reverts !== undefined &&
    (typeof value.reverts !== "string" || !/^\d{6,}$/.test(value.reverts))
  )
    return "reverts is not a receipt id";
  if (value.before !== null && typeof value.before !== "string")
    return "before is neither base64 text nor null";
  if (typeof value.before === "string" && !BASE64.test(value.before))
    return "before is not base64";
  const before =
    value.before === null ? EMPTY : Buffer.from(value.before, "base64");
  if (digestBytes(before) !== value.from)
    return "its prior bytes do not match its from revision";
  return undefined;
}

export function readHistory(deps: StoreDeps): History {
  const receipts: Receipt[] = [];
  const damaged: DamagedReceipt[] = [];
  let last = 0;
  const names = deps.files.list(HISTORY_DIR);
  if (names.length > MAX_HISTORY_FILES)
    throw new ForgeFailure({
      code: "LIMIT_EXCEEDED",
      message: `${HISTORY_DIR} exceeds the receipt file count limit of ${MAX_HISTORY_FILES}`,
      expected: { maxFiles: MAX_HISTORY_FILES },
      retry: "never",
    });
  for (const name of names) {
    const id = RECEIPT_NAME.exec(name)?.[1];
    if (id === undefined) continue;
    last = Math.max(last, Number.parseInt(id, 10));
    const file = `${HISTORY_DIR}/${name}`;
    const bytes = readProjectFile(deps.files, file, MAX_RECEIPT_FILE_BYTES);
    if (bytes === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      damaged.push({ file, problem: "it is not valid JSON" });
      continue;
    }
    const problem = receiptProblem(value, id);
    if (problem === undefined) receipts.push(value as Receipt);
    else damaged.push({ file, problem });
  }
  return {
    receipts: receipts.sort((a, b) => a.id.localeCompare(b.id)),
    damaged,
    last,
  };
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
    if (
      planned.bytes !== null &&
      planned.bytes.byteLength > MAX_CONFIG_FILE_BYTES
    )
      throw fileLimitExceeded(CONFIG_FILE, MAX_CONFIG_FILE_BYTES);
    const to = digestBytes(planned.bytes ?? EMPTY);
    if (sameBytes(current.bytes, planned.bytes)) {
      return { from: current.revision, to, receipt: null, fileRemoved: false };
    }
    const history = readHistory(deps);
    const receipts = history.receipts;
    const id = String(history.last + 1).padStart(6, "0");
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
    const readback = digestBytes(
      readProjectFile(deps.files, CONFIG_FILE, MAX_CONFIG_FILE_BYTES) ?? EMPTY,
    );
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
