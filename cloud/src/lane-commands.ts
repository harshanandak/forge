import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import ControlInput from "../../src/blocks/work/schemas/lane-control.input.json" with { type: "json" };
import ControlOutput from "../../src/blocks/work/schemas/lane-control.output.json" with { type: "json" };
import StopInput from "../../src/blocks/work/schemas/lane-stop.input.json" with { type: "json" };
import {
  readLaneControl,
  transitionLaneControl,
  type LaneControl,
  type LaneScope,
} from "../../src/blocks/work/lane-control.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { validateWithSchema } from "../../src/contract/schema.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { commandWrite, prepareReceipt } from "./command-write.ts";
import type { CommandRun, PreparedCommand } from "./issue-commands.ts";
import { checkedValue, fail } from "./issue-read.ts";
import { guardLegacy } from "./issue-request-id.ts";
import { LaneControlStore } from "./lane-control-store.ts";
import {
  checkedApproval,
  requestLaneApproval,
  type ApprovalRequired,
} from "./lane-approval.ts";
import { readOnlyStore } from "./store.ts";
import { carriesToken } from "./tokens.ts";

const NS = "forge/work";
const GLOBAL = "lane-control:global";
const GET = "SELECT body FROM state_records WHERE namespace=? AND key=?";
const control = manifest.operations["lane.control"];
const stop = manifest.operations["lane.stop"];
if (
  control.input !== "schemas/lane-control.input.json" ||
  control.output !== "schemas/lane-control.output.json" ||
  stop.input !== "schemas/lane-stop.input.json" ||
  stop.output !== "schemas/lane-stop.output.json"
)
  throw new Error("Lane control schemas changed");

function result(reply: ReturnType<LaneControlStore["read"]>): LaneControl {
  if (!reply.ok) throw new ForgeFailure(reply.error);
  return checked(reply.result);
}
function checked(value: unknown): LaneControl {
  if (validateWithSchema(ControlOutput, value).length > 0)
    throw fail("INTERNAL", "Lane control result is not valid");
  return value as LaneControl;
}

function scopeOf(owner: StateOwner | undefined, scope: LaneScope): LaneScope {
  if ("all" in scope) return scope;
  const issue = owner?.get(NS, `issue:${scope.id}`);
  if (issue === undefined) throw fail("NOT_FOUND", "Issue was not found");
  const value = checkedValue({ ...issue }, scope.id);
  return { id: value.id as string };
}

/** Reads use a SELECT-only owner. Resume writes requests only, never control. */
export function laneCommand(
  call: PreparedCommand,
  host: CommandRun,
): LaneControl | ApprovalRequired {
  const { requestId, op, input, dryRun } = call;
  const read = op === "lane.control";
  if (validateWithSchema(read ? ControlInput : StopInput, input).length > 0)
    throw fail("INPUT_INVALID", "Expected a canonical issue id or all lanes");
  const fields = input as { id?: string; all?: true };
  if (
    fields.id !== undefined &&
    validateWithSchema(ControlInput, { id: fields.id }).length > 0
  )
    throw fail("INPUT_INVALID", "Expected a canonical issue id");
  const scope: LaneScope =
    fields.id === undefined ? { all: true } : { id: fields.id };
  if (read || dryRun) {
    const db = readOnlyStore(host.storage, "state_records", [GET]);
    const owner =
      db === undefined
        ? undefined
        : new StateOwner(db, { now: () => host.now });
    if (read) {
      if (owner === undefined)
        throw fail("UNAVAILABLE", "Lane control is unavailable");
      return result(new LaneControlStore(owner, host.project).read(fields.id));
    }
    const target = scopeOf(owner, scope);
    const global = owner?.get(NS, GLOBAL);
    if (global === undefined && "id" in target)
      throw fail("UNAVAILABLE", "Lane control is unavailable");
    const transition = transitionLaneControl(
      global === undefined
        ? {
            version: 1,
            incarnation: crypto.randomUUID(),
            epoch: 0,
            resumeAllEpoch: 0,
            stopAll: null,
          }
        : global.value,
      "id" in target
        ? owner?.get(NS, `lane-control:${target.id}`)?.value
        : undefined,
      { action: "stop", scope: target },
      {
        project: host.project,
        policyIdentity: op,
        now: new Date(host.now).toISOString(),
      },
    );
    if (!transition.ok) throw new ForgeFailure(transition.error);
    const { candidate } = transition.result;
    return result(readLaneControl(candidate.global, candidate.issue, target));
  }
  if (carriesToken(requestId))
    throw fail("INPUT_INVALID", "requestId must not carry a credential");
  host.recheck();
  const identity = prepareReceipt("command", host.principal, requestId, {
    op,
    input,
    context: call.context,
    device: host.device,
    session: host.session ?? null,
  });
  const { db, owner } = host.open();
  guardLegacy(db, requestId, identity.requestId);
  if (op === "lane.resume")
    return commandWrite(
      db,
      owner,
      { identity, recheck: host.recheck, expiresAt: host.expiresAt },
      () => scope,
      (target) => requestLaneApproval(owner, scopeOf(owner, target), host),
      checkedApproval,
    );
  return commandWrite(
    db,
    owner,
    { identity, recheck: host.recheck, expiresAt: host.expiresAt },
    () => scope,
    (target) =>
      result(
        new LaneControlStore(owner, host.project).stop(
          scopeOf(owner, target),
          host.device,
          // A device-only token has no session claim; audit its server token identity instead.
          host.session ?? host.principal[1],
          new Date(host.now).toISOString(),
        ),
      ),
    checked,
  );
}
