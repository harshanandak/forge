import {
  canonicalJson,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import { shownItem } from "./issue-read.ts";
import { checkedUpdateInput } from "./issue-update.ts";
import { isNat } from "./v3-authority.ts";
import type { Frame, V3Image } from "./v3-store.ts";

type RecordValue = { revision: number } & (
  { value: unknown } | { deleted: true }
);

export function recordNumber(key: string): number {
  const number = Number(key.slice(1));
  return isNat(number) && key === `r${number}` ? number : 0;
}

function created(frame: Frame, number: number, input: unknown) {
  if (!isObject(input)) return false;
  const { id, prefix, ...item } = input as Record<string, string>;
  const updatedAt = new Date(frame.time).toJSON();
  const shown = { ...item, id: `${prefix}-${number}`, revision: 1, updatedAt };
  return (
    id === `work-${number}` &&
    item.createdAt === updatedAt &&
    canonicalJson(frame.outcome?.result) === canonicalJson(shown)
  );
}

type Update = {
  key: string;
  prefix: string;
  expectRevision: number;
  patch: Readonly<Record<string, unknown>>;
};

export function updateEffect(
  event: Update,
  current: Record<string, unknown>,
  time: number,
  lease: unknown,
) {
  const { key, prefix, expectRevision, patch } = event;
  const id = `work-${key.slice(1)}`;
  const value = { ...current, ...patch };
  const revision = expectRevision + 1;
  const record = {
    namespace: "forge/work",
    key: `issue:${id}`,
    value,
    revision,
    updatedAt: new Date(time).toJSON(),
  };
  return {
    events: [{ ...event, revision }],
    changes: [{ key, value: { revision, value } }],
    result: shownItem(
      record,
      id,
      isObject(lease) ? lease : undefined,
      time,
      prefix,
    ),
  };
}

export function verifyRecordFrame(
  frame: Frame,
  floor: number,
  read: (key: string) => { readonly revision?: number } | undefined,
  refuse: () => Error,
  load: V3Image["load"],
) {
  const changes: { key: string; value: RecordValue }[] = [];
  const create = frame.operation === "issue.create";
  const update = frame.operation === "issue.update";
  if (update && frame.outcome?.status === "ok") {
    const event = frame.events[0];
    if (!isObject(event)) throw refuse();
    const { key, prefix, patch, expectRevision } = event;
    if (
      typeof key !== "string" ||
      !recordNumber(key) ||
      typeof prefix !== "string" ||
      !isObject(patch) ||
      !isNat(event.revision)
    )
      throw refuse();
    const prior = read(key);
    if (!prior || "deleted" in prior || prior.revision !== expectRevision)
      throw refuse();
    const id = `work-${key.slice(1)}`;
    const current = "value" in prior ? prior.value : load("record", key);
    if (!isObject(current)) throw refuse();
    try {
      const {
        id: _id,
        expectRevision: expected,
        ...fields
      } = checkedUpdateInput({ ...patch, id, expectRevision });
      const effect = updateEffect(
        { key, prefix, expectRevision: expected, patch: fields },
        current,
        frame.time,
        load("lease", `issue:${id}`),
      );
      const { result, resultDigest } = frame.outcome;
      if (
        canonicalJson(frame.events) !== canonicalJson(effect.events) ||
        canonicalJson(frame.changes) !== canonicalJson(effect.changes) ||
        (resultDigest ?? digestValue(result)) !== digestValue(effect.result)
      )
        throw refuse();
      return { floor, changes: effect.changes };
    } catch {
      throw refuse();
    }
  }
  const put =
    (create && frame.outcome?.status === "ok") ||
    frame.operation === "fixture.put";
  if (!put && frame.operation !== "fixture.delete") {
    if (
      frame.changes !== undefined ||
      ((create || update) && frame.events.length !== 0) ||
      (frame.operation !== "fixture.note" && !frame.outcome)
    )
      throw refuse();
    return { floor, changes };
  }
  if (frame.events.length === 0 || (create && frame.events.length !== 1))
    throw refuse();
  const keys = put ? "key,revision,value" : "key,revision";
  const seen = new Set<string>();
  for (const input of frame.events) {
    if (!isObject(input)) throw refuse();
    const { key, revision, value } = input;
    if (
      typeof key !== "string" ||
      !isNat(revision) ||
      Object.keys(input).sort().join() !== keys
    )
      throw refuse();
    const number = recordNumber(key);
    const prior = read(key);
    if (
      !number ||
      (create && (prior || number !== floor + 1 || revision !== 1)) ||
      (create && !created(frame, number, value)) ||
      seen.has(key) ||
      (prior && "deleted" in prior) ||
      revision <= (prior?.revision ?? 0)
    )
      throw refuse();
    if (!prior) {
      if (!put || number <= floor) throw refuse();
      floor = number;
    }
    seen.add(key);
    changes.push({
      key,
      value: put ? { revision, value } : { revision, deleted: true },
    });
  }
  if (canonicalJson(frame.changes) !== canonicalJson(changes)) throw refuse();
  return { floor, changes };
}
