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
} from "./lib.ts";

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
  tags: [] as string[],
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
const unissuedId = "00000000-0000-4000-8000-000000000001";
type RestorePage = { restoreId?: string; next?: number };
type Call = ReturnType<typeof fixture>["call"];

async function startRestore(call: Call, note: ReturnType<typeof item>) {
  const { restoreId } = (await call("memory.restore", {
    ...bundle([note]),
    truncated: true,
  })) as RestorePage;
  expect(restoreId).toBeDefined();
  return restoreId ?? unissuedId;
}

async function servedIds(call: Call) {
  const found = (await call("memory.search", { query: "wren" })) as {
    hits: { id: string }[];
  };
  return found.hits.map(({ id }) => id).sort();
}

function deferredLink(restoreId: string) {
  return {
    replaces: [oldId],
    restored: { id: restoreId, sourceId: currentId, pending: [oldId] },
  };
}

test("catalog refuses bundle-supplied provenance", { timeout }, async () => {
  const target = await openHarness(["memory"]);
  try {
    const older = item(oldId);
    done(await target.call("memory.restore", bundle([older])));
    const restored = { id: unissuedId, sourceId: oldId, pending: [] };
    const forged = { ...older, restored };
    const page = bundle([forged, item(currentId, [oldId])]);
    expect(await target.call("memory.restore", page)).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    const shown = done(await target.call("memory.show", { id: oldId }));
    expect(shown).not.toHaveProperty("note.replacedBy");
    expect(
      done(await target.call("memory.search", { query: "wren" })),
    ).toMatchObject({ hits: [{ id: oldId }] });
  } finally {
    await target.close();
  }
});

test(
  "a finished restore ID cannot hide another slot",
  { timeout },
  async () => {
    const { call, state } = fixture();
    const lastId = "device/note-3";
    const replayId = "device/note-4";
    await call("memory.restore", bundle([item(oldId)]));
    const before = state.get("note/000000001");
    const restoreId = await startRestore(call, item(currentId));
    const continuation = { restoreId, approval: ownerApproval };
    const expected = { added: 1, skipped: 0, conflicts: [], restoreId };
    for (const note of [item(lastId), item(replayId, [oldId])]) {
      const page = { ...bundle([note]), ...continuation };
      expect(await call("memory.restore", page)).toEqual(expected);
    }
    const replay = state.get("note/000000004")?.value;
    const restored = { id: restoreId, sourceId: replayId, pending: [] };
    expect(replay).toHaveProperty("restored", restored);
    expect(replay).not.toHaveProperty("replaces");
    expect(state.get("note/000000001")).toEqual(before);
    expect(state.count("replaced-by/")).toBe(0);
    expect(await servedIds(call)).toEqual([oldId, currentId, lastId, replayId]);
  },
);

test("a foreign project cannot reuse a restore ID", { timeout }, async () => {
  const { call, project } = fixture();
  const restoreId = await startRestore(call, item(`${sourcePrefix}/note-1`));
  const writes = project.counts.puttedRecords;
  const old = `${targetPrefix}/note-1`;
  const page = {
    ...bundle([item(`${targetPrefix}/note-2`, [old])]),
    project: { id: targetId, name: "alpha" },
    restoreId,
    approval: ownerApproval,
  };
  const message = "Unknown restore ID for this source and store";
  const error = { code: "INPUT_INVALID", message };
  await expect(call("memory.restore", page)).rejects.toMatchObject({ error });
  expect(project.counts.puttedRecords).toBe(writes);
  expect(project.count("replaced-by/")).toBe(0);
  expect(await servedIds(call)).toEqual([old]);
});

