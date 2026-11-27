import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import type { ForgeError, LeaseGrant } from "../../src/generated/types.ts";
import {
  validateClaimInput,
  validateLeaseHolder,
} from "../../src/generated/validators.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { prepareReceipt } from "./command-write.ts";
import * as api from "./issue-commands.ts";
import { checked } from "./issue-create.ts";
import { DEFAULT_TTL_SECONDS, holderOf } from "./issue-claim.ts";
import { configured, shownId, storedId } from "./issue-read.ts";
import { expiredReplay, RETENTION_MS } from "./issue-receipts.ts";
import { receiptScope, type ReceiptPrincipal } from "./issue-request-id.ts";
import { checkedUpdateInput, fence } from "./issue-update.ts";
import { checkFileDeclarationBudget } from "./issue-write.ts";
import { NAMESPACE, requestConflict } from "./lease-command.ts";
import { carriesToken } from "./tokens.ts";
import {
  CLAIM_REFUSALS,
  isPromoteResult,
  UPDATE_REFUSALS,
} from "./v3-authority.ts";
import { updateEffect } from "./v3-record-transitions.ts";
import {
  CLAIM_INVALID,
  claimDecision,
  CommandRefusal,
  updateDecision,
} from "./v3-refusals.ts";
import type { Seal } from "./v3-seal.ts";
import * as store from "./v3-store.ts";

type CommandOptions = {
  prefix: string;
  expiresAt: number;
  now: number;
  principal: ReceiptPrincipal;
};
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
      checkFileDeclarationBudget(value);
      return {
        events: [{ key, revision, value }],
        changes: [{ key, value: { revision, value } }],
        result: { ...item, id: shownId(id, prefix), revision, updatedAt },
      };
    },
  },
  "issue.claim": {
    refusalCodes: CLAIM_REFUSALS,
    write({ image, call, device, principal, prefix, now, expiresAt }) {
      const { op, requestId, input, context } = call;
      const checked = validateClaimInput(input);
      if (!checked.ok) throw store.fail("INPUT_INVALID", CLAIM_INVALID);
      const { id: given, ttlSeconds = DEFAULT_TTL_SECONDS } = checked.value;
      storedId(given, prefix, () => true);
      const identity = prepareReceipt("command", principal, requestId, {
        op,
        input,
        context,
        device,
      });
      const basis = {
        stage: "state",
        id: given,
        prefix,
        holder: holderOf(context),
        ttlMs: ttlSeconds * 1000,
      } as const;
      const decided = claimDecision(
        image,
        basis,
        now,
        expiresAt,
        image.entries.witness.has(identity.requestId),
        store.claimEffect,
      );
      if ("refusal" in decided)
        throw decided.recorded
          ? new CommandRefusal(decided.refusal, basis)
          : new ForgeFailure(decided.refusal);
      const { effect } = decided;
      const { subject } = effect.events[0]!;
      return {
        ...effect,
        witness: {
          namespace: NAMESPACE,
          id: identity.requestId,
          subject,
          generation: effect.lease.generation,
          digest: digestBytes(identity.fingerprint),
        },
      };
    },
    replay({ image, call, now }, result) {
      const { id, generation } = result as LeaseGrant;
      const subject = `issue:work-${id.replace(/^.*-/, "")}`;
      const lease = image.load("lease", subject) as store.Frame["lease"];
      const decision = decideLease(lease, {
        subject,
        generation,
        holder: holderOf(call.context),
        mode: "held",
        nowMs: now,
      });
      if (!decision.ok)
        throw new ForgeFailure({
          ...decision.error,
          code: "LEASE_STALE",
          message: `Request no longer matches the current lease on ${subject}`,
        });
    },
  },
  "issue.update": {
    refusalCodes: UPDATE_REFUSALS,
    write(state) {
      const { image, call, now, prefix } = state;
      const {
        id: given,
        expectRevision,
        ...patch
      } = checkedUpdateInput(call.input);
      const { holder, generation } = fence(
        call.context,
        storedId(given, prefix, () => true),
        call.op,
      );
      const basis = {
        stage: "state",
        id: given,
        prefix,
        expectRevision,
        holder,
        generation,
      } as const;
      const decided = updateDecision(image, basis, now);
      if ("refusal" in decided)
        throw new CommandRefusal(decided.refusal, basis);
      const { key, current, lease } = decided;
      checkFileDeclarationBudget({ ...current, ...patch });
      return updateEffect(
        { key, prefix, expectRevision, patch },
        current,
        now,
        lease,
      );
    },
    replay(state) {
      const { id } = checkedUpdateInput(state.call.input);
      updateLease(state, `work-${id.replace(/^.*-/, "")}`, true);
    },
  },
};

export function commandV3(
  db: SqlDatabase,
  seal: Seal,
  image: store.V3Image,
  text: string,
  host: Host,
) {
  const call = api.parseCommand(text, host);
  if (call.context.variant === "leased") {
    const { actor, session } = call.context;
    if (!validateLeaseHolder({ actor, session }).ok)
      throw store.fail(
        "AUTH_FORBIDDEN",
        "This caller cannot hold a lease: its device or owner label is empty or too long",
      );
  }
  const { op, requestId, input, context } = call;
  const { device, now, expiresAt, prefix, principal } = host;
  const command = Object.hasOwn(commands, op) ? commands[op] : undefined;
  if (!command) throw store.fail("UNKNOWN_COMMAND", "No such v3 command");
  if (carriesToken(requestId))
    throw store.fail("INPUT_INVALID", "requestId must not carry a credential");
  configured(prefix);
  const state = { ...host, db, image, call };
  const settled = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
  const respond = (value: unknown) => {
    const result = settled(value);
    return Response.json({ ok: true, op, status: "OK", result, warnings: [] });
  };
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
    if (status !== "ok") throw new ForgeFailure(settled(result as ForgeError));
    if (isPromoteResult(result)) throw requestConflict();
    command.replay?.(state, result);
    return respond(result);
  }
  let effect: Effect;
  let refusal: CommandRefusal | undefined;
  try {
    effect = command.write(state);
  } catch (error) {
    if (!(error instanceof ForgeFailure)) throw error;
    const codes = command.refusalCodes ?? ["INPUT_INVALID"];
    if (!codes.includes(error.error.code)) throw error;
    refusal =
      error instanceof CommandRefusal
        ? error
        : new CommandRefusal(error.error, { stage: "input" });
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
  store.append(db, seal, image, [
    {
      operation: op,
      time: now,
      ...changes,
      outcome,
      ...(refusal && { basis: refusal.basis }),
    },
  ]);
  store.publishV3(image);
  if (refusal) throw new ForgeFailure(settled(refusal.error));
  return respond(result);
}
