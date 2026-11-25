import { expect, setDefaultTimeout, test } from "bun:test";
import { loadEntry, memoryState } from "./lib.ts";

setDefaultTimeout(30_000);

const older =
  "Owner 2026-10-24: always use the fast service tier for Sol, Terra and Codex delegates; speed matters more than usage right now.";
const later =
  "Owner 2026-11-13: use the default service tier for every model and delegate; do not use fast or priority tiers.";
const original =
  "Owner 2026-11-21: service tier rule for every model and delegate (Sol, Terra, Codex CLI, delegate_task serviceTier, Claude fast mode). Default tier always. Use a fast, priority or ultrafast tier only when the owner says in the current conversation that there are spare limits to burn, and only for that conversation or the window he names. Never turn it on from an older note. Supersedes device/note-518 (always fast, 2026-10-24) and device/note-914 (default tier, 2026-11-13).";
const followUp =
  "Owner 2026-11-21: service tier rule for every model and delegate (Sol, Terra, Codex CLI, delegate_task serviceTier, Claude fast mode). Default tier always. Use fast, priority or ultrafast only when the owner says in the current conversation there are spare limits to burn, only for that conversation or the window he names. Never turn it on from an older note.";

const topic = (ids: string) =>
  `Notes ${ids} cover the same topic. Pass replaces to retire them or coexistsWith to keep both. Either option needs a nonblank single-line reason.`;
const destination = { level: "device", scope: "general" };
type Added = { id: string; note: { revision: number } };

function fixture(config: object = {}) {
  const entry = loadEntry("memory");
  const identity = { id: "0123456789abcdef", name: "app" };
  const project = { identity, projectId: identity.id, state: memoryState() };
  const state = memoryState(undefined, {
    inProject: true,
    project: () => Promise.resolve(project),
  });
  const services = { state, levels: state };
  const call = (op: string, input: object) =>
    Promise.resolve(entry[op]!({ input, config, services }));
  const add = (text: string, fields: object = {}) =>
    call("memory.add", { ...destination, text, ...fields }) as Promise<Added>;
  return { state, call, add };
}

test("the full service-tier notes require a reason to coexist", async () => {
  const { add, state } = fixture();
  const { id } = await add(original, { tags: ["fact"] });
  const writes = state.counts.puttedRecords;
  await expect(add(followUp)).rejects.toMatchObject({
    error: { message: topic(id) },
  });
  expect(state.counts.puttedRecords).toBe(writes);
  expect(
    await add(followUp, { coexistsWith: [id], reason: "Keep the dated rule." }),
  ).toMatchObject({ status: "added" });
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
    { replaces: ["device/note-2"], reason: "Other note." },
    {
      coexistsWith: ["project/0123456789abcdef/note-01"],
      reason: "Other store.",
    },
  ]) {
    await expect(add(later, fields)).rejects.toMatchObject({
      error: { message: topic(id) },
    });
  }
  expect(state.counts.puttedRecords).toBe(writes);
});

test.each([
  ["replaces", "device/note-1"],
  ["coexistsWith", "device/note-1"],
  ["replaces", "device/note-01"],
  ["coexistsWith", "device/note-01"],
])("%s with %s and a reason allows a conflicting note", async (field, ref) => {
  const { add, call } = fixture();
  const { id } = await add(older);
  const next = await add(later, {
    [field]: [ref],
    reason: "This is the current service tier policy.",
  });
  expect(next).toMatchObject({ status: "added", id: "device/note-2" });
  const shown = await call("memory.show", { id });
  if (field === "replaces")
    expect(shown).toMatchObject({ note: { replacedBy: [next.id] } });
  else expect(shown).not.toHaveProperty("note.replacedBy");
});

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
