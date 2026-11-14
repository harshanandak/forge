import Output from "../../src/blocks/work/schemas/lane-resume.output.json" with { type: "json" };
import type {
  LaneControl,
  LaneScope,
} from "../../src/blocks/work/lane-control.ts";
import { validateWithSchema } from "../../src/contract/schema.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { CommandRun } from "./issue-commands.ts";
import { fail } from "./issue-read.ts";
import { LaneControlStore } from "./lane-control-store.ts";

const NS = "forge/work";
const KEY = "lane-approval:requests";
export interface ApprovalRequired {
  readonly request: string;
  readonly scope: LaneScope;
  readonly expiresAt: string;
  readonly url: string;
}
export interface LaneApproval extends ApprovalRequired {
  readonly project: string;
  readonly incarnation: string;
  readonly epoch: number;
  readonly policyIdentity: string;
  readonly device: string;
  readonly session: string | null;
  readonly token: string;
  readonly status: "pending" | "expired" | "stale" | "spent";
}

/** Pure read: an old request never becomes current again after expiry or a new stop. */
export function laneApprovalStatus(
  row: LaneApproval,
  control: LaneControl,
  now: number,
): LaneApproval["status"] {
  if (row.status !== "pending") return row.status;
  if (!(Date.parse(row.expiresAt) > now)) return "expired";
  return row.incarnation !== control.incarnation || row.epoch !== control.epoch
    ? "stale"
    : "pending";
}

export function checkedApproval(value: unknown): ApprovalRequired {
  if (validateWithSchema(Output.$defs.ApprovalRequired, value).length > 0)
    throw fail("INTERNAL", "Lane approval result is not valid");
  return value as ApprovalRequired;
}

/** Runs only inside commandWrite's synchronous transaction, together with its receipt. */
export function requestLaneApproval(
  owner: StateOwner,
  scope: LaneScope,
  host: CommandRun,
): ApprovalRequired {
  const control = new LaneControlStore(owner, host.project).read(
    "id" in scope ? scope.id : undefined,
  );
  if (!control.ok) throw fail(control.error.code, control.error.message);
  let stopped = control.result.stopped;
  // Resume-all also covers individual stops while the global flag is clear.
  if (!stopped && "all" in scope) {
    let from = "lane-control:work-";
    for (;;) {
      const page = owner.listRange(NS, {
        from,
        to: "lane-control:work.",
        limit: 1000,
      });
      if (
        page.some((row) => {
          const read = new LaneControlStore(owner, host.project).read(
            row.key.slice("lane-control:".length),
          );
          if (!read.ok) throw fail(read.error.code, read.error.message);
          return read.result.stopped;
        })
      ) {
        stopped = true;
        break;
      }
      if (page.length < 1000) break;
      from = page.at(-1)!.key + "\0";
    }
  }
  if (!stopped || ("id" in scope && control.result.scope === "all"))
    throw fail(
      "INPUT_CONFLICT",
      "The requested scope is not independently stopped",
    );
  const config = host.approvalConfig ?? {};
  const policy = [
    config.CLERK_ISSUER,
    config.FORGE_OWNER_SUBJECT,
    config.CLERK_CLIENT_ID,
  ];
  if (policy.some((part) => typeof part !== "string" || part.length === 0))
    throw fail(
      "AUTH_CONFIG_UNAVAILABLE",
      "Lane approval owner policy is unavailable",
    );
  let origin: string;
  try {
    const callback = new URL(String(config.CLERK_REDIRECT_URI));
    if (
      callback.protocol !== "https:" ||
      callback.pathname !== "/callback" ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash
    )
      throw new Error();
    origin = callback.origin;
  } catch {
    throw fail(
      "AUTH_CONFIG_UNAVAILABLE",
      "Lane approval origin is unavailable",
    );
  }
  const held = owner.get(NS, KEY);
  const prior = held?.value as { requests: LaneApproval[] } | undefined;
  if (
    prior !== undefined &&
    (!Array.isArray(prior.requests) || prior.requests.length > 128)
  )
    throw fail("UNAVAILABLE", "Lane approval storage is unavailable");
  const policyIdentity = digestValue(policy);
  const rows = (prior?.requests ?? []).map((row) => ({
    ...row,
    status:
      row.policyIdentity !== policyIdentity || row.project !== host.project
        ? ("stale" as const)
        : laneApprovalStatus(row, control.result, host.now),
  }));
  const live = rows.filter((row) => row.status === "pending");
  if (
    live.length >= 64 ||
    live.filter((row) => row.device === host.device).length >= 4
  )
    throw fail("UNAVAILABLE", "Lane approval pending request limit reached");
  const request = crypto.randomUUID();
  const pending = checkedApproval({
    request,
    scope,
    expiresAt: new Date(host.now + 600_000).toISOString(),
    url: `${origin}/lane-approval/${request}`,
  });
  // Like device login, keep a bounded collection; retain at most 64 terminal audit rows.
  owner.put(
    NS,
    KEY,
    {
      requests: [
        ...rows.filter((row) => row.status !== "pending").slice(-64),
        ...live,
        {
          ...pending,
          project: host.project,
          incarnation: control.result.incarnation,
          epoch: control.result.epoch,
          policyIdentity,
          device: host.device,
          session: host.session ?? null,
          token: host.principal[1],
          status: "pending",
        },
      ],
    },
    { kind: "agent", id: host.session ?? host.principal[1] },
    { expectRevision: held?.revision ?? 0 },
  );
  return pending;
}
