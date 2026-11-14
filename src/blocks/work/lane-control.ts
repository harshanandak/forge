import type {
  FailureEnvelope,
  SuccessEnvelope,
} from "../../generated/types.ts";
import { failure } from "../../surface/result.ts";

export type LaneScope = Readonly<{ id: string } | { all: true }>;
export interface LaneControlGlobal {
  readonly version: 1;
  readonly incarnation: string;
  readonly epoch: number;
  readonly resumeAllEpoch: number;
  readonly stopAll: string | null;
}
export interface LaneControlIssue {
  readonly version: 1;
  readonly incarnation: string;
  readonly id: string;
  readonly epoch: number;
  readonly stoppedAt: string | null;
}
export interface LaneControl {
  readonly incarnation: string;
  readonly epoch: number;
  readonly stopped: boolean;
  readonly scope?: "all" | "issue";
  readonly since?: string;
}
export interface LaneControlCandidate {
  readonly global: LaneControlGlobal;
  readonly issue?: LaneControlIssue;
}
type Result<T> = FailureEnvelope | (SuccessEnvelope & { readonly result: T });
const ok = <T>(result: T): Result<T> => ({
  ok: true,
  status: "OK",
  op: "lane.control",
  result,
  warnings: [],
});
const unavailable = () =>
  failure("UNAVAILABLE", "Lane control is unknown or invalid");
const invalid = () =>
  failure("INPUT_INVALID", "Invalid lane control operation or clock");
const conflict = () =>
  failure("INPUT_CONFLICT", "Lane control or authorization binding changed");

// Read only own data descriptors: malformed input must not invoke a getter.
function data(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (!required.every((key) => Object.hasOwn(descriptors, key))) return;
    if (
      keys.some(
        (key) =>
          typeof key !== "string" || ![...required, ...optional].includes(key),
      )
    )
      return;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of required.concat(optional)) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (!("value" in descriptor) || !descriptor.enumerable) return;
      Object.defineProperty(result, key, {
        value: descriptor.value as unknown,
        enumerable: true,
      });
    }
    return result;
  } catch {
    return;
  }
}
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !/[\p{Cc}]/u.test(value);
const epoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  new Date(value).toJSON() ===
    (value.length === 20 ? value.replace("Z", ".000Z") : value);
const nullableTime = (value: unknown) => value === null || time(value);
function scopeOf(
  value: unknown,
  read = false,
): LaneScope | Record<string, never> | undefined {
  const scope = data(value, [], ["id", "all"]);
  if (!scope) return;
  if (Object.keys(scope).length === 0) return read ? {} : undefined;
  if (Object.keys(scope).length !== 1) return;
  if (text(scope.id)) return { id: scope.id };
  if (scope.all === true) return { all: true };
  return;
}
function globalOf(value: unknown): LaneControlGlobal | undefined {
  const g = data(value, [
    "version",
    "incarnation",
    "epoch",
    "resumeAllEpoch",
    "stopAll",
  ]);
  if (
    !g ||
    g.version !== 1 ||
    !text(g.incarnation) ||
    !epoch(g.epoch) ||
    !epoch(g.resumeAllEpoch) ||
    g.resumeAllEpoch > g.epoch ||
    !nullableTime(g.stopAll) ||
    (g.stopAll !== null && g.resumeAllEpoch === g.epoch)
  )
    return;
  return g as unknown as LaneControlGlobal;
}
function issueOf(
  value: unknown,
  global: LaneControlGlobal,
): LaneControlIssue | undefined {
  const i = data(value, ["version", "incarnation", "id", "epoch", "stoppedAt"]);
  if (
    !i ||
    i.version !== 1 ||
    i.incarnation !== global.incarnation ||
    !text(i.id) ||
    !epoch(i.epoch) ||
    i.epoch === 0 ||
    i.epoch > global.epoch ||
    !nullableTime(i.stoppedAt)
  )
    return;
  return i as unknown as LaneControlIssue;
}
function stateOf(
  global: unknown,
  issue: unknown,
  scope: LaneScope | Record<string, never>,
) {
  const g = globalOf(global);
  if (!g) return;
  const i = issue == null ? undefined : issueOf(issue, g);
  if (issue != null && (!i || ("id" in scope && i.id !== scope.id))) return;
  return { global: g, issue: i };
}
function effective(
  global: LaneControlGlobal,
  issue?: LaneControlIssue,
): LaneControl {
  const base = { incarnation: global.incarnation, epoch: global.epoch };
  if (global.stopAll !== null)
    return { ...base, stopped: true, scope: "all", since: global.stopAll };
  if (issue?.stoppedAt != null && issue.epoch > global.resumeAllEpoch)
    return { ...base, stopped: true, scope: "issue", since: issue.stoppedAt };
  return { ...base, stopped: false };
}

