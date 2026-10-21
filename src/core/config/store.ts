// The project config file. Every write is one compare-and-set: under an exclusive lock, the
// file's current revision (the digest of its bytes) must equal the revision the caller read; the
// new bytes are written atomically and read back. Version control keeps the file's history.
import { DEFAULT_PARSE_LIMITS } from "../../contract/untrusted.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import type { SchemaProblem } from "../../contract/schema.ts";
import { validateConfigDocument } from "../../generated/validators.ts";
import type { ForgeError, ParseLimits } from "../../generated/types.ts";
import type { ClockPort } from "../../ports/clock.ts";
import type { ConfigCodecPort } from "../../ports/config-codec.ts";
import {
  MAX_CONFIG_FILE_BYTES,
  fileLimitExceeded,
  readProjectFile,
  type ConfigFiles,
} from "./files.ts";
import { digestBytes, isObject, type JsonObject } from "./pointer.ts";
import { expandShortForm } from "./short.ts";

export const CONFIG_FILE = ".forge/config.yaml";
export const LOCK_FILE = ".forge/config.lock";

export interface ProjectConfig {
  /** Exact bytes on disk; undefined when the file does not exist. */
  readonly bytes: Uint8Array | undefined;
  /** Digest of the bytes; an absent file has the digest of no bytes. */
  readonly revision: string;
  /** The decoded document; undefined when the file is absent, empty or undecodable. */
  readonly document: JsonObject | undefined;
  /** Why the file could not be decoded; edits are refused until it is fixed. */
  readonly unreadable: ForgeError | undefined;
  /** Schema problems of a decoded document. */
  readonly problems: readonly SchemaProblem[];
}

export interface Planned {
  /** New file bytes, or null to remove the file. */
  readonly bytes: Uint8Array | null;
}

export interface Committed {
  readonly from: string;
  readonly to: string;
  /** False when the planned bytes equal the file's, so nothing was written. */
  readonly changed: boolean;
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
  const document = expandShortForm(decoded.value);
  const checked = validateConfigDocument(document);
  return {
    ...base,
    document,
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

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | null): boolean {
  if (a === undefined || b === null) return a === undefined && b === null;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * One compare-and-set edit. `plan` sees the config as it is under the lock and returns the new
 * bytes; it may throw a ForgeFailure to refuse. An undefined `expectRevision` expects no file.
 */
export function commit(
  deps: StoreDeps,
  op: string,
  expectRevision: string | undefined,
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
    if (expectRevision === undefined && current.bytes !== undefined) {
      throw new ForgeFailure({
        code: "REVISION_CONFLICT",
        message: `${CONFIG_FILE} already exists, so this edit needs expectRevision`,
        retry: "reconcile_first",
        observed: current.revision,
        reconcileWith: "config.show",
        repair:
          "read the revision with config show and pass it as expectRevision",
      });
    }
    if (expectRevision !== undefined && current.revision !== expectRevision) {
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
      return { from: current.revision, to, changed: false, fileRemoved: false };
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
      changed: true,
      fileRemoved: planned.bytes === null && current.bytes !== undefined,
    };
  } finally {
    deps.files.remove(LOCK_FILE);
  }
}