test("edits and decisions keep deferred provenance", { timeout }, async () => {
  const { call, state } = fixture();
  const restoreId = await startRestore(call, item(currentId, [oldId]));
  await call("memory.restore", bundle([item(oldId)]));
  const id = currentId;
  const fields = { id, scope: "general" };
  const link = deferredLink(restoreId);
  const check = async () => {
    const value = state.get("note/000000002")?.value;
    expect(value).toHaveProperty("restored", link.restored);
    expect(value).toHaveProperty("replaces", link.replaces);
    expect(await servedIds(call)).toEqual([oldId, currentId]);
  };
  await check();
  const edit = (text: string, tag: string) =>
    call("memory.add", { ...fields, text, tags: [tag] });
  const updated = { status: "updated" };
  expect(await edit("wren edit", "fact")).toMatchObject(updated);
  await check();
  for (const [op, status] of [
    ["accept", "accepted"],
    ["reject", "rejected"],
    ["withdraw", "withdrawn"],
  ]) {
    const text = `wren ${op} proposal`;
    expect(await edit(text, "rule")).toMatchObject(updated);
    await check();
    const items = await decisionItems(call, [id]);
    const input = { items, approval: ownerApproval, reason: "Superseded" };
    expect(await call(`memory.${op}`, input)).toEqual({
      results: [{ id, status }],
    });
    await check();
  }
  const proposal = await call("memory.propose-forget", { id });
  expect(proposal).toMatchObject({ status: "proposed" });
  await check();
});

test("forget and undo preserve deferred provenance", { timeout }, async () => {
  const { call, state } = fixture();
  const restoreId = await startRestore(call, item(currentId, [oldId]));
  const page = { ...bundle([item(oldId)]), restoreId, approval: ownerApproval };
  await call("memory.restore", page);
  const link = deferredLink(restoreId);
  const record = () => state.get("note/000000002")?.value;
  expect(record()).toHaveProperty("restored", link.restored);
  expect(record()).toHaveProperty("replaces", link.replaces);
  expect(await servedIds(call)).toEqual([currentId]);
  const forget = { id: currentId, approval };
  const forgotten = await call("memory.forget", forget);
  expect(forgotten).toMatchObject({ status: "forgotten" });
  expect(record()).toHaveProperty("forgotten.restored", link.restored);
  expect(record()).toHaveProperty("forgotten.replaces", link.replaces);
  expect(await servedIds(call)).toEqual([oldId]);
  const undone = await call("memory.forget", { ...forget, undo: true });
  expect(undone).toMatchObject({ status: "restored" });
  expect(record()).toHaveProperty("restored", link.restored);
  expect(record()).toHaveProperty("replaces", link.replaces);
  expect(await servedIds(call)).toEqual([currentId]);
});

test(
  "three export pages restore a split pair using the ID issued by the first page",
  async () => {
    const source = fixture();
    const { call, state } = fixture();
    await source.add("wren obsolete");
    for (let number = 2; number <= 50; number += 1)
      await source.add(`filler ${number}`);
    await source.add("wren current", {
      replaces: [oldId],
      reason: "The current wren guidance supersedes the obsolete instructions.",
    });
    const fields = { level: "device" };
    const first = (await source.call("memory.export", fields)) as RestorePage;
    const second = (await source.call("memory.export", {
      ...fields,
      after: first.next,
    })) as RestorePage;
    const third = (await source.call("memory.export", {
      ...fields,
      after: second.next,
    })) as RestorePage;
    const started = (await call("memory.restore", {
      ...first,
      approval,
    })) as RestorePage;
    const restoreId = started.restoreId ?? unissuedId;
    const continued = [];
    for (const page of [second, third]) {
      continued.push(
        await call("memory.restore", {
          ...page,
          restoreId,
          approval: ownerApproval,
        }),
      );
    }
    const current = "device/note-51";
    const found = (await call("memory.search", { query: "wren" })) as {
      hits: { id: string }[];
    };
    expect(found.hits.map(({ id }) => id)).toEqual([current]);
    expect(started).toMatchObject({ added: 25, restoreId });
    expect(continued).toMatchObject([
      { added: 25, restoreId },
      { added: 1, restoreId },
    ]);
    for (const number of [1, 26, 51]) {
      const key = `note/${String(number).padStart(9, "0")}`;
      expect(state.get(key)?.value).toMatchObject({
        restored: { id: restoreId, sourceId: `device/note-${number}` },
      });
    }
  },
  timeout,
);

