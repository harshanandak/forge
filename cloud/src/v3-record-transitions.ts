import { canonicalJson, isObject } from "../../src/core/config/pointer.ts";
import { isNat, isV3Command } from "./v3-authority.ts";
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
  readValue: (key: string) => unknown,
) {
  const changes: { key: string; value: RecordValue }[] = [];
  const typed = isV3Command(frame.operation);
  const update = frame.operation === "issue.update";
  if (typed && frame.outcome?.status !== "ok") {
    if (frame.changes !== undefined || frame.events.length) throw refuse();
    return { floor, changes };
  }
  const put = typed || frame.operation === "fixture.put";
  if (!put && frame.operation !== "fixture.delete") {
    if (
      frame.changes !== undefined ||
      (frame.operation !== "fixture.note" && !frame.outcome)
    )
      throw refuse();
    return { floor, changes };
  }
  if (frame.events.length === 0 || (typed && frame.events.length !== 1))
    throw refuse();
  const keys = update
    ? "expectRevision,key,patch,revision"
    : put
      ? "key,revision,value"
      : "key,revision";
  const seen = new Set<string>();
  for (const input of frame.events) {
    if (!isObject(input)) throw refuse();
    const { key, revision, value, patch, expectRevision } = input;
    if (
      typeof key !== "string" ||
      !isNat(revision) ||
      Object.keys(input).sort().join() !== keys
    )
      throw refuse();
    const number = recordNumber(key);
    const prior = read(key);
    let next = value;
    if (update) {
      const current = readValue(key);
      if (
        !prior ||
        prior.revision !== expectRevision ||
        revision !== prior.revision + 1 ||
        !isObject(current) ||
        !isObject(patch) ||
        Object.keys(patch).some(
          (field) => !["title", "body", "labels"].includes(field),
        )
      )
        throw refuse();
      next = { ...current, ...patch };
    } else if (typed && (prior || number !== floor + 1 || revision !== 1))
      throw refuse();
    if (
      !number ||
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
      value: put ? { revision, value: next } : { revision, deleted: true },
    });
  }
  if (canonicalJson(frame.changes) !== canonicalJson(changes)) throw refuse();
  return { floor, changes };
}
