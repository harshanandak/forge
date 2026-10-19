import { expect, test } from "bun:test";
import { blockSchema, loadEntry, memoryState, type Counts } from "./lib.ts";
import type { ExtendedStateClient } from "../../../src/ports/state.ts";

// Scale is shown by counting what the block asks of the store and of its own tables, never by
// reading a clock: a shared runner can be five times slower and these still mean the same thing.

interface ExportChunk {
  format: string;
  count: number;
  truncated: boolean;
  next?: number;
  notes: { id: string; text: { text: string } }[];
}
interface SearchPage {
  hits: { id: string }[];
  matched: number;
  scanned: number;
  truncated: boolean;
  next?: string;
}

/** Put note records straight into a state client, the way a long-lived store would hold them. */
function seedRecords(
  state: ExtendedStateClient,
  total: number,
  live: (number: number) => string | undefined,
): void {
  for (let number = 1; number <= total; number += 1) {
    const text = live(number);
    state.put(
      `note/${String(number).padStart(9, "0")}`,
      text === undefined
        ? { text: "", tags: [], links: [], previous: [], deleted: true }
        : { text, tags: [], links: [], previous: [] },
      { expectRevision: 0 },
    );
  }
  state.put("meta/note-counter", { last: total }, { expectRevision: 0 });
}
function reset(counts: Counts): void {
  for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] = 0;
}

const validRestore = blockSchema("memory", "restore.input.json");

function backup(count: number, length: number) {
  const entry = loadEntry("memory");
  const source = memoryState();
  seedRecords(source, count, (number) =>
    `note ${number} ${"w".repeat(length)}`.slice(0, length),
  );
  const target = memoryState();
  let after = 0;
  let chunks = 0;
  let restored = 0;
  for (;;) {
    reset(source.counts);
    const chunk = entry["memory.export"]!({
      input: after === 0 ? {} : { after },
      services: { state: source },
    }) as ExportChunk;
    chunks += 1;
    // A call reads one page of records, whatever the store holds.
    expect(source.counts.listedRecords).toBeLessThanOrEqual(100);
    expect(source.counts.get).toBe(0);
    // What the export returned is exactly what a restore must accept, and fits the output cap.
    // The runtime hands results across as JSON text; do the same here.
    expect(validRestore(JSON.parse(JSON.stringify(chunk)))).toEqual([]);
    expect(JSON.stringify(chunk).length).toBeLessThan(1_048_576);
    expect(chunk.count).toBeLessThanOrEqual(50);
    reset(target.counts);
    const result = entry["memory.restore"]!({
      input: chunk,
      services: { state: target },
    }) as { added: number; conflicts: string[] };
    // The whole page is one batch write; only the counter is written separately.
    expect(target.counts.putMany).toBe(1);
    expect(target.counts.put).toBeLessThanOrEqual(1);
    expect(result.added).toBe(chunk.count);
    expect(result.conflicts).toEqual([]);
    restored += result.added;
    if (!chunk.truncated) break;
    expect(chunk.next).toBeGreaterThan(after);
    after = chunk.next ?? 0;
  }
  return { restored, chunks, target };
}

test("every export, however many notes, restores: no size cliff for large or many notes", () => {
  const large = backup(110, 8000);
  expect(large.restored).toBe(110);
  expect(large.chunks).toBeGreaterThan(2);
  const many = backup(230, 40);
  expect(many.restored).toBe(230);
  expect(many.chunks).toBeGreaterThanOrEqual(5);
  const entry = loadEntry("memory");
  const shown = entry["memory.show"]!({
    input: { id: "note-230" },
    services: { state: many.target },
  }) as { note: { text: { text: string } } };
  expect(shown.note.text.text.startsWith("note 230")).toBe(true);
}, 60_000);

test("a restore page costs one batch write, not one write per note", () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const notes = Array.from({ length: 50 }, (_, index) => ({
    id: `note-${index + 1}`,
    tags: [],
    links: [],
    text: { kind: "untrusted", source: "s", text: `n${index}` },
  }));
  entry["memory.restore"]!({
    input: { format: "forge.memory.export/1", notes },
    services: { state },
  });
  // Before: 50 single writes (50 transactions, 50 syncs) plus the counter. After: 1 batch plus the counter.
  expect(state.counts.putMany).toBe(1);
  expect(state.counts.put).toBe(1);
  expect(state.counts.puttedRecords).toBe(51);
}, 30_000);

