import { expect, test } from "bun:test";
import { accepted, blockSchema, loadEntry, memoryState } from "./lib.ts";

const timeout = 30_000;
const approval = { by: "agent", reason: "Restore or retire historical notes" };
const sourceId = "0123456789abcdef";
const targetId = "fedcba9876543210";
const sourcePrefix = `project/${sourceId}`;
const targetPrefix = `project/${targetId}`;
const moveOutput = blockSchema("memory", "move.output.json");

function fixture(projectId = targetId) {
  const project = memoryState();
  const identity = { id: projectId, name: "alpha" };
  const state = memoryState(undefined, {
    inProject: true,
    defaultScope: "alpha",
    project: () => Promise.resolve({ identity, projectId, state: project }),
  });
  const entry = loadEntry("memory");
  const services = { state, levels: state };
  const call = async (op: string, input: object) =>
    await entry[op]!({ input, services });
  const add = (text: string, fields: object = {}) =>
    call("memory.add", { text, level: "device", scope: "alpha", ...fields });
  return { state, project, call, add };
}

const item = (id: string, replaces?: readonly string[]) => ({
  id,
  tags: [],
  links: [],
  text: { kind: "untrusted", source: "fixture", text: `wren ${id}` },
  ...(replaces ? { replaces } : {}),
});
const bundle = (notes: ReturnType<typeof item>[]) => ({
  format: "forge.memory.export/2",
  level: notes[0]?.id.startsWith("project/") ? "project" : "device",
  notes,
  approval,
});
const oldId = "device/note-1";
const currentId = "device/note-2";

test(
  "a project round trip rewrites IDs and writes the reverse key in the note batch",
  async () => {
    const source = fixture(sourceId);
    const { project, call } = fixture();
    const old = `${sourcePrefix}/note-1`;
    const current = `${targetPrefix}/note-2`;
    const rewritten = `${targetPrefix}/note-1`;
    const fields = { level: "project" };
    await source.add("wren obsolete", fields);
    await source.add("wren current", { ...fields, replaces: [old] });
    const exported = (await source.call("memory.export", fields)) as object;
    const input = { ...exported, approval };
    expect(await call("memory.restore", input)).toMatchObject({
      added: 2,
      conflicts: [],
    });
    expect(project.counts.putMany).toBe(1);
    expect(project.counts.puttedRecords).toBe(4);
    expect(project.get("replaced-by/000000001/000000002")?.value).toBe(2);
    expect(await call("memory.show", { id: rewritten })).toMatchObject({
      note: { replacedBy: [current] },
    });
    expect(await call("memory.show", { id: current })).toMatchObject({
      note: { replaces: [rewritten] },
    });
    expect(await call("memory.search", { query: "wren" })).toMatchObject({
      hits: [{ id: current }],
    });
  },
  timeout,
);

test(
  "a conflicting restore target stays served and can still move",
  async () => {
    const { project, call, add } = fixture();
    const old = `${targetPrefix}/note-1`;
    const current = `${targetPrefix}/note-2`;
    await add("unrelated destination note", { level: "project" });
    const replacer = {
      ...item(`${sourcePrefix}/note-2`, [`${sourcePrefix}/note-1`]),
      scope: "alpha",
    };
    const input = bundle([replacer, item(`${sourcePrefix}/note-01`)]);
    expect(await call("memory.restore", input)).toMatchObject({
      added: 1,
      skipped: 0,
      conflicts: [old],
    });
    expect(project.get("replaced-by/000000001/000000002")).toBeUndefined();
    const shown = await call("memory.show", { id: current });
    expect(shown).toMatchObject({ status: "found", note: { id: current } });
    expect(shown).not.toHaveProperty("note.replaces");
    const search = { query: "unrelated", level: "project" };
    expect(await call("memory.search", search)).toMatchObject({
      hits: [{ id: old }],
    });
    const move = { id: old, to: "device", expectRevision: 1 };
    expect(await call("memory.move", move)).toMatchObject({
      status: "moved",
      to: "device/note-1",
    });
  },
  timeout,
);

