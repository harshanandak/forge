import { expect, test } from "bun:test";
import {
  accepted,
  blockSchema,
  decisionItems,
  loadEntry,
  memoryState,
  ownerApproval,
} from "./lib.ts";

const level = "device";
const scope = "general";
const approval = { by: "agent", reason: "Retire the obsolete note" };
const timeout = 30_000;

function fixture() {
  const state = memoryState();
  const entry = loadEntry("memory");
  const services = { state, levels: state };
  const call = (op: string, input: object) =>
    Promise.resolve(entry[op]!({ input, services }));
  const add = async (text: string, fields: object = {}) =>
    (await call("memory.add", { level, scope, text, ...fields })) as {
      id: string;
      note: { revision: number };
    };
  const search = async (query: string) =>
    (
      (await call("memory.search", { query })) as { hits: { id: string }[] }
    ).hits.map(({ id }) => id);
  const packet = async (op: string, input: object) =>
    (
      (await call(op, input)) as { receipt: { selected: { id: string }[] } }
    ).receipt.selected.map(({ id }) => id);
  return { state, call, add, search, packet };
}

test(
  "an active replacement retires the old note in search and attach",
  async () => {
    const { call, add, search, packet } = fixture();
    const old = await add("falcon old guidance");
    const current = await add("falcon current guidance", {
      replaces: [old.id],
    });
    expect(await search("falcon")).toEqual([current.id]);
    expect(
      await packet("memory.attach", { ids: [old.id, current.id] }),
    ).toEqual([current.id]);
    expect(await call("memory.show", { id: old.id })).toMatchObject({
      note: {
        revision: old.note.revision,
        text: { text: "falcon old guidance" },
        replacedBy: [current.id],
      },
    });
    expect(await call("memory.export", { level })).toMatchObject({
      notes: [
        { id: old.id, replacedBy: [current.id] },
        { id: current.id, replaces: [old.id] },
      ],
    });
  },
  timeout,
);

test(
  "a replacement waiting for the owner leaves the old rule in the startup packet",
  async () => {
    const { call, add, packet } = fixture();
    const tags = ["rule"];
    const old = await accepted<{ id: string }>(call, {
      level,
      scope,
      tags,
      text: "Use the obsolete falcon procedure",
    });
    const proposed = await add("Follow the approved owl procedure", {
      tags,
      replaces: [old.id],
    });
    expect(await packet("memory.rules", { notes: true })).toEqual([old.id]);
    expect(
      await call("memory.accept", {
        items: await decisionItems(call, [proposed.id]),
        approval: ownerApproval,
      }),
    ).toMatchObject({ results: [{ id: proposed.id, status: "accepted" }] });
    expect(await packet("memory.rules", { notes: true })).toEqual([
      proposed.id,
    ]);
  },
  timeout,
);

test(
  "forget and undo recalculate who is served in a replacement chain",
  async () => {
    const { call, add, search } = fixture();
    const first = await add("ibis initial");
    const second = await add("ibis adjusted", { replaces: [first.id] });
    const third = await add("ibis final", { replaces: [second.id] });
    expect(await search("ibis")).toEqual([third.id]);
    expect(
      await call("memory.forget", { id: third.id, approval }),
    ).toMatchObject({
      status: "forgotten",
    });
    expect(await search("ibis")).toEqual([second.id]);
    expect(
      await call("memory.forget", { id: third.id, undo: true, approval }),
    ).toMatchObject({ status: "restored" });
    expect(await search("ibis")).toEqual([third.id]);
  },
  timeout,
);

test(
  "a missing, foreign or self target fails before a note or counter write",
  async () => {
    const { state, add } = fixture();
    const old = await add("older waxwing note");
    const writes = state.counts.puttedRecords;
    for (const target of [
      "device/note-999",
      "project/0123456789abcdef/note-1",
      "device/note-2",
    ]) {
      await expect(
        add("updated waxwing note", { replaces: [target] }),
      ).rejects.toMatchObject({
        error: {
          code: expect.stringMatching(/NOT_FOUND|INPUT_INVALID/) as unknown,
        },
      });
      expect(state.counts.puttedRecords).toBe(writes);
    }
    expect(state.get("note/000000001")?.revision).toBe(old.note.revision);
  },
  timeout,
);

test(
  "the add contract accepts eight distinct qualified targets and refuses invalid lists",
  () => {
    const validate = blockSchema("memory", "add.input.json");
    const replaces = Array.from(
      { length: 9 },
      (_, i) => `device/note-${i + 1}`,
    );
    const note = { level, text: "replacement" };
    expect(validate({ ...note, replaces: replaces.slice(0, 8) })).toEqual([]);
    for (const invalid of [replaces, [replaces[0], replaces[0]], ["note-1"]])
      expect(validate({ ...note, replaces: invalid })).not.toEqual([]);
  },
  timeout,
);

test(
  "a plain agent note cannot retire an owner rule",
  async () => {
    const { call, packet } = fixture();
    const old = await accepted<{ id: string }>(call, {
      level,
      scope,
      tags: ["rule"],
      text: "Owner chose the kestrel procedure",
    });
    await call("memory.add", {
      level,
      scope,
      text: "Agent picked a gull procedure",
      replaces: [old.id],
    }).catch((error: unknown) => {
      expect(error).toMatchObject({
        error: {
          code: expect.stringMatching(
            /HUMAN_REQUIRED|INPUT_INVALID/,
          ) as unknown,
        },
      });
    });
    expect(await packet("memory.rules", { notes: true })).toEqual([old.id]);
  },
  timeout,
);