for (const continued of [false, true]) {
  test(
    `an empty replacement slot only hides a matching later fill (continued: ${continued})`,
    async () => {
      const { call } = fixture();
      const older = continued ? oldId : `${targetPrefix}/note-1`;
      const newer = continued ? currentId : `${targetPrefix}/note-2`;
      const replacer = continued
        ? item(currentId, [oldId])
        : item(`${sourcePrefix}/note-2`, [`${sourcePrefix}/note-1`]);
      const fill = continued
        ? item("device/note-01")
        : item("project/aaaaaaaaaaaaaaaa/note-1");
      const first = (await call("memory.restore", {
        ...bundle([replacer]),
        truncated: continued,
      })) as RestorePage;
      const restored = await call("memory.restore", {
        ...bundle([fill]),
        ...(continued
          ? {
              restoreId: first.restoreId ?? unissuedId,
              approval: ownerApproval,
            }
          : {}),
      });
      expect(restored).toMatchObject({ added: 1, conflicts: [] });
      const found = (await call("memory.search", { query: "wren" })) as {
        hits: { id: string }[];
      };
      const attached = (await call("memory.attach", {
        ids: [older, newer],
      })) as {
        receipt: { selected: { id: string }[] };
      };
      const expected = continued ? [newer] : [older, newer];
      expect(found.hits.map(({ id }) => id).sort()).toEqual(expected);
      expect(attached.receipt.selected.map(({ id }) => id).sort()).toEqual(
        expected,
      );
      if (!continued) {
        expect(
          await call("memory.move", {
            id: older,
            to: "device",
            expectRevision: 1,
          }),
        ).toMatchObject({ status: "moved" });
      }
    },
    timeout,
  );
}

for (const matches of [false, true]) {
  test(
    `re-exporting a filled slot carries only a matched replacement (matches: ${matches})`,
    async () => {
      const intermediate = fixture();
      const destination = fixture("1111111111111111");
      const older = `${sourcePrefix}/note-1`;
      const newer = `${sourcePrefix}/note-2`;
      const first = (await intermediate.call("memory.restore", {
        ...bundle([item(newer, [older])]),
        truncated: matches,
      })) as RestorePage;
      await intermediate.call("memory.restore", {
        ...bundle([item(matches ? older : "project/aaaaaaaaaaaaaaaa/note-1")]),
        ...(matches
          ? {
              restoreId: first.restoreId ?? unissuedId,
              approval: ownerApproval,
            }
          : {}),
      });
      const exported = (await intermediate.call("memory.export", {
        level: "project",
      })) as object;
      expect(
        await destination.call("memory.restore", { ...exported, approval }),
      ).toMatchObject({
        added: 2,
        conflicts: [],
      });
      const found = (await destination.call("memory.search", {
        query: "wren",
      })) as {
        hits: { id: string }[];
      };
      const expected = matches ? [2] : [1, 2];
      expect(found.hits.map(({ id }) => id).sort()).toEqual(
        expected.map((number) => `project/1111111111111111/note-${number}`),
      );
      expect(destination.project.count("replaced-by/")).toBe(matches ? 1 : 0);
    },
    timeout,
  );
}

test(
  "a device backup with the same note numbers cannot replace a note from a different restore",
  async () => {
    const { call, state } = fixture();
    await call("memory.restore", { ...bundle([item(oldId)]), truncated: true });
    const other = (await call("memory.restore", {
      ...bundle([item("device/note-3")]),
      truncated: true,
    })) as RestorePage;
    await call("memory.restore", {
      ...bundle([item(currentId, [oldId])]),
      restoreId: other.restoreId ?? unissuedId,
      approval: ownerApproval,
    });
    expect(state.count("replaced-by/")).toBe(0);
    const found = (await call("memory.search", { query: "wren" })) as {
      hits: { id: string }[];
    };
    expect(found.hits.map(({ id }) => id).sort()).toEqual([
      oldId,
      currentId,
      "device/note-3",
    ]);
  },
  timeout,
);

