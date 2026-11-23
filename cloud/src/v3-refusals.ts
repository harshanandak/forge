import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { canonicalJson, isObject } from "../../src/core/config/pointer.ts";
import type { ForgeError, LeaseHolder } from "../../src/generated/types.ts";
import { validateLeaseHolder } from "../../src/generated/validators.ts";
import { CREATE_GRAPH, CREATE_SCHEMA, KIND_REFUSED } from "./issue-create.ts";
import {
  configured,
  fail,
  INVALID_ID,
  QUALIFIED,
  storedId,
} from "./issue-read.ts";
import { UPDATE_GRAPH, UPDATE_SCHEMA } from "./issue-update.ts";
import { CLAIM_REFUSALS, UPDATE_REFUSALS } from "./v3-authority.ts";
import type { claimEffect, Frame, V3Image } from "./v3-store.ts";

export const CLAIM_INVALID = "Expected a valid issue claim";
const refused = (message: string): ForgeError => ({
  code: "INPUT_INVALID",
  message,
  retry: "never",
});
export const INPUT_REFUSALS = {
  "issue.create": [CREATE_GRAPH, CREATE_SCHEMA, KIND_REFUSED].map(refused),
  "issue.update": [UPDATE_GRAPH, UPDATE_SCHEMA, INVALID_ID].map(refused),
  "issue.claim": [CLAIM_INVALID, INVALID_ID].map(refused),
};

interface State {
  stage: "state";
  id: string;
  prefix: string;
  holder: LeaseHolder;
}
export type UpdateBasis = State & {
  expectRevision: number;
  generation: number;
};
export type ClaimBasis = State & { ttlMs: number };
const STATE_KEYS: Record<string, string> = {
  "issue.update": "expectRevision,generation,holder,id,prefix,stage",
  "issue.claim": "holder,id,prefix,stage,ttlMs",
};
const bytes = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(value)).length;
const counter = (value: unknown) =>
  Number.isInteger(value) && Number(value) >= 1;
const ttl = (value: unknown) =>
  typeof value === "number" &&
  value % 1000 === 0 &&
  counter(value / 1000) &&
  value <= 604_800_000;

export function basisFault(
  operation: string,
  basis: unknown,
): string | undefined {
  if (!Object.hasOwn(INPUT_REFUSALS, operation) || !isObject(basis))
    return "basis operation or shape";
  const keys = Object.keys(basis).sort().join();
  if (basis.stage === "input") return keys === "stage" ? undefined : "keys";
  const { id, prefix, holder, expectRevision, generation, ttlMs } = basis;
  if (basis.stage !== "state" || keys !== STATE_KEYS[operation]) return "keys";
  if (typeof id !== "string" || id.length > 200 || !QUALIFIED.test(id))
    return "id";
  try {
    configured(prefix);
  } catch {
    return "prefix";
  }
  const numbers =
    operation === "issue.update"
      ? counter(expectRevision) && counter(generation)
      : ttl(ttlMs);
  if (!numbers) return "numbers";
  if (!validateLeaseHolder(holder).ok || bytes(holder) > 8192) return "holder";
  return bytes({ ...basis, holder: null }) > 2048 ? "size" : undefined;
}

type Refused = { refusal: ForgeError; recorded: boolean };
function decided<T>(codes: readonly string[], run: () => T): T | Refused {
  try {
    return run();
  } catch (error) {
    if (error instanceof ForgeFailure && codes.includes(error.error.code))
      return { refusal: error.error, recorded: true };
    throw error;
  }
}

const minted = (image: V3Image) => (alias: string) =>
  [...image.entries.record.keys()].some((key) => {
    const value = image.load("record", key);
    return (
      isObject(value) &&
      value.id === `work-${key.slice(1)}` &&
      (value.prefix ?? "work") === alias
    );
  });

export function updateDecision(
  image: V3Image,
  basis: UpdateBasis,
  time: number,
) {
  const { id: given, prefix, expectRevision, holder, generation } = basis;
  return decided(UPDATE_REFUSALS, () => {
    const id = storedId(given, prefix, minted(image));
    const key = `r${id.slice(5)}`;
    const current = image.load("record", key);
    const prior = image.entries.record.get(key)?.revision;
    if (current === undefined || prior === undefined)
      throw fail("NOT_FOUND", "Issue was not found");
    if (!isObject(current)) throw fail("INTERNAL", "Invalid issue");
    const subject = `issue:${id}`;
    const lease = image.load("lease", subject) as Frame["lease"];
    const decision = decideLease(lease, {
      subject,
      holder,
      generation,
      mode: "held",
      nowMs: time,
    });
    if (!decision.ok) throw new ForgeFailure(decision.error);
    if (prior !== expectRevision)
      throw new ForgeFailure({
        code: "REVISION_CONFLICT",
        message: `Expected revision ${expectRevision}; current revision is ${prior}`,
        retry: "reconcile_first",
        currentRevision: prior,
      });
    return { key, current, lease };
  });
}

export function claimDecision(
  image: V3Image,
  basis: ClaimBasis,
  time: number,
  retryUntil: number,
  witnessed: boolean,
  effect: typeof claimEffect,
) {
  const { id: given, prefix, holder, ttlMs } = basis;
  return decided(CLAIM_REFUSALS, () => {
    const id = storedId(given, prefix, minted(image));
    if (witnessed)
      return {
        refusal: fail("LEASE_STALE", "The claim receipt expired").error,
        recorded: false,
      };
    const claim = { subject: `issue:${id}`, prefix, holder, ttlMs };
    return { effect: effect(image, claim, time, retryUntil) };
  });
}
