import { canonicalJson, isObject } from "../../src/core/config/pointer.ts";
import { checkedUpdateInput } from "./issue-update.ts";
import { isNat } from "./v3-authority.ts";
import type { Frame } from "./v3-store.ts";

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

export function verifyRecordFrame(
  frame: Frame,
  floor: number,
  read: (
    key: string,
  ) => { readonly revision?: number; readonly value?: unknown } | undefined,
  refuse: () => Error,
  readValue?: (key: string) => unknown,
) {
  const changes: { key: string; value: RecordValue }[] = [];
  const create = frame.operation === "issue.create";
  const update = frame.operation === "issue.update";
  const command = create || update;
  const put =
    (command && frame.outcome?.status === "ok") ||
    frame.operation === "fixture.put";
  if (!put && frame.operation !== "fixture.delete") {
    if (
      frame.changes !== undefined ||
      (command && frame.events.length !== 0) ||
      (frame.operation !== "fixture.note" && !frame.outcome)
    )
      throw refuse();
    return { floor, changes };
  }
  if (frame.events.length === 0 || (command && frame.events.length !== 1))
    throw refuse();
  const keys = update
    ? "expectRevision,key,patch,revision"
    : put
      ? "key,revision,value"
      : "key,revision";
  const seen = new Set<string>();
  for (const input of frame.events) {
    if (!isObject(input)) throw refuse();
    const { key, revision } = input;
    let { value } = input;
    if (
      typeof key !== "string" ||
      !isNat(revision) ||
      Object.keys(input).sort().join() !== keys
    )
      throw refuse();
    const number = recordNumber(key);
    const prior = read(key);
    if (update) {
      const { expectRevision, patch } = input;
      const current =
        prior && "value" in prior ? prior.value : readValue?.(key);
      if (
        prior?.revision !== expectRevision ||
        revision !== Number(expectRevision) + 1 ||
        !isObject(current) ||
        !isObject(patch) ||
        "id" in patch ||
        "expectRevision" in patch
      )
        throw refuse();
      try {
        checkedUpdateInput({ ...patch, id: `work-${number}`, expectRevision });
      } catch {
        throw refuse();
      }
      value = { ...current, ...patch };
    }
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
