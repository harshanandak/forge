import Memory from "../../src/blocks/memory/schemas/defs.json" with { type: "json" };
import Output from "../../src/blocks/work/schemas/lane-resume.output.json" with { type: "json" };
import type {
  LaneControl,
  LaneScope,
} from "../../src/blocks/work/lane-control.ts";
import { validateWithSchema } from "../../src/contract/schema.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { CommandRun } from "./issue-commands.ts";
import { fail } from "./issue-read.ts";
import { LaneControlStore } from "./lane-control-store.ts";
import { carriesToken } from "./tokens.ts";

const NS = "forge/work";
export const LANE_APPROVALS = "domain_cloud_lane_approvals";
export const LANE_APPROVAL_MIGRATION = {
  id: "007_cloud_lane_approvals",
  statements: [
    `CREATE TABLE ${LANE_APPROVALS} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`,
  ],
};
export const LANE_BROWSER = "domain_cloud_lane_browser";
export const LANE_BROWSER_MIGRATION = {
  id: "009_cloud_lane_browser",
  statements: [
    `CREATE TABLE ${LANE_BROWSER} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`,
  ],
};
export const CLEAR_LANE_BROWSER_MIGRATION = {
  id: "013_cloud_clear_lane_browser",
  statements: [`DELETE FROM ${LANE_BROWSER}`],
};
export interface ApprovalRequired {
  readonly request: string;
  readonly scope: LaneScope;
  readonly expiresAt: string;
}
type Relay = {
  request: string;
  quote: string;
  source: { harness: string; thread: string; message?: string; link?: string };
};
type Decision = Omit<Relay, "request"> & { method: "relayed"; at: string };
export interface LaneApproval extends ApprovalRequired {
  readonly binding?: string;
  readonly project: string;
  readonly incarnation: string;
  readonly epoch: number;
  readonly policyIdentity: string;
  readonly device: string;
  readonly session: string | null;
  readonly token: string;
  readonly status:
    "pending" | "approved" | "denied" | "expired" | "stale" | "spent";
  readonly decision?:
    Decision | { issuer: string; subject: string; at: string };
}

/** Pure read: an old request never becomes current again after expiry or a new stop. */
export function laneApprovalStatus(
  row: LaneApproval,
  control: LaneControl,
  now: number,
): LaneApproval["status"] {
  if (row.status !== "pending" && row.status !== "approved") return row.status;
  if (!(Date.parse(row.expiresAt) > now)) return "expired";
  return row.incarnation !== control.incarnation || row.epoch !== control.epoch
    ? "stale"
    : row.status;
}

export function checkedRelay(value: unknown): Relay {
  const relay = value as Relay;
  if (
    validateWithSchema(Memory.$defs.RelayedApproval, value).length > 0 ||
    [relay.request, relay.quote, ...Object.values(relay.source)].some(
      (text) => !text.trim() || carriesToken(text),
    )
  )
    throw fail(
      "INPUT_INVALID",
      "Relay the owner's verbatim reply and its source",
    );
  return relay;
}

const freshRequest = () =>
  fail(
    "APPROVAL_REQUIRED",
    "Run lane resume without an approval to get a new request",
  );

function bindingFields(host: CommandRun, control: LaneControl) {
  const config = host.approvalConfig ?? {};
  return {
    project: host.project,
    token: host.principal[1],
    device: host.device,
    session: host.session ?? null,
    policyIdentity: digestValue([
      config.CLERK_ISSUER,
      config.FORGE_OWNER_SUBJECT,
      config.CLERK_CLIENT_ID,
    ]),
    incarnation: control.incarnation,
    epoch: control.epoch,
  };
}

const bindingOf = (
  fields: ApprovalRequired & ReturnType<typeof bindingFields>,
) => digestValue([1, "lane.resume", fields]);

