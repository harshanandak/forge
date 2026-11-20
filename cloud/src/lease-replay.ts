import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
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
  readonly fingerprint: string;
  readonly scope: ReceiptScope;
}

export const requestConflict = (): ForgeFailure =>
  new ForgeFailure({
    code: "INPUT_CONFLICT",
    message: "Request ID belongs to a different input",
    retry: "reconcile_first",
  });

export const recordable = (error: unknown): error is ForgeFailure =>
  error instanceof ForgeFailure &&
  (error.error.code.startsWith("LEASE_") ||
    error.error.code === "INPUT_INVALID");

export function replayLease(
  { route, requestId, subject, holder }: LeaseCommand,
  outcome: unknown,
  recorded: unknown,
  read: () => LeaseRecord | undefined,
  now: number,
): LeaseRecord {
  if (outcome !== "ok") throw new ForgeFailure(recorded as ForgeError);
  const first = recorded as LeaseRecord;
  if (route === "release") return first;
  const current = read();
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
