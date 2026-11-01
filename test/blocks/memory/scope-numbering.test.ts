import { expect, setDefaultTimeout, test } from "bun:test";
import { loadEntry, memoryState, ownerApproval, blockSchema } from "./lib.ts";

setDefaultTimeout(30_000);
const entry = loadEntry("memory");
type Store = ReturnType<typeof memoryState>;
const services = (state: Store) => ({ state, levels: state });
async function add(state: Store, scope?: string) {
  return (await entry["memory.add"]!({
    input: {
      text: "numbered memory",
      level: "device",
      ...(scope ? { scope } : {}),
    },
    services: services(state),
  })) as { id: string };
}
async function show(state: Store, id: string) {
  return (await entry["memory.show"]!({
    input: { id },
    services: services(state),
  })) as { note: { id: string; links: string[] } };
}
async function backfill(state: Store) {
  expect(entry["memory.renumber"]).toBeFunction();
  let result;
  do {
    result = (await entry["memory.renumber"]!({
      input: {},
      services: services(state),
    })) as { complete: boolean };
  } while (!result.complete);
}
function fixture() {
  const state = memoryState();
  for (let i = 0; i < 63; i++) {
    state.put(
      `note/${String(i + 1).padStart(9, "0")}`,
      {
        text: "numbered memory",
        scope: ["forge", "curapod", "general"][i % 3],
        tags: [],
        links: i ? ["device/note-1"] : [],
        previous: [],
        createdAt: "2026-10-18T00:00:00Z",
        changedAt: "2026-10-18T00:00:00Z",
        textAt: "2026-10-18T00:00:00Z",
      },
      { expectRevision: 0 },
    );
  }
  state.put("meta/note-counter", { last: 63 }, { expectRevision: 0 });
  return state;
}

test("new device ids count independently by scope, including unscoped general", async () => {
  const state = memoryState();
  const ids = [];
  for (const scope of ["forge", "forge", "curapod", undefined])
    ids.push((await add(state, scope)).id);
  expect(ids).toEqual([
    "forge/note-1",
    "forge/note-2",
    "curapod/note-1",
    "general/note-1",
  ]);
});
test("current-main fixture backfills in bounded resumable chunks without changing records or links", async () => {
  const state = fixture();
  const before = state.list("note/");
  const commits = state.counts.putMany;
  expect(entry["memory.renumber"]).toBeFunction();
  const first = await entry["memory.renumber"]!({
    input: {},
    services: services(state),
  });
  expect(first).toMatchObject({ complete: false, indexed: 25 });
  expect(state.counts.putMany - commits).toBe(1);
  await backfill(state);
  for (let i = 1; i <= 63; i++) {
    const id = `${["forge", "curapod", "general"][(i - 1) % 3]}/note-${Math.ceil(i / 3)}`;
    expect((await show(state, `device/note-${i}`)).note.id).toBe(id);
    expect((await show(state, `note-${i}`)).note.id).toBe(id);
    expect((await show(state, id)).note.id).toBe(id);
  }
  expect(state.list("note/")).toEqual(before);
  const all = state.list();
  await backfill(state);
  expect(state.list()).toEqual(all);
  const other = fixture();
  await backfill(other);
  expect(
    other
      .list()
      .filter(({ key }) => !key.startsWith("note/"))
      .map(({ key, value }) => ({ key, value })),
  ).toEqual(
    all
      .filter(({ key }) => !key.startsWith("note/"))
      .map(({ key, value }) => ({ key, value })),
  );
});
test("legacy aliases edit, link, propose, attach, forget and undo the same note", async () => {
  const state = fixture();
  await backfill(state);
  for (const id of ["device/note-2", "note-2"]) {
    const edited = await entry["memory.add"]!({
      input: { id, text: "edited", links: ["note-1"] },
      services: services(state),
    });
    expect(edited).toMatchObject({
      id: "curapod/note-1",
      note: { links: ["device/note-1"] },
    });
    expect(
      await entry["memory.propose-forget"]!({
        input: { id },
        services: services(state),
      }),
    ).toMatchObject({ id: "curapod/note-1" });
    expect(
      await entry["memory.forget"]!({
        input: { id, approval: ownerApproval },
        services: services(state),
      }),
    ).toMatchObject({ status: "forgotten", id: "curapod/note-1" });
    await entry["memory.forget"]!({
      input: { id, undo: true, approval: ownerApproval },
      services: services(state),
    });
  }
  expect(
    await entry["memory.attach"]!({
      input: { ids: ["note-1"] },
      config: { scope: "forge" },
      services: { state, levels: { ...state, inProject: true } },
    }),
  ).toMatchObject({ receipt: { selected: [{ id: "forge/note-1" }] } });
});
test("scope edits keep identity and destination scope counter advances independently", async () => {
  const state = memoryState();
  const first = await add(state, "forge");
  await add(state, "curapod");
  await entry["memory.add"]!({
    input: { id: first.id, text: "moved scope", scope: "curapod" },
    services: services(state),
  });
  expect((await show(state, first.id)).note.id).toBe("forge/note-1");
  expect((await add(state, "curapod")).id).toBe("curapod/note-2");
});
test("export restore preserves scoped ids even when scopes interleave and scope has changed", async () => {
  const state = memoryState();
  await add(state, "forge");
  await add(state, "curapod");
  const last = await add(state, "forge");
  await entry["memory.add"]!({
    input: { id: last.id, text: "changed scope", scope: "curapod" },
    services: services(state),
  });
  const exported = await entry["memory.export"]!({
    input: { level: "device" },
    services: services(state),
  });
  expect(exported).toMatchObject({
    notes: [
      { id: "forge/note-1" },
      { id: "curapod/note-1" },
      { id: "forge/note-2" },
    ],
  });
  const restored = memoryState();
  expect(
    blockSchema(
      "memory",
      "restore.input.json",
    )(JSON.parse(JSON.stringify(exported))),
  ).toEqual([]);
  expect(
    await entry["memory.restore"]!({
      input: { ...(exported as object), approval: ownerApproval },
      services: services(restored),
    }),
  ).toMatchObject({ added: 3, conflicts: [] });
  for (const id of ["forge/note-1", "curapod/note-1", "forge/note-2"])
    expect((await show(restored, id)).note.id).toBe(id);
  expect((await add(restored, "forge")).id).toBe("forge/note-3");
});

test("legacy show stays at one point read; scoped show adds exactly one index read", async () => {
  const state = memoryState();
  await add(state, "forge");
  for (const id of ["note-1", "device/note-1", "forge/note-1"]) {
    const gets = state.counts.get;
    const lists = state.counts.list;
    expect(await show(state, id)).toMatchObject({
      note: { id: "forge/note-1" },
    });
    expect(state.counts.get - gets).toBe(id === "forge/note-1" ? 2 : 1);
    expect(state.counts.list - lists).toBe(0);
  }
});

test("legacy attachment needs no point reads and scoped attachment has a bounded lookup count", async () => {
  const state = memoryState();
  await add(state, "general");
  await add(state, "general");
  for (const ids of [
    ["note-1", "device/note-2"],
    ["general/note-1", "general/note-2"],
  ]) {
    const gets = state.counts.get;
    const lists = state.counts.list;
    const result = await entry["memory.attach"]!({
      input: { ids },
      services: services(state),
    });
    expect(result).toMatchObject({
      receipt: {
        selected: [{ id: "general/note-1" }, { id: "general/note-2" }],
      },
    });
    expect(state.counts.get - gets).toBe(ids[0] === "note-1" ? 0 : 2);
    expect(state.counts.list - lists).toBe(1);
  }
});
