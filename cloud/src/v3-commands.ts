import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { isObject } from "../../src/core/config/pointer.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { prepareReceipt } from "./command-write.ts";
import * as api from "./issue-commands.ts";
import { checked } from "./issue-create.ts";
import { configured, shownId, shownItem, storedId } from "./issue-read.ts";
import { expiredReplay, RETENTION_MS } from "./issue-receipts.ts";
import { receiptScope } from "./issue-request-id.ts";
import { checkedUpdateInput, fence } from "./issue-update.ts";
import { requestConflict } from "./lease-command.ts";
import { carriesToken } from "./tokens.ts";
import { UPDATE_REFUSALS } from "./v3-authority.ts";
import * as store from "./v3-store.ts";

type CommandOptions = { prefix: string; expiresAt: number; now: number };
type Host = api.CommandHost & CommandOptions;
type Call = Host & {
  db: SqlDatabase;
  image: store.V3Image;
  call: api.PreparedCommand;
};
type Effect = Pick<store.Frame, "changes" | "events" | "lease" | "witness"> & {
  result: unknown;
};
interface Command {
  write(state: Call): Effect;
  replay?(state: Call, result: unknown): void;
  refusalCodes?: readonly string[];
}

function updateLease(state: Call, id: string, replay = false) {
  const { db, image, call, now } = state;
  const held = fence(call.context, id, call.op);
  const lease = store.readV3Value(db, image, "lease", held.subject);
  const decision = decideLease(lease, { ...held, mode: "held", nowMs: now });
  if (decision.ok) return lease;
  if (!replay) throw new ForgeFailure(decision.error);
  throw new ForgeFailure({
    ...decision.error,
    code: "LEASE_STALE",
    message: `Request no longer matches the current lease on ${held.subject}`,
  });
}

const commands: Readonly<Record<string, Command>> = {
  "issue.create": {
    write({ image, call, prefix, now }) {
      const number = image.recordFloor + 1;
      const id = `work-${number}`;
      const key = `r${number}`;
      const revision = 1;
      const updatedAt = new Date(now).toISOString();
      const item = {
        status: "open",
        labels: [],
        dependsOn: [],
        createdAt: updatedAt,
        ...checked(call.input),
      };
      const value = { ...item, id, prefix };
      return {
        events: [{ key, revision, value }],
        changes: [{ key, value: { revision, value } }],
        result: { ...item, id: shownId(id, prefix), revision, updatedAt },
      };
    },
  },
  "issue.update": {
    refusalCodes: UPDATE_REFUSALS,
    write(state) {
      const { db, image, call, now, prefix } = state;
      const {
        id: given,
        expectRevision,
        ...patch
      } = checkedUpdateInput(call.input);
      const read = (key: string) => store.readV3Value(db, image, "record", key);
      const id = storedId(given, prefix, (alias) =>
        [...image.entries.record.keys()].some((key) => {
          const value = read(key);
          return (
            isObject(value) &&
            value.id === `work-${key.slice(1)}` &&
            (value.prefix ?? "work") === alias
          );
        }),
      );
      const key = `r${id.slice(5)}`;
      const current = read(key);
      const prior = image.entries.record.get(key)?.revision;
      if (current === undefined || prior === undefined)
        throw store.fail("NOT_FOUND", "Issue was not found");
      if (!isObject(current)) throw store.fail("INTERNAL", "Invalid issue");
      const lease = updateLease(state, id);
      if (prior !== expectRevision)
        throw new ForgeFailure({
          code: "REVISION_CONFLICT",
          message: `Expected revision ${expectRevision}; current revision is ${prior}`,
          retry: "reconcile_first",
          currentRevision: prior,
        });
      const value = { ...current, ...patch };
      const revision = prior + 1;
      const record = {
        namespace: "forge/work",
        key: `issue:${id}`,
        value,
        revision,
        updatedAt: new Date(now).toISOString(),
      };
      return {
        events: [{ key, revision, expectRevision, patch }],
        changes: [{ key, value: { revision, value } }],
        result: shownItem(record, id, { ...lease }, now, prefix),
      };
    },
    replay(state) {
      const { id } = checkedUpdateInput(state.call.input);
      updateLease(state, `work-${id.replace(/^.*-/, "")}`, true);
    },
  },
};

export function commandV3(
  db: SqlDatabase,
  image: store.V3Image,
  text: string,
  host: Host,
) {
  const call = api.parseCommand(text, host);
  const { op, requestId, input, context } = call;
  const { device, now, expiresAt, prefix } = host;
  const command = Object.hasOwn(commands, op) ? commands[op] : undefined;
  if (!command) throw store.fail("UNKNOWN_COMMAND", "No such v3 command");
  if (carriesToken(requestId))
    throw store.fail("INPUT_INVALID", "requestId must not carry a credential");
  configured(prefix);
  const state = { ...host, db, image, call };
  const respond = (result: unknown) =>
    Response.json({ ok: true, op, status: "OK", result, warnings: [] });
  const principal = ["owner", device, device] as const;
  const { requestId: id, fingerprint } = prepareReceipt(
    "command",
    principal,
    requestId,
    { op, input, context, device },
  );
  const prior = store.readV3Value(db, image, "outcome", id);
  if (prior && now < prior.outcome.retryUntil) {
    const { result, status } = prior.outcome;
    if (now >= prior.time + RETENTION_MS) expiredReplay(status !== "ok");
    if (prior.outcome.fingerprint !== fingerprint) throw requestConflict();
    if (status !== "ok") throw new ForgeFailure(result as ForgeError);
    command.replay?.(state, result);
    return respond(result);
  }
  let effect: Effect;
  let refusal: ForgeFailure | undefined;
  try {
    effect = command.write(state);
  } catch (error) {
    if (!(error instanceof ForgeFailure)) throw error;
    const codes = command.refusalCodes ?? ["INPUT_INVALID"];
    if (!codes.includes(error.error.code)) throw error;
    refusal = error;
    effect = { events: [], result: error.error };
  }
  const { result, ...changes } = effect;
  const scope = { family: "command", ...receiptScope(principal) };
  const outcome = {
    id,
    fingerprint,
    scope,
    status: refusal?.error.code ?? "ok",
    result,
    retryUntil: expiresAt,
  };
  store.append(db, image, [{ operation: op, time: now, ...changes, outcome }]);
  store.publishV3(image);
  if (refusal) throw refusal;
  return respond(result);
}
