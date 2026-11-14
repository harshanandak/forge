import { ForgeFailure } from "../../src/contract/failure.ts";
import { parseUntrustedJson } from "../../src/contract/untrusted.ts";
import { parseRestoreJson } from "../../src/core/state/restore-json.ts";
import {
  validateBlockId,
  validateOperationName,
  validateRequestId,
} from "../../src/generated/validators.ts";
import type {
  StateCommitRequest,
  StateReadRequest,
} from "../../src/ports/state-protocol.ts";
import { LIMITS } from "./issue-commands.ts";

export const MAX_STATE_ENTRIES = 256;
export const MAX_STATE_READ_SET = 256;
const MAX_ROWS = 1000;
type ObjectValue = Record<string, unknown>;

const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const closed = (
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is ObjectValue =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const text = (value: unknown, max: number, min = 1): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;
const key = (value: unknown): boolean => text(value, 500);
const integer = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const version = (value: unknown): boolean =>
  closed(value, ["epoch", "revision"]) &&
  text(value.epoch, 128) &&
  integer(value.revision);
const optional = (
  value: ObjectValue,
  name: string,
  valid: (input: unknown) => boolean,
): boolean => !Object.hasOwn(value, name) || valid(value[name]);
const rows = (value: unknown): boolean =>
  integer(value, 1) && value <= MAX_ROWS;

function query(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.kind) {
    case "get":
      return closed(value, ["kind", "key"]) && key(value.key);
    case "range":
      return (
        closed(value, ["kind", "limit"], ["from", "to", "descending"]) &&
        rows(value.limit) &&
        optional(value, "from", key) &&
        optional(value, "to", key) &&
        optional(value, "descending", (v) => typeof v === "boolean")
      );
    case "count":
    case "max":
      return closed(value, ["kind", "prefix"]) && text(value.prefix, 500, 0);
    case "history":
      return (
        closed(value, ["kind", "key", "limit"], ["before"]) &&
        key(value.key) &&
        rows(value.limit) &&
        optional(value, "before", (v) => integer(v, 1))
      );
    default:
      return false;
  }
}

function entries(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STATE_ENTRIES
  )
    return false;
  const seen = new Set<string>();
  return value.every((entry: unknown) => {
    if (
      !closed(entry, ["key", "value", "expectRevision"]) ||
      !text(entry.key, 500) ||
      !integer(entry.expectRevision) ||
      seen.has(entry.key)
    )
      return false;
    seen.add(entry.key);
    return true;
  });
}
function readSet(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_STATE_READ_SET) return false;
  const seen = new Set<string>();
  return value.every((entry: unknown) => {
    if (
      !closed(entry, ["namespace", "key", "expectRevision", "readVersion"]) ||
      !validateBlockId(entry.namespace).ok ||
      !key(entry.key) ||
      !integer(entry.expectRevision) ||
      !version(entry.readVersion)
    )
      return false;
    const id = JSON.stringify([entry.namespace, entry.key]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
const fence = (value: unknown): boolean =>
  closed(value, ["subject", "generation"]) &&
  key(value.subject) &&
  integer(value.generation, 1);
const invalid = (): never => {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: "Invalid state request or input budget exceeded",
    retry: "never",
  });
};

/** Pure byte boundary. Policy validates operation data and authority before any state access. */
export function parseStateInput(
  body: string | Uint8Array,
): StateReadRequest | StateCommitRequest {
  const parsed = parseUntrustedJson(body, LIMITS);
  if (!parsed.ok) return invalid();
  // The bounded parser keeps the last duplicate. Reuse the restore scanner to reject ambiguity,
  // including escaped labels and duplicates inside opaque operation data.
  try {
    parseRestoreJson(
      typeof body === "string" ? body : new TextDecoder().decode(body),
    );
  } catch {
    return invalid();
  }
  const value = parsed.value;
  if (
    !object(value) ||
    value.version !== 1 ||
    !validateBlockId(value.namespace).ok ||
    !validateOperationName(value.operation).ok ||
    !text(value.policyRevision, 128)
  )
    return invalid();
  const common = [
    "version",
    "kind",
    "namespace",
    "operation",
    "policyRevision",
  ];
  if (
    value.kind === "read" &&
    closed(value, [...common, "query"], ["readVersion"]) &&
    query(value.query) &&
    optional(value, "readVersion", version)
  )
    return value as unknown as StateReadRequest;
  if (
    value.kind === "commit" &&
    closed(
      value,
      [...common, "requestId", "input", "readVersion", "readSet", "entries"],
      ["fence"],
    ) &&
    validateRequestId(value.requestId).ok &&
    version(value.readVersion) &&
    readSet(value.readSet) &&
    entries(value.entries) &&
    optional(value, "fence", fence)
  )
    return value as unknown as StateCommitRequest;
  return invalid();
}
