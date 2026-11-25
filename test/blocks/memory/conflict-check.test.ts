import { expect, setDefaultTimeout, test } from "bun:test";
import { loadEntry, memoryState } from "./lib.ts";

setDefaultTimeout(30_000);

const older =
  "Owner 2026-10-24: always use the fast service tier for Sol, Terra and Codex delegates; speed matters more than usage right now.";
const later =
  "Owner 2026-11-13: use the default service tier for every model and delegate; do not use fast or priority tiers.";
const original =
  "Owner 2026-11-21: service tier rule for every model and delegate (Sol, Terra, Codex CLI, delegate_task serviceTier, Claude fast mode). Default tier always. Use a fast, priority or ultrafast tier only when the owner says in the current conversation that there are spare limits to burn, and only for that conversation or the window he names. Never turn it on from an older note.";
const near =
  "Owner 2026-11-21: service tier rule for every model and delegate (Sol, Terra, Codex CLI, delegate_task serviceTier, Claude fast mode). Default tier always. Use fast, priority or ultrafast only when the owner says in the current conversation there are spare limits to burn, only for that conversation or the window he names. Never turn it on from an older note.";

const topic = (ids: string) =>
  `Notes ${ids} cover the same topic. Pass replaces to retire them, or coexistsWith with a reason to keep both.`;
const duplicate = (id: string) =>
  `Note ${id} says the same thing; revise it with id and expectRevision instead.`;

function fixture(config: object = {}) {
  const entry = loadEntry("memory");
  const project = memoryState();
  const state = memoryState(undefined, {
    inProject: true,
    project: () =>
      Promise.resolve({
        identity: { id: "0123456789abcdef", name: "app" },
        projectId: "0123456789abcdef",
        state: project,
      }),
  });
  const call = (op: string, input: object) =>
    Promise.resolve(
      entry[op]!({ input, config, services: { state, levels: state } }),
    );
  const add = (text: string, fields: object = {}) =>
    call("memory.add", {
      level: "device",
      scope: "general",
      text,
      ...fields,
    }) as Promise<{
      id: string;
      note: { revision: number };
    }>;
  return { state, call, add };
}

test("exact and near duplicates of an ordinary note are refused before any write", async () => {
  const { add, state } = fixture();
  const { id } = await add(original, { tags: ["fact"] });
  const writes = state.counts.puttedRecords;
  await expect(add(original)).rejects.toMatchObject({
    error: { message: duplicate(id) },
  });
  await expect(
    add(near, { coexistsWith: [id], reason: "A separate intention" }),
  ).rejects.toMatchObject({ error: { message: duplicate(id) } });
  expect(state.counts.puttedRecords).toBe(writes);
});

test("an agent must name and explain how to handle the same-topic note", async () => {
  const { add, state } = fixture();
  const { id } = await add(older);
  const writes = state.counts.puttedRecords;
  for (const fields of [
    {},
    { replaces: [id] },
    { coexistsWith: [id], reason: "  " },
    { replaces: [id], reason: "First line\nSecond line" },
  ]) {
    await expect(add(later, fields)).rejects.toMatchObject({
      error: { message: topic(id) },
    });
  }
  expect(state.counts.puttedRecords).toBe(writes);
});

for (const field of ["replaces", "coexistsWith"] as const) {
  test(
    "a reason and " + field + " allow an agent to add a conflicting note",
    async () => {
      const { add, call } = fixture();
      const { id } = await add(older);
      const next = await add(later, {
        [field]: [id],
        reason: "This is the current service tier policy.",
      });
      expect(next).toMatchObject({ status: "added", id: "device/note-2" });
      const shown = await call("memory.show", { id });
      if (field === "replaces")
        expect(shown).toMatchObject({ note: { replacedBy: [next.id] } });
      else expect(shown).not.toHaveProperty("note.replacedBy");
    },
  );
}

test("the scan leaves other levels and scopes out, and a revision can keep its own text", async () => {
  const { add } = fixture();
  const old = await add(older, { scope: null });
  expect(await add(older, { level: "project", scope: null })).toMatchObject({
    status: "added",
  });
  expect(await add(older, { scope: "app" })).toMatchObject({ status: "added" });
  expect(await add("Oaks shed leaves", { scope: null })).toMatchObject({
    status: "added",
  });
  expect(
    await add(older, { id: old.id, expectRevision: old.note.revision }),
  ).toMatchObject({ status: "updated", id: old.id });
});

test("the configured threshold overrides the starting value", async () => {
  const { add } = fixture({ conflictThreshold: 3 });
  await add(older);
  expect(await add(later)).toMatchObject({ status: "added" });
});

test("the conflict message names only the top three matches in score order", async () => {
  const { add, call } = fixture({ conflictThreshold: 0 });
  const inputs = [
    "falcon orchard releases",
    "falcon papaya",
    "falcon releases guide",
    "falcon stable releases details",
  ];
  const stored: string[] = [];
  for (const text of inputs) {
    const fields = {
      coexistsWith: [...stored],
      reason: "Distinct entries for this fixture.",
    };
    const { id } = await add(text, stored.length ? fields : {});
    stored.push(id);
  }
  const query = "falcon stable releases";
  const search = (await call("memory.search", {
    query,
    level: "device",
    scope: "general",
    limit: 3,
  })) as { hits: { id: string }[] };
  await expect(add(query)).rejects.toMatchObject({
    error: { message: topic(search.hits.map(({ id }) => id).join(", ")) },
  });
});
