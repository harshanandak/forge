import { expect, test } from "bun:test";
import {
  accepted,
  blockSchema,
  decisionItems,
  done,
  loadEntry,
  memoryState,
  openHarness,
  ownerApproval,
  type Harness,
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
  const search = async (query: string, filters: object = {}) =>
    (
      (await call("memory.search", { query, ...filters })) as {
        hits: { id: string }[];
      }
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
    const old = await add("falcon old guidance", {
      tags: ["on:falcon", "obsolete"],
    });
    const current = await add("falcon current guidance", {
      tags: ["on:falcon"],
      replaces: [old.id],
    });
    expect(await search("falcon")).toEqual([current.id]);
    expect(
      await packet("memory.attach", { ids: [old.id, current.id] }),
    ).toEqual([current.id]);
    expect(await packet("memory.attach", { labels: ["falcon"] })).toEqual([
      current.id,
    ]);
    expect(await search("falcon", { tag: "obsolete" })).toEqual([]);
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
  "an owner-tagged replacer retires an agent note only after acceptance",
  async () => {
    const { call, add, packet } = fixture();
    const old = await add("Use the old falcon procedure");
    const tags = ["rule"];
    const rejected = await add("Try the heron procedure", {
      tags,
      replaces: [old.id],
    });
    expect(await call("memory.proposals", {})).toMatchObject({
      groups: [{ items: [{ id: rejected.id, replaces: [old.id] }] }],
    });
    await call("memory.reject", {
      items: await decisionItems(call, [rejected.id]),
      approval: ownerApproval,
    });
    const proposed = await add("Use the approved owl procedure", {
      tags,
      replaces: [old.id],
    });
    expect(proposed).toMatchObject({ note: { status: "proposed" } });
    const ids = [old.id, rejected.id, proposed.id];
    expect(await packet("memory.attach", { ids })).toEqual([old.id]);
    expect(
      await call("memory.accept", {
        items: await decisionItems(call, [proposed.id]),
        approval: ownerApproval,
      }),
    ).toMatchObject({ results: [{ id: proposed.id, status: "accepted" }] });
    expect(await packet("memory.attach", { ids })).toEqual([proposed.id]);
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
  "replacing an owner-tagged note fails before writing even with approval",
  async () => {
    const { state, call, add } = fixture();
    const old = await accepted<{ id: string }>(call, {
      level,
      scope,
      tags: ["rule"],
      text: "Owner chose the kestrel procedure",
    });
    const writes = state.counts.puttedRecords;
    await expect(
      add("Agent picked a gull procedure", {
        replaces: [old.id],
        approval: ownerApproval,
      }),
    ).rejects.toMatchObject({
      error: {
        code: "INPUT_INVALID",
        message: `Cannot replace owner-tagged note ${old.id}`,
      },
    });
    expect(state.counts.puttedRecords).toBe(writes);
  },
  timeout,
);

test(
  "older search windows and export pages still know about the newer replacer",
  async () => {
    const { state, call, add } = fixture();
    const old = await add("osprey obsolete");
    for (let n = 2; n <= 1001; n++) {
      state.put(
        `note/${String(n).padStart(9, "0")}`,
        {
          text: "other note",
          tags: [],
          links: [],
          previous: [],
        },
        { expectRevision: 0 },
      );
    }
    state.put("meta/note-counter", { last: 1001 }, { expectRevision: 1 });
    const current = await add("osprey current", { replaces: [old.id] });
    const input = { query: "osprey" };
    const first = (await call("memory.search", input)) as { next?: string };
    expect(first).toMatchObject({ hits: [{ id: current.id }] });
    expect(first.next).toBeDefined();
    expect(
      await call("memory.search", { ...input, cursor: first.next }),
    ).toMatchObject({ hits: [] });
    const exported = (await call("memory.export", { level })) as {
      notes: unknown[];
    };
    expect(exported.notes[0]).toMatchObject({
      id: old.id,
      replacedBy: [current.id],
    });
  },
  timeout,
);

test(
  "edits preserve a replacement and cannot write a new replacement list",
  async () => {
    const { state, call, add, search } = fixture();
    const old = await add("oriole obsolete", { scope: "alpha" });
    const current = await add("oriole current", {
      scope: "alpha",
      replaces: [old.id],
    });
    const writes = state.counts.puttedRecords;
    const edit = { id: current.id, expectRevision: current.note.revision };
    for (const input of [
      { ...edit, replaces: [] },
      { scope: "beta", replaces: [old.id] },
      { scope: "alpha", replaces: [old.id, "device/note-01"] },
    ]) {
      await expect(add("oriole changed", input)).rejects.toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
      expect(state.counts.puttedRecords).toBe(writes);
    }
    await add("oriole changed", edit);
    expect(await search("oriole")).toEqual([current.id]);
    await call("memory.propose-forget", { id: current.id });
    expect(await search("oriole")).toEqual([current.id]);
    await add("oriole moved out of scope", {
      id: current.id,
      scope: "beta",
      expectRevision: current.note.revision + 2,
    });
    expect(await search("oriole")).toContain(old.id);
  },
  timeout,
);

test(
  "restoring a replacement bundle serves only the replacer",
  async () => {
    const source = await openHarness(["memory"]);
    let target: Harness | undefined;
    const add = async (text: string, fields: object = {}) =>
      done(
        await source.call("memory.add", { level, scope, text, ...fields }),
      ) as { id: string };
    try {
      const old = await add("swift obsolete");
      const current = await add("swift current", { replaces: [old.id] });
      const bundle = done(
        await source.call("memory.export", { level }),
      ) as object;
      target = await openHarness(["memory"]);
      expect(
        done(await target.call("memory.restore", { ...bundle, approval })),
      ).toMatchObject({
        added: 2,
        conflicts: [],
      });
      expect(
        done(await target.call("memory.show", { id: current.id })),
      ).toMatchObject({
        note: { replaces: [old.id] },
      });
      const search = done(
        await target.call("memory.search", { query: "swift" }),
      ) as { hits: { id: string }[] };
      expect(search.hits.map(({ id }) => id)).toEqual([current.id]);
      const packet = done(
        await target.call("memory.attach", { ids: [old.id, current.id] }),
      ) as { receipt: { selected: { id: string }[] } };
      expect(packet.receipt.selected.map(({ id }) => id)).toEqual([current.id]);
    } finally {
      await Promise.all([source.close(), target?.close()]);
    }
  },
  timeout,
);

test(
  "an exact owner-note twin missing the replacement fails before writing",
  async () => {
    const { state, call, add } = fixture();
    const text = "Owner chose the tern procedure";
    const tags = ["rule"];
    const old = await add("obsolete finch procedure");
    const twin = await accepted<{ id: string }>(call, {
      level,
      scope,
      text,
      tags,
    });
    const writes = state.counts.puttedRecords;
    await expect(add(text, { tags, replaces: [old.id] })).rejects.toMatchObject(
      {
        error: {
          code: "INPUT_INVALID",
          message: `Note ${twin.id} says the same thing; revise it with id and expectRevision instead.`,
        },
      },
    );
    expect(state.counts.puttedRecords).toBe(writes);
  },
  timeout,
);

test(
  "an exact owner-note twin covering the requested target is refused",
  async () => {
    const { state, call, add } = fixture();
    const text = "Owner chose the swift procedure";
    const tags = ["rule"];
    const first = await add("obsolete wren procedure");
    const second = await add("obsolete shrike procedure");
    const twin = await accepted<{ id: string }>(call, {
      level,
      scope,
      text,
      tags,
      replaces: [first.id, second.id],
    });
    const writes = state.counts.puttedRecords;
    await expect(
      add(text, { tags, replaces: [first.id] }),
    ).rejects.toMatchObject({
      error: {
        message: `Note ${twin.id} says the same thing; revise it with id and expectRevision instead.`,
      },
    });
    expect(state.counts.puttedRecords).toBe(writes);
  },
  timeout,
);

test(
  "a replaced note is served again after it gains an accepted owner tag",
  async () => {
    const { call, add, packet, search } = fixture();
    const text = "Old heron procedure";
    const old = await add(text);
    const current = await add("Current heron procedure", {
      replaces: [old.id],
    });
    const ids = [old.id, current.id];
    expect(await packet("memory.attach", { ids })).toEqual([current.id]);
    expect(await search("heron")).toEqual([current.id]);
    await add(text, {
      id: old.id,
      expectRevision: old.note.revision,
      tags: ["rule"],
    });
    expect(await packet("memory.attach", { ids })).toEqual([current.id]);
    expect(
      await call("memory.accept", {
        items: await decisionItems(call, [old.id]),
        approval: ownerApproval,
      }),
    ).toMatchObject({ results: [{ id: old.id, status: "accepted" }] });
    expect(await packet("memory.attach", { ids })).toEqual(ids);
    expect(await packet("memory.rules", { notes: true })).toEqual([old.id]);
    expect((await search("heron")).sort()).toEqual([...ids].sort());
  },
  timeout,
);

test(
  "a new replacement cannot make a search cursor skip an unrelated note",
  async () => {
    const { call, add } = fixture();
    const first = await add("identical shrike procedure");
    const second = await add("second shrike procedure");
    const third = await add("third shrike procedure");
    const input = { query: "shrike", limit: 1 };
    const start = (await call("memory.search", input)) as { next: string };
    expect(start).toMatchObject({ hits: [{ id: third.id }], next: "4:1" });
    await add("current shrike procedure", { replaces: [third.id] });
    const middle = (await call("memory.search", {
      ...input,
      cursor: start.next,
    })) as { next: string };
    expect(middle).toMatchObject({ hits: [{ id: second.id }], next: "4:2" });
    expect(
      await call("memory.search", { ...input, cursor: middle.next }),
    ).toMatchObject({
      hits: [{ id: first.id }],
      truncated: false,
    });
  },
  timeout,
);
