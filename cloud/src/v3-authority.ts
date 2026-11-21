import {
  canonicalJson,
  digestBytes,
  isObject,
} from "../../src/core/config/pointer.ts";
import { checkLeaseRecord } from "../../src/core/state/index.ts";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import { validateForgeError } from "../../src/generated/validators.ts";
import { NAMESPACE, REFUSALS } from "./lease-command.ts";

export const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
export const isNat = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const keysOf = (value: Record<string, unknown>) =>
  Object.keys(value).sort().join();
const OUTCOME_KEYS = "fingerprint,id,retryUntil,scope,status";
const REFUSAL_KEYS = "fingerprint,id,result,retryUntil,scope,status";
const ARCHIVED_KEYS = "fingerprint,id,resultDigest,retryUntil,scope,status";
const WITNESS_KEYS = "digest,generation,id,namespace,subject";
const OPERATIONS = ["lease.claim", "lease.renew", "lease.release"];

function validLease(lease: unknown): boolean {
  try {
    checkLeaseRecord(lease as LeaseRecord);
    return true;
  } catch {
    return false;
  }
}

function refusalCode(result: unknown): unknown {
  return validateForgeError(result).ok &&
    REFUSALS.includes((result as ForgeError).code)
    ? (result as ForgeError).code
    : undefined;
}

function fingerprintTied(
  operation: unknown,
  lease: unknown,
  outcome: Record<string, unknown>,
): boolean {
  try {
    const input: unknown = JSON.parse(String(outcome.fingerprint));
    return (
      isObject(input) &&
      canonicalJson(input) === outcome.fingerprint &&
      operation === `lease.${String(input.route)}` &&
      canonicalJson({ family: "lease", ...Object(input.scope) }) ===
        canonicalJson(outcome.scope) &&
      (!isObject(lease) ||
        (input.subject === lease.subject &&
          canonicalJson(input.holder) === canonicalJson(lease.holder) &&
          input.generation ===
            (operation === "lease.claim" ? null : lease.generation)))
    );
  } catch {
    return false;
  }
}

function outcomeFault(outcome: unknown, portable = false): string | undefined {
  if (!isObject(outcome) || !isObject(outcome.scope)) return "outcome shape";
  const { scope, result } = outcome;
  const archived = portable && outcome.status !== "ok";
  const liveKeys = result === undefined ? OUTCOME_KEYS : REFUSAL_KEYS;
  if (
    keysOf(outcome) !== (archived ? ARCHIVED_KEYS : liveKeys) ||
    (archived &&
      (!isDigest(outcome.resultDigest) ||
        typeof outcome.status !== "string")) ||
    typeof outcome.id !== "string" ||
    outcome.id.length === 0 ||
    typeof outcome.fingerprint !== "string" ||
    outcome.fingerprint.length === 0 ||
    !isNat(outcome.retryUntil)
  )
    return "outcome fields";
  if (
    keysOf(scope) !== "family,principal,version" ||
    scope.family !== "lease" ||
    scope.version !== 2 ||
    !isDigest(scope.principal)
  )
    return "outcome scope";
  if (archived) return undefined;
  const status = result === undefined ? "ok" : refusalCode(result);
  return status !== undefined && outcome.status === status
    ? undefined
    : "outcome status";
}

function witnessMatches(
  witness: unknown,
  lease: unknown,
  id: unknown,
): witness is Record<string, unknown> {
  return (
    isObject(witness) &&
    isObject(lease) &&
    keysOf(witness) === WITNESS_KEYS &&
    witness.namespace === NAMESPACE &&
    witness.id === id &&
    witness.subject === lease.subject &&
    witness.generation === lease.generation &&
    isDigest(witness.digest)
  );
}

export function sealedAuthorityValid(
  collection: "lease" | "outcome" | "witness",
  key: string,
  value: unknown,
): boolean {
  if (!isObject(value)) return false;
  if (collection === "lease") return value.subject === key && validLease(value);
  const { lease, outcome, time, witness } = value;
  if (collection === "witness")
    return (
      isObject(lease) &&
      lease.releasedAt === undefined &&
      validLease(lease) &&
      witnessMatches(witness, lease, key)
    );
  return (
    isNat(time) &&
    isObject(outcome) &&
    outcome.id === key &&
    outcomeFault(outcome) === undefined &&
    (outcome.status === "ok" ? validLease(lease) : lease === undefined)
  );
}

export function authorityFault(
  { operation, lease, outcome, witness }: Readonly<Record<string, unknown>>,
  portable = false,
): string | undefined {
  if (lease !== undefined && !validLease(lease)) return "lease";
  if (
    isObject(lease) &&
    (lease.releasedAt !== undefined) !== (operation === "lease.release")
  )
    return "lease release marker";
  const outcomeError =
    outcome === undefined ? undefined : outcomeFault(outcome, portable);
  if (outcomeError !== undefined) return outcomeError;
  if ((outcome !== undefined) !== OPERATIONS.includes(String(operation)))
    return "outcome operation";
  if (isObject(outcome)) {
    if (!fingerprintTied(operation, lease, outcome))
      return "outcome fingerprint";
    if (
      !["ok", "INPUT_INVALID"].includes(String(outcome.status)) &&
      (outcome.status === "LEASE_HELD") !== (operation === "lease.claim")
    )
      return "outcome route";
  }
  if ((lease !== undefined) !== (isObject(outcome) && outcome.status === "ok"))
    return "lease and ok outcome pairing";
  if (
    (witness !== undefined) !==
    (operation === "lease.claim" && lease !== undefined)
  )
    return "witness";
  if (
    witness !== undefined &&
    !(
      isObject(outcome) &&
      witnessMatches(witness, lease, outcome.id) &&
      witness.digest === digestBytes(String(outcome.fingerprint))
    )
  )
    return "witness";
  return undefined;
}
