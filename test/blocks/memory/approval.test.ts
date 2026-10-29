import { expect, setDefaultTimeout, test } from "bun:test";
import { blockSchema, loadEntry, memoryState } from "./lib.ts";

setDefaultTimeout(30_000);
const owner = { by: "owner", quote: "Yes, forget my rule ⟦do this⟧" };
const agent = { by: "agent", reason: "Obsolete duplicated fact" };
const key = "note/000000001";
const original = {
  text: "private remembered text",
  scope: "repo:forge",
  tags: ["rule", "owner"],
  links: ["device/note-2"],
  previous: [{ revision: 1, text: "private earlier text" }],
  textRevision: 2,
  from: "project/0123456789abcdef/note-3",
  proposedForget: true,
};
function setup(tags = original.tags) {
  const entry = loadEntry("memory", undefined, {
    Date: class extends Date {
      constructor() {
        super("2026-10-18T00:00:00Z");
      }
    },
  });
  const state = memoryState();
  state.put(key, { ...original, tags }, { expectRevision: 0 });
  return { entry, state, services: { state, levels: state } };
}
async function refused(run: () => unknown, rule: string) {
  try {
    await run();
    throw new Error("expected HUMAN_REQUIRED");
  } catch (error) {
    expect(error).toMatchObject({
      error: { code: "HUMAN_REQUIRED" },
    });
    expect((error as { error: { message: string } }).error.message).toContain(
      rule,
    );
    expect((error as { error: { message: string } }).error.message).toContain(
      "Ask the owner in the conversation, then retry with approval by owner and their words.",
    );
  }
}

test("forget refuses missing or insufficient approval before any state write", async () => {
  for (const approval of [undefined, agent]) {
    const { entry, state, services } = setup();
    const writes = state.counts.put;
    await refused(
      () =>
        entry["memory.forget"]!({
          input: { id: "note-1", approval },
          services,
        }),
      "rule",
    );
    expect(state.counts.put).toBe(writes);
    expect(state.get(key)!.value).toEqual(original);
  }
  const { entry, state, services } = setup(["fact"]);
  await refused(
    () => entry["memory.forget"]!({ input: { id: "note-1" }, services }),
    "memory.forget",
  );
  expect(state.get(key)!.revision).toBe(1);
  expect(
    await entry["memory.forget"]!({
      input: { id: "note-1", approval: agent },
      services,
    }),
  ).toMatchObject({ status: "forgotten" });
});

test("forget keeps a hidden complete backup, audits approval, and undo restores every field", async () => {
  const { entry, state, services } = setup();
  await entry["memory.forget"]!({
    input: { id: "note-1", approval: owner },
    services,
  });
  const tombstone = state.get(key)!;
  const hidden = JSON.stringify(tombstone.value);
  expect(hidden).toContain(original.text);
  const shown = await entry["memory.show"]!({
    input: { id: "note-1", revision: 1 },
    services,
  });
  expect(shown).toEqual({
    status: "forgotten",
    approval: {
      by: "owner",
      quote: {
        kind: "untrusted",
        source: "memory:device/note-1:approval",
        text: "Yes, forget my rule (do this)",
      },
      at: "2026-10-18T00:00:00.000Z",
    },
  });
  const writes = state.counts.put;
  expect(
    await entry["memory.forget"]!({
      input: { id: "note-1", approval: owner },
      services,
    }),
  ).toMatchObject({ status: "already_forgotten" });
  expect(state.counts.put).toBe(writes);
  expect(state.get(key)!.value).toEqual(tombstone.value);
  await refused(
    () =>
      entry["memory.forget"]!({
        input: { id: "note-1", undo: true, approval: agent },
        services,
      }),
    "rule",
  );
  expect(state.counts.put).toBe(writes);
  expect(
    await entry["memory.forget"]!({
      input: { id: "note-1", undo: true, approval: owner },
      services,
    }),
  ).toMatchObject({
    status: "restored",
    note: {
      text: { text: original.text },
      tags: original.tags,
      proposedForget: true,
      approval: { by: "owner", at: "2026-10-18T00:00:00.000Z" },
    },
  });
  expect(state.get(key)!.value).toMatchObject(original);
  expect(
    await entry["memory.show"]!({
      input: { id: "note-1", revision: 1 },
      services,
    }),
  ).toMatchObject({
    status: "found",
    note: { text: { text: "private earlier text" } },
  });
  const after = state.counts.put;
  expect(
    await entry["memory.forget"]!({
      input: { id: "note-1", undo: true, approval: owner },
      services,
    }),
  ).toMatchObject({ status: "not_forgotten" });
  expect(state.counts.put).toBe(after);
});