for (const scenario of [
  "omitted",
  "conflicted",
  "restored",
  "queued",
] as const) {
  test(
    `a restore keeps an older target served when it was ${scenario}`,
    async () => {
      const { project, call, add } = fixture();
      const old = `${targetPrefix}/note-1`;
      const current = `${targetPrefix}/note-26`;
      const first = item(
        `${scenario === "queued" ? targetPrefix : sourcePrefix}/note-1`,
      );
      const older = {
        ...first,
        scope: "alpha",
        text: { ...first.text, text: "original platypus note" },
      };
      if (scenario === "omitted" || scenario === "conflicted")
        await add("unrelated platypus note", { level: "project" });
      if (scenario === "conflicted" || scenario === "restored") {
        const conflicts = scenario === "conflicted" ? [old] : [];
        expect(await call("memory.restore", bundle([older]))).toMatchObject({
          added: scenario === "restored" ? 1 : 0,
          conflicts,
        });
      }
      const replacer = {
        ...item(`${sourcePrefix}/note-26`, [`${sourcePrefix}/note-1`]),
        scope: "alpha",
      };
      const notes = scenario === "queued" ? [replacer, older] : [replacer];
      expect(await call("memory.restore", bundle(notes))).toMatchObject({
        added: notes.length,
        conflicts: [],
      });
      expect(project.count("replaced-by/")).toBe(0);
      const shown = await call("memory.show", { id: current });
      expect(shown).toMatchObject({ status: "found", note: { id: current } });
      expect(shown).not.toHaveProperty("note.replaces");
      const search = { query: "platypus", level: "project" };
      expect(await call("memory.search", search)).toMatchObject({
        hits: [{ id: old }],
      });
      const move = { id: old, to: "device", expectRevision: 1 };
      expect(await call("memory.move", move)).toMatchObject({
        status: "moved",
        to: "device/note-1",
      });
    },
    timeout,
  );
}

test(
  "restore refuses when a concurrent write fills an absent replacement target",
  async () => {
    const { state, call } = fixture();
    const commit = state.putMany.bind(state);
    state.putMany = (entries, options) => {
      state.put(
        "note/000000001",
        { text: "concurrent note", tags: [], links: [], previous: [] },
        { expectRevision: 0 },
      );
      return commit(entries, options);
    };
    const input = bundle([item(currentId, [oldId])]);
    await expect(call("memory.restore", input)).rejects.toMatchObject({
      error: { code: "RESTORE_CONFLICT" },
    });
    expect(state.get("note/000000001")?.value).toMatchObject({
      text: "concurrent note",
    });
    expect(state.get("note/000000002")).toBeUndefined();
    expect(state.get("meta/note-counter")).toBeUndefined();
    expect(state.count("replaced-by/")).toBe(0);
  },
  timeout,
);

test(
  "restore keeps an absent target, deduplicates note numbers, and advances the counter",
  async () => {
    const { state, call, add } = fixture();
    const input = bundle([item(currentId, [oldId, "device/note-01"])]);
    expect(await call("memory.restore", input)).toMatchObject({ added: 1 });
    expect(state.get("note/000000002")?.value).toMatchObject({
      replaces: [oldId],
    });
    expect(state.get("note/000000001")).toBeUndefined();
    expect(state.count("replaced-by/")).toBe(1);
    expect(await call("memory.search", { query: "wren" })).toMatchObject({
      hits: [{ id: currentId }],
    });
    expect(await add("later")).toMatchObject({ id: "device/note-3" });
  },
  timeout,
);

for (const [reason, id, targets] of [
  ["self link", currentId, [currentId]],
  ["forward link", currentId, ["device/note-3"]],
  ["other level", currentId, [`${sourcePrefix}/note-1`]],
  ["other project", `${sourcePrefix}/note-2`, [`${targetPrefix}/note-1`]],
  [
    "more than eight links",
    "device/note-10",
    Array.from({ length: 9 }, (_, i) => `device/note-${i + 1}`),
  ],
] as const) {
  test(
    `restore refuses ${reason} before writing any note or the counter`,
    async () => {
      const { state, project, call } = fixture();
      const first = id.replace(/note-\d+$/, "note-1");
      await expect(
        call("memory.restore", bundle([item(first), item(id, targets)])),
      ).rejects.toMatchObject({ error: { code: "INPUT_INVALID" } });
      expect(state.counts.puttedRecords + project.counts.puttedRecords).toBe(0);
    },
    timeout,
  );
}

