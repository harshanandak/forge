import {
  canonicalJson,
  digestBytes,
  isObject,
} from "../../src/core/config/pointer.ts";
import { checkLeaseRecord } from "../../src/core/state/index.ts";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import * as validators from "../../src/generated/validators.ts";
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
export const CLAIM_REFUSALS = [
  "INPUT_INVALID",
  "NOT_FOUND",
  "INPUT_CONFLICT",
  "CLAIM_BLOCKED",
  "LEASE_HELD",
];
export const UPDATE_REFUSALS = REFUSALS.filter(
  (code) => code !== "LEASE_HELD",
).concat("NOT_FOUND", "REVISION_CONFLICT");

export const trackerValid = (result: unknown) =>
  validators.validateTrackerItem(result).ok;

function validLease(lease: unknown): boolean {
  try {
    checkLeaseRecord(lease as LeaseRecord);
    return true;
  } catch {
    return false;
  }
}

function refusalCode(result: unknown, codes = REFUSALS): unknown {
  return validators.validateForgeError(result).ok &&
    codes.includes((result as ForgeError).code)
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
    if (String(operation).startsWith("issue.")) {
      if (!isObject(input) || !isObject(outcome.scope)) return false;
      const { family: _family, ...scope } = outcome.scope;
      return (
        isDigest(input.input) &&
        canonicalJson({ scope, input: input.input }) === outcome.fingerprint
      );
    }
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

function outcomeFault(
  outcome: unknown,
  typed?: boolean,
  replay = false,
  grant = false,
) {
  if (!isObject(outcome) || !isObject(outcome.scope)) return "outcome shape";
  const { scope, result } = outcome;
  const command = typed ?? scope.family === "command";
  const codes = !command ? REFUSALS : grant ? CLAIM_REFUSALS : UPDATE_REFUSALS;
  const archived = replay && (command || outcome.status !== "ok");
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
    scope.family !== (command ? "command" : "lease") ||
    scope.version !== 2 ||
    !isDigest(scope.principal)
  )
    return "outcome scope";
  if (
    command &&
    (!/^c2:[a-f0-9]{64}$/.test(outcome.id) ||
      typeof outcome.status !== "string" ||
      (outcome.status !== "ok" && !codes.includes(outcome.status)))
  )
    return "command outcome";
  if (archived) return undefined;
  if (command && outcome.status === "ok")
    return (grant
      ? validators.validateLeaseGrant
      : validators.validateTrackerItem)(result).ok
      ? undefined
      : "command result";
  const status = result === undefined ? "ok" : refusalCode(result, codes);
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
  if (!isNat(time) || !isObject(outcome) || outcome.id !== key) return false;
  const grant =
    lease !== undefined ||
    (typeof outcome.status === "string" &&
      CLAIM_REFUSALS.includes(outcome.status));
  return (
    outcomeFault(outcome, undefined, false, grant) === undefined &&
    (outcome.status === "ok" && (lease !== undefined || !("result" in outcome))
      ? validLease(lease)
      : lease === undefined)
  );
}

export function authorityFault(
  {
    operation,
    lease,
    outcome,
    witness,
    basis,
  }: Readonly<Record<string, unknown>>,
  replay = false,
): string | undefined {
  if (lease !== undefined && !validLease(lease)) return "lease";
  if (
    isObject(lease) &&
    (lease.releasedAt !== undefined) !== (operation === "lease.release")
  )
    return "lease release marker";
  const create = operation === "issue.create";
  const claim = operation === "issue.claim";
  const command = create || operation === "issue.update" || claim;
  const outcomeError =
    outcome === undefined
      ? undefined
      : outcomeFault(outcome, command, replay, claim);
  if (outcomeError !== undefined) return outcomeError;
  const refusal = command && isObject(outcome) && outcome.status !== "ok";
  if ((basis !== undefined) !== refusal) return "basis";
  if (command && !claim)
    return lease === undefined &&
      witness === undefined &&
      isObject(outcome) &&
      (!create || ["ok", "INPUT_INVALID"].includes(String(outcome.status))) &&
      fingerprintTied(operation, lease, outcome)
      ? undefined
      : "command frame";
  if (
    (outcome !== undefined) !==
    (claim || OPERATIONS.includes(String(operation)))
  )
    return "outcome operation";
  if (isObject(outcome)) {
    if (!fingerprintTied(operation, lease, outcome))
      return "outcome fingerprint";
    if (
      !claim &&
      !["ok", "INPUT_INVALID"].includes(String(outcome.status)) &&
      (outcome.status === "LEASE_HELD") !== (operation === "lease.claim")
    )
      return "outcome route";
  }
  if ((lease !== undefined) !== (isObject(outcome) && outcome.status === "ok"))
    return "lease and ok outcome pairing";
  if (
    (witness !== undefined) !==
    ((claim || operation === "lease.claim") && lease !== undefined)
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