export function readLaneControl(
  global: unknown,
  issue: unknown,
  scope: unknown = {},
): Result<LaneControl> {
  const target = scopeOf(scope, true);
  if (!target) return invalid();
  const state = stateOf(global, issue, target);
  if (!state) return unavailable();
  return ok(effective(state.global, "id" in target ? state.issue : undefined));
}

// Authorization is a server-verified fact, never a device-supplied proof.
// Callers own authentication, replay, consumption and atomic storage fences.
export function transitionLaneControl(
  global: unknown,
  issue: unknown,
  command: unknown,
  context: unknown,
  authorization?: unknown,
): Result<{ readonly candidate: LaneControlCandidate }> {
  const c = data(command, ["action", "scope"]);
  const target = scopeOf(c?.scope);
  const ctx = data(context, ["project", "policyIdentity", "now"]);
  if (
    !c ||
    (c.action !== "stop" && c.action !== "resume") ||
    !target ||
    !ctx ||
    !text(ctx.project) ||
    !text(ctx.policyIdentity) ||
    !time(ctx.now)
  )
    return invalid();
  const state = stateOf(global, issue, target);
  if (!state || state.global.epoch === Number.MAX_SAFE_INTEGER)
    return unavailable();
  const g = state.global;
  if (c.action === "resume") {
    if ("id" in target && g.stopAll !== null) return conflict();
    const a = data(authorization, [
      "status",
      "project",
      "policyIdentity",
      "scope",
      "incarnation",
      "epoch",
      "expiresAt",
    ]);
    if (
      !a ||
      a.status !== "verified" ||
      !time(a.expiresAt) ||
      Date.parse(a.expiresAt) <= Date.parse(ctx.now)
    )
      return failure(
        "APPROVAL_REQUIRED",
        "Fresh verified owner authorization is required",
      );
    const authorizedScope = scopeOf(a.scope);
    if (
      !authorizedScope ||
      a.project !== ctx.project ||
      a.policyIdentity !== ctx.policyIdentity ||
      a.incarnation !== g.incarnation ||
      a.epoch !== g.epoch ||
      ("id" in target
        ? !("id" in authorizedScope) || authorizedScope.id !== target.id
        : !("all" in authorizedScope))
    )
      return conflict();
  }
  const next = g.epoch + 1;
  if ("id" in target)
    return ok({
      candidate: {
        global: { ...g, epoch: next },
        issue: {
          version: 1,
          incarnation: g.incarnation,
          id: target.id,
          epoch: next,
          stoppedAt: c.action === "stop" ? ctx.now : null,
        },
      },
    });
  return ok({
    candidate: {
      global: {
        ...g,
        epoch: next,
        stopAll: c.action === "stop" ? ctx.now : null,
        resumeAllEpoch: c.action === "resume" ? next : g.resumeAllEpoch,
      },
    },
  });
}

function controlOf(value: unknown): LaneControl | undefined {
  const c = data(
    value,
    ["incarnation", "epoch", "stopped"],
    ["scope", "since"],
  );
  if (!c || !text(c.incarnation) || !epoch(c.epoch)) return;
  if (
    c.stopped === true
      ? (c.scope !== "all" && c.scope !== "issue") || !time(c.since)
      : c.stopped !== false ||
        Object.hasOwn(c, "scope") ||
        Object.hasOwn(c, "since")
  )
    return;
  return c as unknown as LaneControl;
}
const monotonic = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export function checkLaneObservation(
  observation: unknown,
  expected: unknown,
  now: unknown,
): Result<LaneControl> {
  const o = data(observation, ["id", "requestedAt", "control"]);
  const e = data(expected, ["id", "incarnation", "epoch"]);
  const control = controlOf(o?.control);
  if (
    !o ||
    !e ||
    !control ||
    !text(e.id) ||
    o.id !== e.id ||
    control.incarnation !== e.incarnation ||
    control.epoch !== e.epoch ||
    !monotonic(now) ||
    !monotonic(o.requestedAt) ||
    now < o.requestedAt ||
    now - o.requestedAt >= 20_000
  )
    return unavailable();
  return ok({ ...control });
}