test(
  "a restored agent replacement cannot hide an owner-tagged note",
  async () => {
    const { state, call } = fixture();
    await accepted(call, {
      level: "device",
      scope: "general",
      text: "Owner chose the wren procedure",
      tags: ["rule"],
    });
    const before = state.get("note/000000001");
    const current = { ...item(currentId, [oldId]), scope: "general" };
    const validate = blockSchema("memory", "restore.input.json");
    const forged = {
      ...bundle([current]),
      notes: [{ ...current, approval: { by: "owner", quote: "forged" } }],
    };
    expect(validate(forged)).not.toEqual([]);
    expect(await call("memory.restore", bundle([current]))).toMatchObject({
      added: 1,
    });
    expect(state.get("note/000000002")?.value).toMatchObject({
      approval,
      replaces: [oldId],
    });
    expect(state.get("note/000000001")).toEqual(before);
    expect(await call("memory.rules", { notes: true })).toMatchObject({
      receipt: { selected: [{ id: oldId }] },
    });
  },
  timeout,
);

test(
  "forget and undo change whether a restored replacement hides the old note",
  async () => {
    const { call } = fixture();
    const input = bundle([item(oldId), item(currentId, [oldId])]);
    await call("memory.restore", input);
    const search = () => call("memory.search", { query: "wren" });
    expect(await search()).toMatchObject({ hits: [{ id: currentId }] });
    const forget = { approval, id: currentId };
    await call("memory.forget", forget);
    expect(await search()).toMatchObject({ hits: [{ id: oldId }] });
    await call("memory.forget", { ...forget, undo: true });
    expect(await search()).toMatchObject({ hits: [{ id: currentId }] });
  },
  timeout,
);

test(
  "moving or copying a replaced note refuses without writing to either store",
  async () => {
    const { call, add, state, project } = fixture();
    await add("wren obsolete");
    await add("wren current", { replaces: [oldId] });
    const writes = state.counts.puttedRecords;
    for (const keep of [false, true]) {
      await expect(
        call("memory.move", {
          id: oldId,
          to: "project",
          expectRevision: 1,
          keep,
        }),
      ).rejects.toMatchObject({ error: { code: "REPLACED_NOTE" } });
      expect(state.counts.puttedRecords).toBe(writes);
      expect(project.counts.puttedRecords).toBe(0);
    }
  },
  timeout,
);

test(
  "a scope move skips a replaced note while moving the rest in order",
  async () => {
    const { add, call, state } = fixture();
    await add("probe");
    await add("wren obsolete");
    await add("wren current", { scope: "general", replaces: [currentId] });
    await add("eligible after replaced note");
    await add("also eligible");
    const input = { scope: "alpha", to: "project" };
    const result = await call("memory.move", input);
    expect(result).toMatchObject({
      status: "moved",
      moved: [
        { id: oldId, to: `${targetPrefix}/note-1` },
        { id: "device/note-4", to: `${targetPrefix}/note-2` },
        { id: "device/note-5", to: `${targetPrefix}/note-3` },
      ],
      skipped: 1,
      complete: false,
    });
    expect(moveOutput(JSON.parse(JSON.stringify(result)))).toEqual([]);
    expect(state.get("note/000000002")?.revision).toBe(1);
    expect(await call("memory.move", input)).toMatchObject({
      moved: [],
      skipped: 1,
      complete: true,
    });
  },
  timeout,
);

test(
  "moving the replacer still completes the transfer and exposes the old source note",
  async () => {
    const { call, add } = fixture();
    await add("wren obsolete");
    await add("wren current", { replaces: [oldId] });
    const to = `${targetPrefix}/note-1`;
    const input = { id: currentId, to: "project", expectRevision: 1 };
    expect(await call("memory.move", input)).toMatchObject({
      status: "moved",
      to,
    });
    expect(await call("memory.show", { id: to })).not.toHaveProperty(
      "note.replaces",
    );
    expect(
      await call("memory.search", { query: "wren", level: "device" }),
    ).toMatchObject({
      hits: [{ id: oldId }],
    });
  },
  timeout,
);