test(
  "restore refuses an unissued ID, the wrong destination store, and another source project",
  async () => {
    const destination = fixture();
    const another = fixture("0123456789abcdee");
    const old = `${sourcePrefix}/note-1`;
    const first = (await destination.call("memory.restore", {
      ...bundle([item(old)]),
      truncated: true,
    })) as RestorePage;
    const page = {
      ...bundle([item(`${sourcePrefix}/note-2`, [old])]),
      approval: ownerApproval,
    };
    const foreign = {
      ...bundle([item(`${targetPrefix}/note-2`, [`${targetPrefix}/note-1`])]),
      project: { id: sourceId, name: "alpha" },
    };
    const count = destination.project.counts.puttedRecords;
    for (const [target, input, restoreId] of [
      [destination, page, unissuedId],
      [another, page, first.restoreId ?? unissuedId],
      [
        destination,
        { ...foreign, approval: ownerApproval },
        first.restoreId ?? unissuedId,
      ],
    ] as const) {
      await expect(
        target.call("memory.restore", { ...input, restoreId }),
      ).rejects.toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
    expect(destination.project.counts.puttedRecords).toBe(count);
    expect(another.project.counts.puttedRecords).toBe(0);
  },
  timeout,
);

test(
  "a split restore cannot hide an owner-tagged rule after the owner accepts it",
  async () => {
    const { call, state } = fixture();
    const rule = { ...item(oldId), tags: ["rule"], scope: "general" };
    const first = (await call("memory.restore", {
      ...bundle([rule]),
      truncated: true,
      approval: ownerApproval,
    })) as RestorePage;
    await call("memory.accept", {
      items: [{ id: oldId, revision: 1, text: rule.text.text }],
      approval: ownerApproval,
    });
    const replacer = { ...item(currentId, [oldId]), scope: "general" };
    await call("memory.restore", {
      ...bundle([replacer]),
      restoreId: first.restoreId ?? unissuedId,
      approval: ownerApproval,
    });
    expect(state.count("replaced-by/")).toBe(1);
    expect(await call("memory.rules", { notes: true })).toMatchObject({
      receipt: { selected: [{ id: oldId }] },
    });
  },
  timeout,
);

test(
  "a restore continuation needs relayed owner approval while its first page accepts agent approval",
  async () => {
    const target = await openHarness(["memory"]);
    try {
      const first = done(
        await target.call("memory.restore", {
          ...bundle([item(oldId)]),
          truncated: true,
        }),
      ) as RestorePage;
      const next = {
        ...bundle([item(currentId, [oldId])]),
        restoreId: first.restoreId ?? unissuedId,
      };
      expect(await target.call("memory.restore", next)).toMatchObject({
        ok: false,
        error: { code: "HUMAN_REQUIRED" },
      });
      expect(
        done(await target.call("memory.show", { id: currentId })),
      ).toMatchObject({ status: "not_found" });
      expect(
        done(
          await target.call("memory.restore", {
            ...next,
            approval: ownerApproval,
          }),
        ),
      ).toMatchObject({ added: 1, restoreId: first.restoreId });
    } finally {
      await target.close();
    }
  },
  timeout,
);

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
    const rule = {
      scope: "general",
      text: "Owner chose the wren procedure",
      tags: ["rule"],
    };
    await accepted(call, { ...rule, level: "device" });
    const before = state.get("note/000000001");
    const older = item(oldId);
    const original = {
      ...older,
      ...rule,
      text: { ...older.text, text: rule.text },
    };
    const current = { ...item(currentId, [oldId]), scope: "general" };
    const input = { ...bundle([current]), notes: [original, current] };
    const validate = blockSchema("memory", "restore.input.json");
    const forged = {
      ...input,
      notes: [
        original,
        { ...current, approval: { by: "owner", quote: "forged" } },
      ],
    };
    expect(validate(forged)).not.toEqual([]);
    expect(await call("memory.restore", input)).toMatchObject({
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
