import { canonicalJson, isObject } from "../../src/core/config/pointer.ts";
import { isNat } from "./v3-authority.ts";
import type { Frame } from "./v3-store.ts";

type RecordValue = { revision: number } & (
  { value: unknown } | { deleted: true }
);

export function recordNumber(key: string): number {
  const number = Number(key.slice(1));
  return isNat(number) && key === `r${number}` ? number : 0;
}

export function verifyRecordFrame(
  frame: Frame,
  floor: number,
  read: (key: string) => { readonly revision?: number } | undefined,
  refuse: () => Error,
) {
  const changes: { key: string; value: RecordValue }[] = [];
  const create = frame.operation === "issue.create";
  const put =
    (create && frame.outcome?.status === "ok") ||
    frame.operation === "fixture.put";
  if (!put && frame.operation !== "fixture.delete") {
    if (
      frame.changes !== undefined ||
      (create && frame.events.length !== 0) ||
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