function matchingApproval(
  db: SqlDatabase,
  owner: StateOwner,
  request: string,
  scope: LaneScope,
  host: CommandRun,
  replay = false,
) {
  const held = db.get(`SELECT state FROM ${LANE_APPROVALS} WHERE id=1`);
  const requests =
    held === undefined
      ? []
      : (JSON.parse(String(held.state)) as { requests: LaneApproval[] })
          .requests;
  const row = requests.find((entry) => entry.request === request);
  if (
    !row?.binding ||
    row.status !== "pending" ||
    row.decision !== undefined ||
    !(Date.parse(row.expiresAt) > host.now)
  )
    throw freshRequest();
  if (row.project === host.project && row.token !== host.principal[1])
    throw freshRequest();
  const control = new LaneControlStore(owner, host.project).read();
  const { binding, status: _status, decision: _decision, ...stored } = row;
  if (
    !control.ok ||
    binding !== bindingOf(stored) ||
    binding !==
      bindingOf({ ...stored, scope, ...bindingFields(host, control.result) })
  )
    throw replay
      ? freshRequest()
      : fail("INPUT_CONFLICT", "Lane approval binding changed");
  return { requests, row };
}

export function checkApprovalReplay(
  db: SqlDatabase,
  owner: StateOwner,
  prior: ApprovalRequired,
  scope: LaneScope,
  host: CommandRun,
): void {
  if (validateWithSchema(Output.$defs.ApprovalRequired, prior).length > 0)
    throw freshRequest();
  const { row } = matchingApproval(db, owner, prior.request, scope, host, true);
  if (
    row.expiresAt !== prior.expiresAt ||
    digestValue(row.scope) !== digestValue(prior.scope)
  )
    throw freshRequest();
}

export function consumeLaneApproval(
  db: SqlDatabase,
  owner: StateOwner,
  relay: Relay,
  scope: LaneScope,
  host: CommandRun,
): LaneApproval {
  const { request, quote, source } = relay;
  const { requests, row } = matchingApproval(db, owner, request, scope, host);
  const decision: Decision = {
    method: "relayed",
    quote,
    source,
    at: new Date(host.now).toISOString(),
  };
  db.run(`UPDATE ${LANE_APPROVALS} SET state=? WHERE id=1`, [
    JSON.stringify({
      requests: requests.map((entry) =>
        entry === row ? { ...row, status: "spent", decision } : entry,
      ),
    }),
  ]);
  return row;
}

/** Runs only inside commandWrite's synchronous transaction, together with its receipt. */
export function requestLaneApproval(
  db: SqlDatabase,
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
  const held = db.get(`SELECT state FROM ${LANE_APPROVALS} WHERE id=1`);
  const prior =
    held === undefined
      ? undefined
      : (JSON.parse(String(held.state)) as { requests: LaneApproval[] });
  if (
    prior !== undefined &&
    (!Array.isArray(prior.requests) || prior.requests.length > 128)
  )
    throw fail("UNAVAILABLE", "Lane approval storage is unavailable");
  const fields = bindingFields(host, control.result);
  const rows = (prior?.requests ?? []).map((row) => ({
    ...row,
    status:
      row.status === "pending" &&
      (row.policyIdentity !== fields.policyIdentity ||
        row.project !== host.project)
        ? ("stale" as const)
        : laneApprovalStatus(row, control.result, host.now),
  }));
  const live = rows.filter((row) => row.status === "pending");
  if (
    live.length >= 64 ||
    live.filter((row) => row.device === host.device).length >= 4
  )
    throw fail("UNAVAILABLE", "Lane approval pending request limit reached");
  const pending: ApprovalRequired = {
    request: crypto.randomUUID(),
    scope,
    expiresAt: new Date(host.now + 600_000).toISOString(),
  };
  const row = { ...pending, ...fields };
  // Like loginStore, replace private state without copying trimmed requests into events.
  db.run(
    `INSERT INTO ${LANE_APPROVALS} (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state`,
    [
      JSON.stringify({
        requests: [
          ...rows.filter((row) => row.status !== "pending").slice(-64),
          ...live,
          { ...row, binding: bindingOf(row), status: "pending" },
        ],
      }),
    ],
  );
  return pending;
}
