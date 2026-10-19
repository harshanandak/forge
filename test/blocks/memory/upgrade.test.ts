import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { blockSchema, loadEntry, memoryState } from "./lib.ts";

// What main's memory block (#25) wrote must read, export, edit, search and restore cleanly after
// levels. The old block is main's own entry source, kept verbatim as a fixture and run the way the
// runtime runs it, so the records and the export are the old block's own, not hand-made copies.
const MAIN_ENTRY = readFileSync(
  join(
    import.meta.dirname,
    "../../node-fixtures/memory/main-memory-entry.cts.txt",
  ),
  "utf8",
);
const valid = (file: string) => {
  const check = blockSchema("memory", file);
  // The runtime hands results across as JSON text; do the same here.
  return (value: unknown) => check(JSON.parse(JSON.stringify(value)));
};

/** A device store as main's block leaves it, and the export main's block makes of it. */
async function writtenByMain() {
  const main = loadEntry("memory", undefined, {}, MAIN_ENTRY);
  const state = memoryState();
  const services = { state };
  await main["memory.add"]!({
    input: { text: "the release checklist lives in the wiki" },
    services,
  });
  await main["memory.add"]!({
    input: {
      text: "release steps",
      scope: "repo:forge",
      tags: ["release"],
      links: ["note-1"],
    },
    services,
  });
  await main["memory.add"]!({
    input: { id: "note-2", expectRevision: 1, text: "release steps, revised" },
    services,
  });
  const exported = await main["memory.export"]!({ input: {}, services });
  return { state, exported: JSON.parse(JSON.stringify(exported)) as unknown };
}

test("a store written by main's memory block shows, exports, edits and searches with valid, qualified output", async () => {
  const { state } = await writtenByMain();
  const entry = loadEntry("memory");
  const services = { state, levels: state };
  const shown = await entry["memory.show"]!({
    input: { id: "device/note-2" },
    services,
  });
  expect(valid("show.output.json")(shown)).toEqual([]);
  expect(shown).toMatchObject({
    status: "found",
    note: { id: "device/note-2", links: ["device/note-1"], revision: 2 },
  });
  const older = await entry["memory.show"]!({
    input: { id: "device/note-2", revision: 1 },
    services,
  });
  expect(valid("show.output.json")(older)).toEqual([]);
  expect(older).toMatchObject({ note: { text: { text: "release steps" } } });

  const exported = await entry["memory.export"]!({
    input: { level: "device" },
    services,
  });
  expect(valid("export.output.json")(exported)).toEqual([]);
  expect(
    (exported as { notes: { id: string; links: string[] }[] }).notes,
  ).toMatchObject([
    { id: "device/note-1", links: [] },
    { id: "device/note-2", links: ["device/note-1"] },
  ]);

  // An edit that keeps the old link reports valid output and stores the link qualified.
  const edited = await entry["memory.add"]!({
    input: { id: "device/note-2", expectRevision: 2, text: "release steps v3" },
    services,
  });
  expect(valid("add.output.json")(edited)).toEqual([]);
  expect(edited).toMatchObject({ note: { links: ["device/note-1"] } });
  expect(state.get("note/000000002")?.value).toMatchObject({
    links: ["device/note-1"],
  });

  const found = await entry["memory.search"]!({
    input: { query: "release" },
    services,
  });
  expect(valid("search.output.json")(found)).toEqual([]);
  expect(
    (found as { hits: { id: string }[] }).hits.map((hit) => hit.id).sort(),
  ).toEqual(["device/note-1", "device/note-2"]);
}, 30_000);

test("main's forge.memory.export/1 restores into device memory with qualified ids and links", async () => {
  const { exported } = await writtenByMain();
  expect(exported).toMatchObject({ format: "forge.memory.export/1" });
  expect(valid("restore.input.json")(exported)).toEqual([]);
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const restored = await entry["memory.restore"]!({
    input: exported,
    services,
  });
  expect(valid("restore.output.json")(restored)).toEqual([]);
  expect(restored).toEqual({ added: 2, skipped: 0, conflicts: [] });
  const shown = await entry["memory.show"]!({
    input: { id: "device/note-2" },
    services,
  });
  expect(shown).toMatchObject({
    note: {
      id: "device/note-2",
      level: "device",
      links: ["device/note-1"],
      text: { text: "release steps, revised" },
    },
  });
  // Restoring the same backup again changes nothing.
  expect(await entry["memory.restore"]!({ input: exported, services })).toEqual(
    { added: 0, skipped: 2, conflicts: [] },
  );
}, 30_000);

test("a bookmarked note-N id is accepted as input and answered with its qualified id", async () => {
  expect(valid("show.input.json")({ id: "note-2" })).toEqual([]);
  expect(valid("forget.input.json")({ id: "note-2" })).toEqual([]);
  expect(
    valid("move.input.json")({
      id: "note-2",
      to: "project",
      expectRevision: 1,
    }),
  ).toEqual([]);
  expect(
    valid("add.input.json")({
      id: "note-2",
      expectRevision: 1,
      text: "x",
      links: ["note-1"],
    }),
  ).toEqual([]);
  const { state } = await writtenByMain();
  const entry = loadEntry("memory");
  const services = { state, levels: state };
  const shown = await entry["memory.show"]!({
    input: { id: "note-2" },
    services,
  });
  expect(valid("show.output.json")(shown)).toEqual([]);
  expect(shown).toMatchObject({ note: { id: "device/note-2" } });
  const edited = await entry["memory.add"]!({
    input: { id: "note-1", expectRevision: 1, text: "x", links: ["note-2"] },
    services,
  });
  expect(valid("add.output.json")(edited)).toEqual([]);
  expect(edited).toMatchObject({
    id: "device/note-1",
    note: { links: ["device/note-2"] },
  });
}, 30_000);
