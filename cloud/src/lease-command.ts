import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { checkLeaseSubject } from "../../src/core/state/index.ts";
import type {
  ForgeError,
  LeaseHolder,
  LeaseRecord,
} from "../../src/generated/types.ts";
import type { ReceiptScope } from "./issue-request-id.ts";

export const NAMESPACE = "forge/work";

export interface LeaseCommand {
  readonly route: "claim" | "renew" | "release";
  readonly subject: string;
  readonly holder: LeaseHolder;
  readonly ttlMs: number | null;
  readonly generation: number | null;
  readonly rawId: string;
  readonly requestId: string;
  readonly scope: ReceiptScope;
}

export const leaseFingerprint = ({
  scope,
  route,
  subject,
  holder,
  generation,
  ttlMs,
}: LeaseCommand): string =>
  canonicalJson({ scope, route, subject, holder, generation, ttlMs });

export const requestConflict = (): ForgeFailure =>
  new ForgeFailure({
    code: "INPUT_CONFLICT",
    message: "Request ID belongs to a different input",
    retry: "reconcile_first",
  });

export const REFUSALS = [
  "INPUT_INVALID",
  "LEASE_EXPIRED",
  "LEASE_HELD",
  "LEASE_NOT_HELD",
  "LEASE_STALE",
];

export const recordable = (error: unknown): error is ForgeFailure =>
  error instanceof ForgeFailure && REFUSALS.includes(error.error.code);

export function replayLease(
  { route, requestId, subject, holder }: LeaseCommand,
  outcome: unknown,
  recorded: unknown,
  read: () => LeaseRecord | undefined,
  now: number,
): LeaseRecord {
  const checkSubject = outcome !== "INPUT_INVALID" && !subject.isWellFormed();
  const current = outcome === "ok" || checkSubject ? read() : undefined;
  if (checkSubject) checkLeaseSubject(subject, "held", current);
  if (outcome !== "ok") throw new ForgeFailure(recorded as ForgeError);
  const first = recorded as LeaseRecord;
  if (checkSubject) checkLeaseSubject(subject, "held", first);
  if (route === "release") return first;
  if (
    current !== undefined &&
    decideLease(current, {
      mode: "held",
      subject,
      holder,
      generation: first.generation,
      nowMs: now,
    }).ok
  )
    return current;
  throw new ForgeFailure({
    code: "LEASE_STALE",
    message: `Request ${requestId} no longer matches the current lease on ${subject}`,
    retry: "reconcile_first",
    lease:
      current === undefined
        ? { subject }
        : {
            subject,
            holder: current.holder,
            generation: current.generation,
            expiresAt: current.expiresAt,
          },
  });
}
