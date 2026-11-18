import Input from "../../src/blocks/work/schemas/lane-dispatch.input.json" with { type: "json" };
import Output from "../../src/blocks/work/schemas/lane-dispatch.output.json" with { type: "json" };
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { validateWithSchema } from "../../src/contract/schema.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { commandWrite, prepareReceipt } from "./command-write.ts";
import type { CommandRun, PreparedCommand } from "./issue-commands.ts";
import { checkedValue, fail } from "./issue-read.ts";
import { guardLegacy } from "./issue-request-id.ts";
import { fence } from "./issue-update.ts";
import { LaneControlStore } from "./lane-control-store.ts";
import { carriesToken } from "./tokens.ts";

const NS = "forge/work";
const OP = "lane.dispatch";
interface Fields {
  id: string;
  dispatchId: string;
  incarnation: string;
  epoch: number;
}
type Intent = Fields & {
  holder: { device: string; session: string };
  leaseGeneration: number;
  recordedAt: string;
  kind: "recorded-intent";
};

const keyOf = ({ id, dispatchId }: Fields) =>
  `lane-dispatch:${id}:${dispatchId}`;
const changed = () =>
  fail("INPUT_CONFLICT", "Dispatch ID belongs to another intent");

function checkedIntent(value: unknown): Intent {
  if (validateWithSchema(Output, value).length > 0)
    throw fail("UNAVAILABLE", "Recorded dispatch is invalid or missing");
  return value as Intent;
}

export function dispatchLane(call: PreparedCommand, host: CommandRun): Intent {
  const { input, requestId, context, dispatchSession } = call;
  if (context.variant !== "project")
    throw fail("INTERNAL", "Lane dispatch needs project context");
  if (dispatchSession === undefined)
    throw fail("CONTEXT_MISSING", "Lane dispatch needs a session");
  if (carriesToken(requestId) || carriesToken(dispatchSession))
    throw fail(
      "INPUT_INVALID",
      "Dispatch identifiers must not carry a credential",
    );
  const { device } = host;
  const session = { id: dispatchSession, device };
  host.recheck();
  const identity = prepareReceipt("command", host.principal, requestId, {
    op: OP,
    input,
    context,
    session,
  });
  const { db, owner } = host.open();
  guardLegacy(db, requestId, identity.requestId);
  const control = new LaneControlStore(owner, host.project);
  const permit = (fields: Fields, previousGeneration?: number) => {
    const subject = `issue:${fields.id}`;
    const issue = owner.get(NS, subject);
    if (issue === undefined) throw fail("NOT_FOUND", "Issue was not found");
    const value = checkedValue({ ...issue }, fields.id);
    const current = control.read(fields.id);
    if (!current.ok) throw new ForgeFailure(current.error);
    if (current.result.stopped)
      throw fail("INPUT_CONFLICT", "Lane dispatch is stopped");
    if (
      current.result.incarnation !== fields.incarnation ||
      current.result.epoch !== fields.epoch
    )
      throw fail("INPUT_CONFLICT", "Lane control changed; read it again");
    if (value.status !== "open")
      throw fail("INPUT_CONFLICT", "Dispatch requires an open issue");
    const lease = owner.lease(NS, subject);
    const leaseGeneration = previousGeneration ?? lease?.generation ?? 1;
    const held = fence(
      {
        ...context,
        variant: "leased",
        leaseMode: "held",
        session,
        leaseGeneration,
      },
      fields.id,
      OP,
    );
    const decision = decideLease(
      lease?.holder.session.device === undefined ? undefined : lease,
      {
        ...held,
        mode: "held",
        nowMs: Date.now(),
      },
    );
    if (!decision.ok) throw new ForgeFailure(decision.error);
    return held;
  };
  const matches = (
    fields: Fields,
    intent: Intent,
    held: ReturnType<typeof fence>,
  ) => {
    if (
      intent.id !== fields.id ||
      intent.dispatchId !== fields.dispatchId ||
      intent.incarnation !== fields.incarnation ||
      intent.epoch !== fields.epoch ||
      intent.leaseGeneration !== held.generation ||
      intent.holder.device !== device ||
      intent.holder.session !== dispatchSession
    )
      throw changed();
    return intent;
  };
  const read = (fields: Fields) => owner.get(NS, keyOf(fields));
  return commandWrite(
    db,
    owner,
    { identity, recheck: host.recheck, expiresAt: host.expiresAt },
    () => {
      if (
        validateWithSchema(Input, input).length > 0 ||
        carriesToken((input as Fields).dispatchId)
      )
        throw fail(
          "INPUT_INVALID",
          "Expected a canonical issue, nonsecret dispatch ID and control incarnation and epoch",
        );
      return input as Fields;
    },
    (fields) => {
      const held = permit(fields);
      const prior = read(fields);
      if (prior !== undefined)
        return matches(fields, checkedIntent(prior.value), held);
      const intent: Intent = {
        ...fields,
        holder: { device, session: dispatchSession },
        leaseGeneration: held.generation,
        recordedAt: new Date(Date.now()).toISOString(),
        kind: "recorded-intent",
      };
      owner.put(NS, keyOf(fields), intent, context.actor, {
        expectRevision: 0,
        fence: held,
      });
      return checkedIntent(read(fields)?.value);
    },
    (prior) =>
      db.transaction(() => {
        host.recheck();
        const fields = input as Fields;
        const held = permit(fields, prior.leaseGeneration);
        const saved = matches(fields, checkedIntent(read(fields)?.value), held);
        if (canonicalJson(prior) !== canonicalJson(saved)) throw changed();
      }),
  );
}
