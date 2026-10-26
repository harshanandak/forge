// Lease semantics as one pure decision. The state owner runs it inside the write's own transaction,
// with its injected clock, so a superseded holder can never write after a reacquisition.
import type {
  ForgeError,
  LeaseHolder,
  LeaseMode,
  LeaseRecord,
} from "../generated/types.ts";

export interface LeaseRequest {
  readonly mode: LeaseMode;
  readonly subject: string;
  readonly holder: LeaseHolder;
  /** Required for `held`; ignored for `acquire`, which never supplies one. */
  readonly generation?: number;
  /** The state owner's clock, in milliseconds since the epoch. */
  readonly nowMs: number;
}

export type LeaseDecision =
  | {
      readonly ok: true;
      readonly kind: "acquired";
      readonly generation: number;
      /** Present when an expired lease was taken over; the owner records a reacquired event. */
      readonly reacquired?: {
        readonly previousHolder: LeaseHolder;
        readonly previousGeneration: number;
      };
    }
  | { readonly ok: true; readonly kind: "held"; readonly generation: number }
  | { readonly ok: false; readonly error: ForgeError };

function sameHolder(a: LeaseHolder, b: LeaseHolder): boolean {
  return (
    a.session.id === b.session.id &&
    (a.session.device !== undefined || b.session.device !== undefined
      ? a.session.device === b.session.device
      : a.actor.kind === b.actor.kind && a.actor.id === b.actor.id)
  );
}

function holderDescription(holder: LeaseHolder): string {
  const { actor, session } = holder;
  return `device ${session.device ?? "unspecified"}, agent ${session.agent ?? actor.id}, harness ${session.harness ?? "unspecified"}, session ${session.id}`;
}

function isLive(lease: LeaseRecord, nowMs: number): boolean {
  return lease.releasedAt === undefined && Date.parse(lease.expiresAt) > nowMs;
}

function conflict(
  code: "LEASE_HELD" | "LEASE_STALE" | "LEASE_NOT_HELD" | "LEASE_EXPIRED",
  subject: string,
  lease: LeaseRecord | undefined,
  message: string,
): LeaseDecision {
  return {
    ok: false,
    error: {
      code,
      message,
      retry: "reconcile_first",
      lease:
        lease === undefined
          ? { subject }
          : {
              subject,
              holder: lease.holder,
              generation: lease.generation,
              expiresAt: lease.expiresAt,
            },
    },
  };
}

export function decideLease(
  current: LeaseRecord | undefined,
  request: LeaseRequest,
): LeaseDecision {
  const { subject, nowMs } = request;
  if (request.mode === "acquire") {
    if (current === undefined)
      return { ok: true, kind: "acquired", generation: 1 };
    if (isLive(current, nowMs)) {
      return conflict(
        "LEASE_HELD",
        subject,
        current,
        `${subject} is leased by ${holderDescription(current.holder)} until ${current.expiresAt}; read its state to reconcile instead of retrying`,
      );
    }
    const generation = current.generation + 1;
    return current.releasedAt === undefined
      ? {
          ok: true,
          kind: "acquired",
          generation,
          reacquired: {
            previousHolder: current.holder,
            previousGeneration: current.generation,
          },
        }
      : { ok: true, kind: "acquired", generation };
  }

  if (request.generation === undefined) {
    return {
      ok: false,
      error: {
        code: "CONTEXT_MISSING",
        message: "this held operation needs leaseGeneration",
        missing: ["leaseGeneration"],
        retry: "safe",
      },
    };
  }
  if (current === undefined) {
    return conflict(
      "LEASE_NOT_HELD",
      subject,
      undefined,
      `${subject} has no lease`,
    );
  }
  if (request.generation !== current.generation) {
    return conflict(
      "LEASE_STALE",
      subject,
      current,
      `generation ${request.generation} is not the current generation ${current.generation} of ${subject}`,
    );
  }
  if (
    current.releasedAt !== undefined ||
    !sameHolder(current.holder, request.holder)
  ) {
    return conflict(
      "LEASE_NOT_HELD",
      subject,
      current,
      `${subject} is not leased by this actor and session`,
    );
  }
  if (Date.parse(current.expiresAt) <= nowMs) {
    return conflict(
      "LEASE_EXPIRED",
      subject,
      current,
      `the lease on ${subject} expired at ${current.expiresAt}; a lapsed lease is reacquired, never renewed`,
    );
  }
  return { ok: true, kind: "held", generation: current.generation };
}