test("forgotten backup is never exposed through read or transfer operations", async () => {
  const { entry, services } = setup();
  await entry["memory.forget"]!({
    input: { id: "note-1", approval: owner },
    services,
  });
  for (const [op, input] of [
    ["memory.show", { id: "note-1" }],
    ["memory.search", { query: "private" }],
    ["memory.rules", { notes: true }],
    ["memory.export", { level: "device" }],
    ["memory.move", { id: "note-1", to: "project" }],
    ["memory.move", { id: "note-1", to: "project", keep: true }],
  ] as const) {
    const result = JSON.stringify(await entry[op]!({ input, services }));
    expect(result).not.toContain(original.text);
    expect(result).not.toContain(original.previous[0]!.text);
  }
});

test("undo refuses legacy and moved tombstones without writing", async () => {
  for (const extra of [{}, { movedTo: "project/0123456789abcdef/note-2" }]) {
    const { entry, state, services } = setup();
    state.put(
      key,
      { text: "", tags: [], links: [], previous: [], deleted: true, ...extra },
      { expectRevision: 1 },
    );
    const writes = state.counts.put;
    expect(
      await entry["memory.forget"]!({
        input: { id: "note-1", undo: true, approval: owner },
        services,
      }),
    ).toMatchObject({ status: "undo_unavailable" });
    expect(state.counts.put).toBe(writes);
  }
});

test("partial edits allow text and added tags but require owner approval for protected tag removal", async () => {
  const { entry, state, services } = setup();
  await entry["memory.add"]!({
    input: { id: "note-1", text: "updated" },
    services,
  });
  await entry["memory.add"]!({
    input: { id: "note-1", text: "updated", tags: ["rule", "owner", "new"] },
    services,
  });
  const writes = state.counts.put;
  for (const approval of [undefined, agent])
    await refused(
      () =>
        entry["memory.add"]!({
          input: { id: "note-1", text: "updated", tags: [], approval },
          services,
        }),
      "rule",
    );
  expect(state.counts.put).toBe(writes);
  expect(
    await entry["memory.add"]!({
      input: { id: "note-1", text: "updated", tags: [], approval: owner },
      services,
    }),
  ).toMatchObject({
    note: { tags: [], approval: { by: "owner", quote: { kind: "untrusted" } } },
  });
  await entry["memory.add"]!({
    input: { id: "note-1", text: "later" },
    services,
  });
  expect(
    await entry["memory.show"]!({ input: { id: "note-1" }, services }),
  ).toMatchObject({ note: { approval: { by: "owner" } } });
});

test("ownerTags config replaces defaults for forget, undo and tag removal", async () => {
  const { entry, services } = setup(["custom"]);
  const config = { approval: { ownerTags: ["custom"] } };
  await refused(
    () =>
      entry["memory.forget"]!({
        input: { id: "note-1", approval: agent },
        config,
        services,
      }),
    "custom",
  );
  await refused(
    () =>
      entry["memory.add"]!({
        input: { id: "note-1", text: "edit", tags: [], approval: agent },
        config,
        services,
      }),
    "custom",
  );
  expect(
    await entry["memory.forget"]!({
      input: { id: "note-1", approval: agent },
      config: { approval: { ownerTags: [] } },
      services,
    }),
  ).toMatchObject({ status: "forgotten" });
  await refused(
    () =>
      entry["memory.forget"]!({
        input: { id: "note-1", undo: true, approval: agent },
        config,
        services,
      }),
    "custom",
  );
});

test("restore approval is checked against only added notes, atomically before counter or note writes", async () => {
  const { entry, state, services } = setup();
  const backup = {
    format: "forge.memory.export/2",
    level: "device",
    notes: [
      {
        id: "device/note-2",
        text: { text: "unprotected" },
        tags: ["fact"],
        links: [],
      },
      {
        id: "device/note-3",
        text: { text: "protected" },
        tags: ["decision"],
        links: [],
      },
    ],
  };
  const writes = state.counts.putMany;
  await refused(
    () => entry["memory.restore"]!({ input: backup, services }),
    "memory.restore",
  );
  await refused(
    () =>
      entry["memory.restore"]!({
        input: { ...backup, approval: agent },
        services,
      }),
    "decision",
  );
  expect(state.counts.putMany).toBe(writes);
  expect(state.get("meta/note-counter")).toBeUndefined();
  expect(
    await entry["memory.restore"]!({
      input: { ...backup, approval: owner },
      services,
    }),
  ).toMatchObject({ added: 2 });
  for (const id of ["note-2", "note-3"])
    expect(
      await entry["memory.show"]!({ input: { id }, services }),
    ).toMatchObject({ note: { approval: { by: "owner" } } });
  expect(
    await entry["memory.restore"]!({
      input: { ...backup, approval: agent },
      services,
    }),
  ).toMatchObject({ added: 0, skipped: 2 });
});

