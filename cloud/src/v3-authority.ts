import {
  canonicalJson,
  digestBytes,
  isObject,
} from "../../src/core/config/pointer.ts";
import { checkLeaseRecord } from "../../src/core/state/index.ts";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import { validateForgeError } from "../../src/generated/validators.ts";
import { NAMESPACE } from "./lease-command.ts";

export const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
export const isNat = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const keysOf = (value: Record<string, unknown>) =>
  Object.keys(value).sort().join();
const OUTCOME_KEYS = "fingerprint,id,retryUntil,scope,status";
const REFUSAL_KEYS = "fingerprint,id,result,retryUntil,scope,status";
const WITNESS_KEYS = "digest,generation,id,namespace,subject";
const OPERATIONS = ["lease.claim", "lease.renew", "lease.release"];
const REFUSALS = [
  "INPUT_INVALID",
  "LEASE_EXPIRED",
  "LEASE_HELD",
  "LEASE_NOT_HELD",
  "LEASE_STALE",
];

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

function outcomeFault(outcome: unknown): string | undefined {
  if (!isObject(outcome) || !isObject(outcome.scope)) return "outcome shape";
  const { scope, result } = outcome;
  if (
    keysOf(outcome) !== (result === undefined ? OUTCOME_KEYS : REFUSAL_KEYS) ||
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
  const status = result === undefined ? "ok" : refusalCode(result);
  return status !== undefined && outcome.status === status
    ? undefined
    : "outcome status";
}

export function authorityFault({
  operation,
  lease,
  outcome,
  witness,
}: Readonly<Record<string, unknown>>): string | undefined {
  if (lease !== undefined && !validLease(lease)) return "lease";
  if (
    isObject(lease) &&
    (lease.releasedAt !== undefined) !== (operation === "lease.release")
  )
    return "lease release marker";
  const outcomeError =
    outcome === undefined ? undefined : outcomeFault(outcome);
  if (outcomeError !== undefined) return outcomeError;
  if (isObject(outcome)) {
    if (!OPERATIONS.includes(String(operation))) return "outcome operation";
    if (!fingerprintTied(operation, lease, outcome))
      return "outcome fingerprint";
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
      isObject(witness) &&
      isObject(lease) &&
      isObject(outcome) &&
      keysOf(witness) === WITNESS_KEYS &&
      witness.namespace === NAMESPACE &&
      witness.id === outcome.id &&
      witness.subject === lease.subject &&
      witness.generation === lease.generation &&
      witness.digest === digestBytes(String(outcome.fingerprint))
    )
  )
    return "witness";
  return undefined;
}