/** Counts every operation on a Map the block creates, so repeated scans show up as numbers. */
function countingMap(tally: { operations: number }): unknown {
  class Counting extends Map<unknown, unknown> {
    override has(key: unknown): boolean {
      tally.operations += 1;
      return super.has(key);
    }
    override get(key: unknown): unknown {
      tally.operations += 1;
      return super.get(key);
    }
    override set(key: unknown, value: unknown): this {
      tally.operations += 1;
      return super.set(key, value);
    }
  }
  return Counting;
}

function searchWork(notes: number, words: number) {
  const tally = { operations: 0 };
  const entry = loadEntry("memory", undefined, { Map: countingMap(tally) });
  const state = memoryState();
  const vocabulary = Array.from({ length: 60 }, (_, index) => `topic${index}`);
  seedRecords(state, notes, (number) =>
    Array.from(
      { length: 30 },
      (_, at) => vocabulary[(number * 7 + at * 3) % 60],
    ).join(" "),
  );
  reset(state.counts);
  tally.operations = 0;
  const page = entry["memory.search"]!({
    input: { query: vocabulary.slice(0, words).join(" "), limit: 5 },
    services: { state },
  }) as SearchPage;
  expect(page.hits).toHaveLength(5);
  return { operations: tally.operations, counts: state.counts };
}

test("a search makes one pass over its window: store reads are constant and table work grows with notes, not notes squared", () => {
  const small = searchWork(400, 45);
  const large = searchWork(800, 45);
  // One listing of the namespace per query; no per-note reads of the store.
  for (const { counts } of [small, large]) {
    expect(counts.list).toBe(1);
    expect(counts.get).toBe(0);
    expect(counts.events).toBe(0);
  }
  expect(small.counts.listedRecords).toBe(400);
  expect(large.counts.listedRecords).toBe(800);
  // Doubling the notes roughly doubles the work (a rescan per note would quadruple it).
  expect(large.operations / small.operations).toBeLessThan(2.4);
  expect(large.operations).toBeLessThan(800 * (45 + 30) * 4);
}, 60_000);

interface Page {
  hits: { id: string }[];
  next?: string;
}

test("records read per search are bounded by the window, not by how many notes the store holds", () => {
  const read = (notes: number) => {
    const { counts } = searchWork(notes, 10);
    expect(counts.list).toBe(1);
    expect(counts.get).toBe(0);
    return counts.listedRecords;
  };
  // Before: every call listed every record (2,500 then 5,000). After: one window of 1,000.
  expect(read(2500)).toBe(1000);
  expect(read(5000)).toBe(1000);
}, 60_000);

test("other calls read a bounded page too: decision list, export and a single note", () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  seedRecords(state, 3000, (number) => `note ${number}`);
  reset(state.counts);
  entry["memory.show"]!({ input: { id: "note-1500" }, services: { state } });
  expect(state.counts.listedRecords).toBe(0);
  expect(state.counts.get).toBe(1);
  reset(state.counts);
  entry["memory.export"]!({ input: {}, services: { state } });
  expect(state.counts.listedRecords).toBeLessThanOrEqual(100);
}, 60_000);

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
  }) as Page;
  expect(found.hits.map((hit) => hit.id)).toEqual(["note-5002"]);
}, 60_000);

test("a cursor walk of a search reaches every matching note, however many there are", () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const total = 3200;
  // Every note shares one word; every tenth is forgotten and must never appear.
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
    reset(state.counts);
    const page = entry["decision.list"]!({
      input: after === undefined ? {} : { after },
      services: { state },
    }) as {
      truncated: boolean;
      next?: number;
      decisions: { id: string }[];
    };
    expect(page.decisions.length).toBeLessThanOrEqual(200);
    // One page read plus one to tell whether more follows, not every decision.
    expect(state.counts.listedRecords).toBeLessThanOrEqual(201);
    seen.push(...page.decisions.map((d) => d.id));
    if (!page.truncated) break;
    after = page.next;
  }
  expect(seen).toHaveLength(450);
  expect(new Set(seen).size).toBe(450);
}, 30_000);
