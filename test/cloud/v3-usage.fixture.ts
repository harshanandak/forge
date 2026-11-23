import { expect } from "bun:test";
import { inventory } from "../../cloud/src/v3-checkpoint.ts";
import type { V3Image } from "../../cloud/src/v3-store.ts";
import {
  canonicalJson,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import type { guardFixture } from "./v3-project.fixture.ts";

type Fixture = ReturnType<typeof guardFixture>;
type Usage = { transcript: number; snapshot: number; directory: number };
export type Observation = { label: string; actual: unknown; expected: Usage };

export const usageOf = (image: V3Image): unknown => {
  const usage: unknown = Reflect.get(image, "usage");
  return isObject(usage) ? { ...usage } : usage;
};
export const jsonBytes = (value: unknown) =>
  Buffer.byteLength(canonicalJson(value));
export const tail = (f: Fixture, covered = 0, head = Number.MAX_SAFE_INTEGER) =>
  f.db
    .query<{ sequence: number; body: string }, [number, number]>(
      "SELECT sequence, body FROM cloud_v3_commits WHERE sequence>? AND sequence<=? ORDER BY sequence",
    )
    .all(covered, head);
export const pages = (f: Fixture) =>
  new Map(
    f.db
      .query<{ id: string; body: string }, []>(
        "SELECT id, body FROM cloud_v3_pages ORDER BY id",
      )
      .all()
      .map(({ id, body }) => [id, body]),
  );
export const buffers = (stored: ReadonlyMap<string, string>) =>
  new Map([...stored].map(([id, body]) => [id, Buffer.from(body)]));

export function archived(body: string): Record<string, unknown> {
  const frame = JSON.parse(body) as Record<string, unknown>;
  if (isObject(frame.outcome) && "result" in frame.outcome) {
    const { result, ...receipt } = frame.outcome;
    return {
      ...frame,
      outcome: { ...receipt, resultDigest: digestValue(result) },
    };
  }
  return frame;
}

export function recount(
  image: V3Image,
  members: readonly unknown[],
  stored = new Map<string, string>(),
): Usage {
  let snapshot = 0;
  let directory = 2;
  for (const [collection, key, body, revision] of inventory(
    image,
    buffers(stored),
  )) {
    const identity = {
      collection,
      key,
      ...(revision === undefined ? {} : { revision }),
    };
    if (body !== null) snapshot += Buffer.byteLength(body);
    const entry =
      body === null
        ? { ...identity, deleted: true }
        : {
            ...identity,
            page: "snapshot:0",
            offset: 999999,
            length: 999999,
            digest: "sha256:" + "0".repeat(64),
          };
    directory += jsonBytes(entry) + 1;
  }
  return { transcript: jsonBytes(members), snapshot, directory };
}

export function rootedRecount(f: Fixture, image: V3Image) {
  const stored = pages(f);
  const covered = JSON.parse(stored.get("transcript:0")!) as unknown[];
  const rows = tail(f, image.root.coveredHead, image.head);
  expect(rows.map(({ sequence }) => sequence)).toEqual(
    Array.from(
      { length: image.head - image.root.coveredHead },
      (_, i) => image.root.coveredHead + i + 1,
    ),
  );
  expect(image.tailBytes).toBe(
    rows.reduce((bytes, { body }) => bytes + Buffer.byteLength(body), 0),
  );
  return recount(
    image,
    [...covered, ...rows.map(({ body }) => archived(body))],
    stored,
  );
}

export const remember = (
  seen: Observation[],
  label: string,
  image: V3Image,
  expected: Usage,
) => seen.push({ label, actual: usageOf(image), expected });

export function assertUsage(seen: readonly Observation[]) {
  for (const { label, actual, expected } of seen)
    expect(actual, label).toEqual(expected);
}
