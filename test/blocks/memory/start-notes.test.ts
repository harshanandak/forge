import { expect, test } from "bun:test";
import { loadEntry, memoryState } from "./lib.ts";

test("startup notes include only live rule text in scope order, with the legacy pointer intact", async () => {
  const project = memoryState();
  const device = memoryState(undefined, {
    inProject: true,
    defaultScope: "resolved",
    project: () =>
      Promise.resolve({
        identity: { id: "0123456789abcdef", name: "project" },
        state: project,
      }),
  });
  const entry = loadEntry("memory");
  const put = (
    state: typeof device,
    n: number,
    text: string,
    scope?: string,
    extra = {},
  ) =>
    state.put(
      `note/${String(n).padStart(9, "0")}`,
      {
        text,
        tags: ["rule"],
        links: [],
        previous: [],
        ...(scope === undefined ? {} : { scope }),
        ...extra,
      },
      { expectRevision: 0 },
    );
  put(device, 1, "general\n\t first\u0085rule");
  put(device, 2, "project first", "resolved");
  put(device, 3, "other project secret", "other");
  put(device, 4, "ordinary text", "general", { tags: [] });
  put(device, 5, "forgotten rule", "general", { deleted: true });
  put(device, 6, "general second", "general");
  put(project, 1, "project second");
  const services = { state: device, levels: device };
  const read = async (input: object) =>
    (await entry["memory.rules"]!({ input, services })) as {
      text: { text: string };
    };
  const pointer = (await read({})).text.text;
  expect((await read({ notes: false })).text.text).toBe(pointer);
  expect((await read({ notes: true })).text.text).toBe(
    `- [general] general first rule\n- [general] general second\n- [resolved] project first\n- [resolved] project second\n${pointer}`,
  );
  expect(pointer).toContain("general 3, resolved 2.");
  expect(device.counts.putMany).toBe(0);
  expect(project.counts.putMany).toBe(0);
}, 30_000);

test("startup note budget keeps whole notes, skips oversized notes and reports every omission", async () => {
  const state = memoryState();
  for (const [n, text] of [
    [1, "a".repeat(5997)],
    [2, "oversized"],
    [3, "end"],
    [4, "dropped"],
  ] as const)
    state.put(
      `note/${String(n).padStart(9, "0")}`,
      {
        text,
        scope: "general",
        tags: ["rule"],
        links: [],
        previous: [],
      },
      { expectRevision: 0 },
    );
  const entry = loadEntry("memory");
  const read = async (input: object) =>
    (await entry["memory.rules"]!({
      input,
      services: { state, levels: state },
    })) as { text: { text: string } };
  const pointer = (await read({})).text.text;
  expect((await read({ notes: true })).text.text).toBe(
    `- [general] ${"a".repeat(5997)}\n- [general] end\n2 more rule notes did not fit; search them.\n${pointer}`,
  );
}, 30_000);

test("startup notes merge device and project by recorded timestamp within each scope", async () => {
  const state = memoryState();
  const own = memoryState();
  const value = { tags: ["rule"], links: [], previous: [], scope: "general" };
  state.put(
    "note/000000001",
    { ...value, text: "newer device" },
    { expectRevision: 0 },
  );
  own.put(
    "note/000000001",
    { ...value, text: "older project" },
    { expectRevision: 0 },
  );
  const project = {
    ...own,
    listRange: (options: Parameters<typeof own.listRange>[0]) =>
      own
        .listRange(options)
        .map((record) => ({ ...record, updatedAt: "2020-01-01T00:00:00Z" })),
  };
  const levels = {
    ...state,
    inProject: true,
    project: () =>
      Promise.resolve({
        identity: { id: "0123456789abcdef", name: "project" },
        state: project,
      }),
  };
  const result = (await loadEntry("memory")["memory.rules"]!({
    input: { notes: true },
    services: { state, levels },
  })) as { text: { text: string } };
  expect(result.text.text).toStartWith(
    "- [general] older project\n- [general] newer device\n",
  );
}, 30_000);

test("startup notes reread edits and tombstones, and general scope never duplicates notes", async () => {
  const state = memoryState();
  const value = {
    text: "live before",
    tags: ["rule"],
    links: [],
    previous: [],
  };
  state.put("note/000000001", value, { expectRevision: 0 });
  const read = async () =>
    (await loadEntry("memory")["memory.rules"]!({
      input: { notes: true },
      services: { state, levels: state },
    })) as { text: { text: string } };
  expect((await read()).text.text.match(/live before/g)).toHaveLength(1);
  state.put(
    "note/000000001",
    { ...value, text: "live after" },
    { expectRevision: 1 },
  );
  expect((await read()).text.text).toStartWith("- [general] live after\n");
  state.put(
    "note/000000001",
    { ...value, deleted: true },
    { expectRevision: 2 },
  );
  expect((await read()).text.text).toStartWith(
    "Forge memory notes: general 0.",
  );
}, 30_000);

test("editing an old rule does not move it behind newer rules", async () => {
  const state = memoryState();
  for (const [n, text] of [
    [1, "older edited rule"],
    [2, "newer rule"],
  ] as const)
    state.put(
      `note/${String(n).padStart(9, "0")}`,
      {
        text,
        tags: ["rule"],
        links: [],
        previous: [],
      },
      { expectRevision: 0 },
    );
  const originalAt = (key: string) =>
    key.endsWith("1") ? "2020-01-01T00:00:00Z" : "2021-01-01T00:00:00Z";
  const recorded = {
    ...state,
    listRange: (options: Parameters<typeof state.listRange>[0]) =>
      state.listRange(options).map((record) => ({
        ...record,
        revision: record.key.endsWith("1") ? 2 : 1,
        updatedAt: record.key.endsWith("1")
          ? "2026-01-01T00:00:00Z"
          : originalAt(record.key),
      })),
    history: (options: Parameters<typeof state.history>[0]) => {
      expect(options.before).toBe(2);
      expect(options.limit).toBe(1);
      return [{ at: originalAt(options.key) }];
    },
  };
  const result = (await loadEntry("memory")["memory.rules"]!({
    input: { notes: true },
    services: { state: recorded, levels: state },
  })) as { text: { text: string } };
  expect(result.text.text).toStartWith(
    "- [general] older edited rule\n- [general] newer rule\n",
  );
}, 30_000);
