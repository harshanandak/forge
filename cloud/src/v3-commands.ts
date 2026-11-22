import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { isObject } from "../../src/core/config/pointer.ts";
import type { ForgeError, TrackerItem } from "../../src/generated/types.ts";
import { validateUpdateItemInput } from "../../src/generated/validators.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { prepareReceipt } from "./command-write.ts";
import type { PreparedCommand } from "./issue-commands.ts";
import { checked } from "./issue-create.ts";
import { configured, shownItem, storedId } from "./issue-read.ts";
import { expiredReplay, RETENTION_MS } from "./issue-receipts.ts";
import { receiptScope } from "./issue-request-id.ts";
import { fence } from "./issue-update.ts";
import { NAMESPACE, requestConflict } from "./lease-command.ts";
import { carriesToken } from "./tokens.ts";
import {
  append,
  fail,
  publishV3,
  readV3Value,
  type Frame,
  type V3Image,
} from "./v3-store.ts";

export function commandV3(
  db: SqlDatabase,
  image: V3Image,
  { op, input, context, requestId }: PreparedCommand,
  device: string,
  prefix: string,
  expiresAt: number,
  now: number,
) {
  if (op !== "issue.create" && op !== "issue.update")
    throw fail("UNKNOWN_COMMAND", "No such v3 command");
  if (carriesToken(requestId))
    throw fail("INPUT_INVALID", "requestId must not carry a credential");
  configured(prefix);
  const principal = ["owner", device, device] as const;
  const identity = prepareReceipt("command", principal, requestId, {
    op,
    input,
    context,
    device,
  });
  const held = (id: string, replay = false) => {
    const binding = fence(context, id, op);
    const lease = readV3Value(db, image, "lease", binding.subject);
    const decision = decideLease(lease, {
      ...binding,
      mode: "held",
      nowMs: now,
    });
    if (!decision.ok)
      throw new ForgeFailure(
        replay
          ? {
              ...decision.error,
              code: "LEASE_STALE",
              message: `Request no longer matches the current lease on ${binding.subject}`,
            }
          : decision.error,
      );
    return lease;
  };
  const prior = readV3Value(db, image, "outcome", identity.requestId);
  if (prior && now < prior.outcome.retryUntil) {
    const { status, result, fingerprint } = prior.outcome;
    if (now >= prior.time + RETENTION_MS) expiredReplay(status !== "ok");
    if (fingerprint !== identity.fingerprint) throw requestConflict();
    if (status !== "ok") throw new ForgeFailure(result as ForgeError);
    const item = result as TrackerItem;
    if (op === "issue.update")
      held(`work-${item.id.replace(/^.*-/, "")}`, true);
    return item;
  }
  const commit = (
    result: TrackerItem | ForgeError,
    effect: Pick<Frame, "events" | "changes">,
  ) => {
    append(db, image, [
      {
        operation: op,
        time: now,
        ...effect,
        outcome: {
          id: identity.requestId,
          fingerprint: identity.fingerprint,
          scope: { family: "command", ...receiptScope(principal) },
          status: "code" in result ? result.code : "ok",
          result,
          retryUntil: expiresAt,
        },
      },
    ]);
    publishV3(db, image);
  };
  const at = new Date(now).toISOString();
  const effect = () => {
    if (op === "issue.create") {
      const number = image.recordFloor + 1;
      const id = `work-${number}`;
      const value = {
        id,
        prefix,
        status: "open",
        labels: [],
        dependsOn: [],
        createdAt: at,
        ...checked(input),
      };
      return {
        id,
        lease: undefined,
        key: `r${number}`,
        revision: 1,
        value,
        event: { value },
      };
    }
    if (
      isObject(input) &&
      ["kind", "parent", "dependsOn"].some((key) => key in input)
    )
      throw fail(
        "INPUT_INVALID",
        "Kind, parent and dependencies are not supported in cloud yet",
      );
    const parsed = validateUpdateItemInput(input);
    if (!parsed.ok)
      throw fail("INPUT_INVALID", "input must be a valid issue.update input");
    const { id: shown, expectRevision, ...patch } = parsed.value;
    const id = storedId(shown, prefix, () => false);
    const key = `r${id.slice(5)}`;
    const value = readV3Value(db, image, "record", key);
    if (!isObject(value)) throw fail("NOT_FOUND", "Issue was not found");
    const lease = held(id);
    const currentRevision = image.entries.record.get(key)!.revision!;
    if (currentRevision !== expectRevision)
      throw new ForgeFailure({
        code: "REVISION_CONFLICT",
        message: `Expected revision ${expectRevision}; current revision is ${currentRevision}`,
        retry: "reconcile_first",
        currentRevision,
      });
    return {
      id,
      lease,
      key,
      revision: currentRevision + 1,
      value: { ...value, ...patch },
      event: { expectRevision, patch },
    };
  };
  let fields: ReturnType<typeof effect>;
  try {
    fields = effect();
  } catch (error) {
    if (
      error instanceof ForgeFailure &&
      ["INPUT_INVALID", "NOT_FOUND"].includes(error.error.code)
    )
      commit(error.error, { events: [] });
    throw error;
  }
  const { id, lease, key, revision, value, event } = fields;
  const row = {
    namespace: NAMESPACE,
    key: `issue:${id}`,
    value,
    revision,
    updatedAt: at,
  };
  const result = shownItem(row, id, lease && { ...lease }, now, prefix);
  commit(result, {
    events: [{ key, revision, ...event }],
    changes: [{ key, value: { revision, value } }],
  });
  return result;
}
