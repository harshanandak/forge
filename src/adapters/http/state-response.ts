import { ForgeFailure } from "../../contract/failure.ts";
import { canonicalJson } from "../../core/config/pointer.ts";
import {
  validateForgeError,
  validateStateEvent,
  validateStateRecord,
} from "../../generated/validators.ts";
import type { LeaseConflict } from "../../generated/types.ts";
import type * as State from "../../ports/state-protocol.ts";
import { carriesToken, conflictOf } from "./command-refusal.ts";

const statuses: Record<string, number> = {};
for (const [status, codes] of [
  [400, "INPUT_INVALID CONTEXT_MISSING"],
  [401, "AUTH_REQUIRED AUTH_INVALID AUTH_REVOKED AUTH_EXPIRED"],
  [403, "AUTH_FORBIDDEN AUTH_DEVICE_MISMATCH"],
  [404, "UNKNOWN_COMMAND"],
  [
    409,
    "INPUT_CONFLICT REVISION_CONFLICT LEASE_HELD LEASE_STALE LEASE_EXPIRED LEASE_NOT_HELD",
  ],
  [500, "INTERNAL"],
  [503, "UNAVAILABLE QUOTA_EXHAUSTED STORAGE_LIMIT_EXCEEDED"],
] as const)
  for (const code of codes.split(" ")) statuses[code] = status;
type Request = State.StateReadRequest | State.StateCommitRequest;
export type StateAnswer<T> =
  | { readonly kind: "ok"; readonly result: T }
  | {
      readonly kind: "refused";
      readonly code: string;
      readonly lease?: LeaseConflict;
    };
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const closed = (v: unknown, keys: string): v is Record<string, unknown> =>
  object(v) && Object.keys(v).sort().join() === keys;
const integer = (v: unknown, min = 0): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 128;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const compare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const bad = (): never => {
  throw new ForgeFailure({
    code: "UNAVAILABLE",
    message: "The Forge cloud state answer failed its checks.",
    retry: "never",
  });
};

/** Only checked transport facts escape; server diagnostics never do. */
export function decodeState<
  T extends State.StateReadResult | State.StateCommitResult,
>(
  status: number,
  body: Record<string, unknown>,
  call: Request,
  project: string,
  token: string,
): StateAnswer<T> {
  if (
    carriesToken(body, token) ||
    !Array.isArray(body.warnings) ||
    body.warnings.length !== 0
  )
    return bad();
  if (body.ok === false) {
    if (!closed(body, "error,ok,status,warnings") || body.status !== "FAIL")
      return bad();
    const checked = validateForgeError(body.error);
    if (!checked.ok) return bad();
    const { code } = checked.value;
    if (!Object.hasOwn(statuses, code) || statuses[code] !== status)
      return bad();
    if (!code.startsWith("LEASE_")) return { kind: "refused", code };
    const lease =
      call.kind === "commit" && call.fence
        ? conflictOf(checked.value.lease, call.fence.subject)
        : undefined;
    if (lease === undefined) return bad();
    return { kind: "refused", code, lease };
  }
  if (
    !closed(body, "ok,result,status,warnings") ||
    body.ok !== true ||
    body.status !== "OK" ||
    status !== 200
  )
    return bad();
  const value = body.result;
  if (
    !closed(
      value,
      call.kind === "read"
        ? "namespace,policyRevision,project,readVersion,result,version"
        : "namespace,policyRevision,project,readVersion,records,requestId,result,version",
    )
  )
    return bad();
  const version = value.readVersion;
  if (
    value.version !== 1 ||
    value.project !== project ||
    value.namespace !== call.namespace ||
    !text(value.policyRevision) ||
    value.policyRevision === "discover" ||
    (call.policyRevision !== "discover" &&
      value.policyRevision !== call.policyRevision) ||
    !closed(version, "epoch,revision") ||
    !text(version.epoch) ||
    !integer(version.revision)
  )
    return bad();
  const pin = call.readVersion;
  if (
    pin &&
    (version.epoch !== pin.epoch ||
      (call.kind === "read"
        ? version.revision !== pin.revision
        : version.revision < pin.revision + call.entries.length))
  )
    return bad();
  const watermark = version.revision;
  const validRecord = (v: unknown, key?: string, event = false): boolean => {
    const checked = event ? validateStateEvent(v) : validateStateRecord(v);
    return (
      checked.ok &&
      checked.value.namespace === call.namespace &&
      (key === undefined || checked.value.key === key) &&
      integer(checked.value.revision, 1) &&
      checked.value.revision <= watermark
    );
  };
  if (call.kind === "commit") {
    if (
      value.requestId !== call.requestId ||
      value.result !== null ||
      !Array.isArray(value.records) ||
      value.records.length !== call.entries.length
    )
      return bad();
    for (const [i, item] of value.records.entries()) {
      const entry = call.entries[i]!;
      if (
        !validRecord(item, entry.key) ||
        !object(item) ||
        (entry.expectRevision > 0 &&
          item.revision !== entry.expectRevision + 1) ||
        !equal(item.value, entry.value) ||
        !equal(item.updatedBy, call.context.actor)
      )
        return bad();
    }
  } else {
    const result = value.result,
      query = call.query;
    if (!object(result) || result.kind !== query.kind) return bad();
    if (query.kind === "get") {
      if (
        !closed(result, "kind,record") ||
        (result.record !== null && !validRecord(result.record, query.key))
      )
        return bad();
    } else if (query.kind === "count" || query.kind === "max") {
      if (!closed(result, "kind,value") || !integer(result.value)) return bad();
    } else if (query.kind === "range") {
      if (
        !closed(result, "kind,next,records") ||
        !Array.isArray(result.records) ||
        result.records.length > query.limit
      )
        return bad();
      let previous: string | undefined;
      for (const item of result.records) {
        if (!validRecord(item) || !object(item) || typeof item.key !== "string")
          return bad();
        const key = item.key;
        if (
          (query.from !== undefined && compare(key, query.from) < 0) ||
          (query.to !== undefined && compare(key, query.to) >= 0) ||
          (previous !== undefined &&
            (query.descending
              ? compare(previous, key) <= 0
              : compare(previous, key) >= 0))
        )
          return bad();
        previous = key;
      }
      const next =
        result.records.length === query.limit && previous !== undefined
          ? previous + (query.descending ? "" : "\0")
          : null;
      if (result.next !== next) return bad();
    } else if (query.kind === "history") {
      if (
        !closed(result, "events,kind,next") ||
        !Array.isArray(result.events) ||
        result.events.length > query.limit ||
        !result.events.every((item) => validRecord(item, query.key, true))
      )
        return bad();
      // Event sequence is not a record revision; repeated revisions are legitimate after delete.
      if (
        result.events.length === query.limit
          ? !integer(result.next, 1) ||
            result.next > version.revision ||
            (query.before !== undefined && result.next >= query.before)
          : result.next !== null
      )
        return bad();
    }
  }
  return { kind: "ok", result: value as unknown as T };
}