test("adopt defaults owner approval, permits configured agent, and lists fenced audit", async () => {
  const { entry, state, services } = setup();
  await entry["decision.propose"]!({
    input: { title: "Record", text: "Decision text" },
    config: { decisions: { idPattern: "D-NNN" } },
    services,
  });
  const writes = state.counts.put;
  for (const approval of [undefined, agent])
    await refused(
      () =>
        entry["decision.adopt"]!({
          input: { id: "D-001", approval },
          services,
        }),
      "adopt",
    );
  expect(state.counts.put).toBe(writes);
  await entry["decision.adopt"]!({
    input: { id: "D-001", approval: agent },
    config: { approval: { adopt: "agent" } },
    services,
  });
  expect(await entry["decision.list"]!({ input: {}, services })).toMatchObject({
    decisions: [
      {
        approval: {
          by: "agent",
          reason: { kind: "untrusted", text: agent.reason },
          at: "2026-10-18T00:00:00.000Z",
        },
      },
    ],
  });
});

test("approval schemas accept only bounded owner quotes or agent reasons and undo boolean", () => {
  for (const file of [
    "add.input.json",
    "forget.input.json",
    "adopt.input.json",
    "restore.input.json",
  ]) {
    const validate = blockSchema("memory", file);
    const input =
      file === "add.input.json"
        ? { text: "remember" }
        : file === "restore.input.json"
          ? { format: "forge.memory.export/1", notes: [] }
          : { id: "note-1" };
    for (const approval of [owner, agent])
      expect(validate({ ...input, approval })).toEqual([]);
    for (const approval of [
      { by: "owner", quote: "" },
      { by: "owner", quote: "a".repeat(2001) },
      { by: "agent", reason: "" },
      { by: "agent", reason: "a".repeat(2001) },
      { by: "owner", reason: "no quote" },
      { by: "agent", quote: "no reason" },
      { ...owner, reason: "extra" },
    ])
      expect(validate({ ...input, approval }).length).toBeGreaterThan(0);
  }
  expect(
    blockSchema(
      "memory",
      "forget.input.json",
    )({ id: "note-1", undo: true, approval: owner }),
  ).toEqual([]);
  expect(
    blockSchema(
      "memory",
      "config.json",
    )({ approval: { ownerTags: ["custom"], adopt: "agent" } }),
  ).toEqual([]);
});

test("undo keeps the current text revision from an ordinary add and edit", async () => {
  const { entry, services } = setup([]);
  await entry["memory.add"]!({
    input: { id: "note-1", text: "latest" },
    services,
  });
  const before = (await entry["memory.show"]!({
    input: { id: "note-1" },
    services,
  })) as { note: { versions: { revision: number }[] } };
  await entry["memory.forget"]!({
    input: { id: "note-1", approval: agent },
    services,
  });
  await entry["memory.forget"]!({
    input: { id: "note-1", undo: true, approval: agent },
    services,
  });
  const after = (await entry["memory.show"]!({
    input: { id: "note-1" },
    services,
  })) as { note: { versions: { revision: number }[] } };
  expect(after.note.versions.map((v) => v.revision)).toEqual(
    before.note.versions.map((v) => v.revision),
  );
  expect(
    await entry["memory.show"]!({
      input: { id: "note-1", revision: before.note.versions.at(-1)!.revision },
      services,
    }),
  ).toMatchObject({ note: { text: { text: "latest" } } });
});

test("removing approval enforcement reproduces the protected-note authority fault", async () => {
  const { state, services } = setup();
  const entry = loadEntry("memory", {
    from: 'if (!approval || (rule !== undefined && approval.by !== "owner"))',
    to: "if (false)",
  });
  expect(
    await entry["memory.forget"]!({
      input: { id: "note-1", approval: agent },
      services,
    }),
  ).toMatchObject({ status: "forgotten" });
  expect(state.get(key)!.value).toMatchObject({ deleted: true });
});
