import { afterEach, expect, test } from "bun:test";
import { done, loadEntry, openHarness, type Harness } from "./lib.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import type { PutOptions, StateClient } from "../../../src/ports/state.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});
async function open(): Promise<Harness> {
  const harness = await openHarness(["memory"]);
  harnesses.push(harness);
  return harness;
}

interface ExportChunk {
  count: number;
  truncated: boolean;
  next?: number;
  notes: { id: string; text: { text: string } }[];
}

/** Seed a device store through the human restore path, in pieces the operation accepts. */
async function seed(h: Harness, texts: readonly string[]): Promise<void> {
  for (let start = 0; start < texts.length; start += 50) {
    const notes = texts.slice(start, start + 50).map((text, offset) => ({
      id: `note-${start + offset + 1}`,
      tags: [],
      links: [],
      text: { kind: "untrusted", source: "seed", text },
    }));
    done(
      await h.call("memory.restore", {
        format: "forge.memory.export/1",
        notes,
      }),
    );
  }
}

test("every export, however many notes, restores: the backup round trip has no size cliff", async () => {
  const source = await open();
  const target = await open();
  const count = 110;
  const texts = Array.from(
    { length: count },
    (_, index) => `note ${index + 1} ${"filler words ".repeat(600)}`,
  );
  await seed(source, texts);

  let after = 0;
  let chunks = 0;
  let exported = 0;
  for (;;) {
    const chunk = done(
      await source.call("memory.export", after === 0 ? {} : { after }),
    ) as ExportChunk;
    chunks += 1;
    exported += chunk.count;
    // The same document the export returned is what restore is given.
    done(
      await target.call("memory.restore", {
        format: "forge.memory.export/1",
        ...chunk,
      }),
    );
    if (!chunk.truncated) break;
    expect(chunk.next).toBeGreaterThan(after);
    after = chunk.next ?? 0;
  }
  expect(exported).toBe(count);
  expect(chunks).toBeGreaterThan(2);
  const back = done(
    await target.call("memory.show", { id: `note-${count}` }),
  ) as {
    note: { text: { text: string } };
  };
  expect(back.note.text.text).toBe(texts[count - 1]!);
}, 120_000);

test("a search over a thousand and more notes with a long query finishes inside the block deadline", async () => {
  const h = await open();
  const words = Array.from({ length: 60 }, (_, index) => `topic${index}`);
  const texts = Array.from({ length: 1500 }, (_, index) =>
    Array.from(
      { length: 30 },
      (_, at) => words[(index * 7 + at * 3) % 60],
    ).join(" "),
  );
  await seed(h, texts);
  const started = performance.now();
  const found = done(
    await h.call(
      "memory.search",
      { query: words.slice(0, 45).join(" "), limit: 5 },
      { caller: "agent" },
    ),
  ) as { hits: unknown[]; matched: number };
  expect(found.hits).toHaveLength(5);
  expect(found.matched).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(900);
}, 120_000);

function memoryState(): StateClient {
  const records = new Map<string, StateRecord>();
  return {
    get: (key) => records.get(key),
    list: (prefix = "") =>
      [...records.values()].filter((record) => record.key.startsWith(prefix)),
    events: () => [],
    put(key, value, options: PutOptions) {
      const revision = (records.get(key)?.revision ?? 0) + 1;
      if (revision - 1 !== options.expectRevision) throw new Error("stale");
      const record = {
        namespace: "forge/memory",
        key,
        revision,
        value,
        updatedAt: "2026-10-18T00:00:00Z",
        updatedBy: { kind: "agent", id: "a" },
      } as StateRecord;
      records.set(key, record);
      return record;
    },
  };
}

test("a decision list is bounded and continues from a cursor, so it always fits the output budget", () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const config = { decisions: { idPattern: "D-NNNN" } };
  for (let index = 0; index < 450; index += 1)
    entry["decision.propose"]!({
      input: { title: `Decision ${index} ${"x".repeat(150)}`, text: "t" },
      config,
      services: { state },
    });
  const seen: string[] = [];
  let after: number | undefined;
  for (;;) {
    const page = entry["decision.list"]!({
      input: after === undefined ? {} : { after },
      services: { state },
    }) as {
      total: number;
      truncated: boolean;
      next?: number;
      decisions: { id: string }[];
    };
    expect(page.decisions.length).toBeLessThanOrEqual(200);
    expect(page.total).toBe(450);
    seen.push(...page.decisions.map((d) => d.id));
    if (!page.truncated) break;
    after = page.next;
  }
  expect(seen).toHaveLength(450);
  expect(new Set(seen).size).toBe(450);
}, 30_000);

/** Put note records straight into a state client, the way a long-lived store would hold them. */
function seedRecords(
  state: StateClient,
  total: number,
  live: (number: number) => string | undefined,
): void {
  for (let number = 1; number <= total; number += 1) {
    const text = live(number);
    state.put(
      `note/${number}`,
      text === undefined
        ? { text: "", tags: [], links: [], previous: [], deleted: true }
        : { text, tags: [], links: [], previous: [] },
      { expectRevision: 0 },
    );
  }
  state.put("meta/note-counter", { last: total }, { expectRevision: 0 });
}
interface SearchPage {
  hits: { id: string }[];
  matched: number;
  scanned: number;
  truncated: boolean;
  next?: string;
}

test("a note added after thousands of forgotten ones is still found by an exact query", () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  // 5,001 old records, all forgotten, then one new note.
  seedRecords(state, 5001, () => undefined);
  const added = entry["memory.add"]!({
    input: { text: "the quokka sanctuary opens in spring" },
    services: { state },
  }) as { id: string };
  expect(added.id).toBe("note-5002");
  const found = entry["memory.search"]!({
    input: { query: "quokka sanctuary" },
    services: { state },
  }) as SearchPage;
  expect(found.hits.map((hit) => hit.id)).toEqual(["note-5002"]);
}, 60_000);

test("a cursor walk of a search reaches every matching note, however many there are", () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const total = 3200;
  // Every note shares one word; some old ones are forgotten and must never appear.
  seedRecords(state, total, (number) =>
    number % 10 === 0 ? undefined : `shared word unique${number}`,
  );
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = entry["memory.search"]!({
      input:
        cursor === undefined
          ? { query: "shared", limit: 50 }
          : { query: "shared", limit: 50, cursor },
      services: { state },
    }) as SearchPage;
    pages += 1;
    for (const hit of page.hits) {
      expect(seen.has(hit.id)).toBe(false);
      seen.add(hit.id);
    }
    if (page.next === undefined) {
      expect(page.truncated).toBe(false);
      break;
    }
    expect(page.truncated).toBe(true);
    cursor = page.next;
    expect(pages).toBeLessThan(200);
  }
  const live = Array.from({ length: total }, (_, i) => i + 1).filter(
    (n) => n % 10 !== 0,
  );
  expect(seen.size).toBe(live.length);
  expect(seen.has("note-10")).toBe(false);
  expect(seen.has("note-3199")).toBe(true);
  expect(seen.has("note-1")).toBe(true);
}, 120_000);
