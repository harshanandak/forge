import { expect, setDefaultTimeout, test } from "bun:test";
import type { StateEvent, StateRecord } from "../../../src/generated/types.ts";
import { loadEntry, memoryState, ownerApproval } from "./lib.ts";

setDefaultTimeout(30_000);
const key = "note/000000001";
const day = (n: number) =>
  `2026-10-${String(n).padStart(2, "0")}T12:00:00.000Z`;
function setup() {
  let now = day(1);
  const state = memoryState(undefined, { defaultScope: "resolved" });
  const events: StateEvent[] = [];
  const stamp = (record: StateRecord) => {
    Object.assign(record, { updatedAt: now });
    events.push({
      type: "put",
      namespace: "forge/memory",
      key: record.key,
      revision: record.revision,
      at: now,
      actor: record.updatedBy,
      data: record.value,
    });
    return record;
  };
  const put = state.put.bind(state);
  const putMany = state.putMany.bind(state);
  state.put = (...args) => stamp(put(...args));
  state.putMany = (...args) => putMany(...args).map(stamp);
  state.history = (options) =>
    events
      .filter(
        (event) =>
          event.key === options.key &&
          event.revision < (options.before ?? Infinity),
      )
      .reverse()
      .slice(0, options.limit);
  const entry = loadEntry("memory", undefined, {
    Date: class extends Date {
      constructor() {
        super(now);
      }
    },
  });
  const services = { state, levels: state };
  const call = async (op: string, input: unknown, config = {}) =>
    await entry[op]!({ input, config, services });
  return {
    state,
    call,
    setDay: (n: number) => {
      now = day(n);
    },
    setTime: (time: string) => {
      now = new Date(time).toISOString();
    },
  };
}

test("new notes durably retain creation time beyond retained versions and expose it in show/search", async () => {
  const { state, call, setDay } = setup();
  await call("memory.add", {
    level: "device",
    text: "retained original",
    tags: ["rule"],
  });
  expect(state.get(key)!.value).toMatchObject({ createdAt: day(1) });
  for (let n = 2; n <= 9; n++) {
    setDay(n);
    await call("memory.add", { id: "note-1", text: `retained edit ${n}` });
  }
  expect(state.get(key)!.value).toMatchObject({ createdAt: day(1) });
  expect(await call("memory.show", { id: "note-1" })).toMatchObject({
    note: { createdAt: day(1), updatedAt: day(9) },
  });
  expect(await call("memory.search", { query: "retained" })).toMatchObject({
    hits: [{ createdAt: day(1), updatedAt: day(9) }],
  });
  expect(
    JSON.stringify(await call("memory.show", { id: "note-1" })),
  ).not.toContain('"createdAtApprox":true');
});

test("legacy creation time uses the oldest retained version and marks approximation without backfilling", async () => {
  const { state, call, setDay } = setup();
  for (let n = 1; n <= 9; n++) {
    setDay(n);
    state.put(
      key,
      {
        text: `legacy ${n}`,
        tags: ["rule"],
        links: [],
        previous: Array.from({ length: Math.min(5, n - 1) }, (_, i) => {
          const revision = n - Math.min(5, n - 1) + i;
          return { revision, text: `legacy ${revision}` };
        }),
      },
      { expectRevision: n - 1 },
    );
  }
  const writes = state.counts.put + state.counts.putMany;
  expect(await call("memory.show", { id: "note-1" })).toMatchObject({
    note: { createdAt: day(4), createdAtApprox: true, updatedAt: day(9) },
  });
  expect(await call("memory.search", { query: "legacy" })).toMatchObject({
    hits: [{ createdAt: day(4), createdAtApprox: true }],
  });
  expect(state.counts.put + state.counts.putMany).toBe(writes);
  expect(state.get(key)!.value).not.toHaveProperty("createdAt");
});

test("rule lines carry ids and UTC creation/change dates while ignoring metadata and links-only updates", async () => {
  const { call, setDay, setTime } = setup();
  setTime("2026-10-01T23:30:00-05:00");
  await call("memory.add", {
    level: "device",
    scope: "general",
    text: "owner\n rule",
    tags: ["rule"],
  });
  const line = async () =>
    (
      (await call("memory.rules", { notes: true })) as {
        text: { text: string };
      }
    ).text.text.split("\n")[0];
  expect(await line()).toBe(
    "- [general] device/note-1 (created 2026-10-02) owner rule",
  );
  setDay(3);
  await call("memory.add", {
    id: "note-1",
    text: "owner\n rule",
    links: ["device/note-2"],
  });
  for (let n = 0; n < 4; n++) {
    await call("memory.propose-forget", { id: "note-1" });
    await call("memory.propose-forget", { id: "note-1", withdraw: true });
  }
  await call("memory.forget", { id: "note-1", approval: ownerApproval });
  await call("memory.forget", {
    id: "note-1",
    undo: true,
    approval: ownerApproval,
  });
  expect(await line()).toBe(
    "- [general] device/note-1 (created 2026-10-02) owner rule",
  );
  setDay(4);
  await call("memory.add", { id: "note-1", text: "changed rule" });
  expect(await line()).toBe(
    "- [general] device/note-1 (created 2026-10-02, updated 2026-10-04) changed rule",
  );
  setDay(5);
  await call("memory.add", {
    id: "note-1",
    text: "changed rule",
    tags: ["rule", "new"],
  });
  expect(await line()).toContain("updated 2026-10-05");
  setDay(6);
  await call("memory.add", {
    id: "note-1",
    text: "changed rule",
    scope: "resolved",
  });
  expect(await line()).toBe(
    "- [resolved] device/note-1 (created 2026-10-02, updated 2026-10-06) changed rule",
  );
});

test("the 6000 rule budget includes complete prefixes, ids, dates and separators while pointer stays identical", async () => {
  const { call } = setup();
  const prefix = "- [general] device/note-1 (created 2026-10-01) ";
  await call("memory.add", {
    level: "device",
    scope: "general",
    text: "x".repeat(6000 - prefix.length),
    tags: ["rule"],
  });
  await call("memory.add", {
    level: "device",
    scope: "general",
    text: "extra",
    tags: ["rule"],
  });
  const pointer =
    'Forge memory notes: general 2, resolved 0.\nBefore a task, search memory for its topic; prefer hits scoped resolved or general.\nforge memory search "<topic>"\nforge memory show <id>';
  expect(await call("memory.rules", {})).toEqual({
    text: { kind: "untrusted", source: "memory:rules", text: pointer },
    receipt: {
      selected: [],
      omitted: [],
      packet: {
        utf8Bytes: Buffer.byteLength(pointer, "utf8"),
        characters: [...pointer].length,
        characterUnit: "Unicode code points",
      },
      cap: {
        limit: 6000,
        used: 0,
        unit: "UTF-16 code units",
        includes: "accepted rule lines and newline separators",
        excludes: "omission line and pointer",
      },
      warnings: [],
    },
  });
  const text = (
    (await call("memory.rules", { notes: true })) as { text: { text: string } }
  ).text.text;
  const lines = text.split("\n").filter((line) => line.startsWith("- ["));
  expect(lines.join("\n").length).toBeLessThanOrEqual(6000);
  expect(lines).toEqual([prefix + "x".repeat(6000 - prefix.length)]);
  expect(text).toEndWith(
    `1 more rule notes did not fit; search them.\n${pointer}`,
  );
});

test("show retains every version timestamp and only its approval after metadata churn; forget keeps explicit who/time", async () => {
  const { call, setDay } = setup();
  await call("memory.add", { level: "device", text: "first", tags: ["rule"] });
  setDay(2);
  await call("memory.add", {
    id: "note-1",
    text: "approved",
    tags: [],
    approval: ownerApproval,
  });
  setDay(3);
  await call("memory.add", { id: "note-1", text: "third" });
  setDay(4);
  for (let n = 0; n < 4; n++) {
    await call("memory.propose-forget", { id: "note-1" });
    await call("memory.propose-forget", { id: "note-1", withdraw: true });
  }
  const shown = (await call("memory.show", { id: "note-1" })) as {
    note: { versions: { revision: number; at: string; approval?: unknown }[] };
  };
  expect(shown.note.versions).toMatchObject([
    { revision: 1, at: day(1) },
    {
      revision: 2,
      at: day(2),
      approval: {
        by: "owner",
        quote: { kind: "untrusted", text: ownerApproval.quote },
        at: day(2),
      },
    },
    { revision: 3, at: day(3) },
  ]);
  expect(shown.note.versions[0]).not.toHaveProperty("approval");
  expect(shown.note.versions[2]).not.toHaveProperty("approval");
  await call("memory.forget", { id: "note-1", approval: ownerApproval });
  expect(await call("memory.show", { id: "note-1" })).toMatchObject({
    status: "forgotten",
    approval: { by: "owner", quote: { text: ownerApproval.quote }, at: day(4) },
  });
});

test("decision list keeps original proposed time and adopted time with approval", async () => {
  const { call, setDay } = setup();
  await call(
    "decision.propose",
    { title: "Record", text: "Choose the design" },
    { decisions: { idPattern: "D-NNN" } },
  );
  expect(await call("decision.list", {})).toMatchObject({
    decisions: [{ proposedAt: day(1) }],
  });
  setDay(4);
  await call("decision.adopt", { id: "D-001", approval: ownerApproval });
  expect(await call("decision.list", {})).toMatchObject({
    decisions: [
      {
        proposedAt: day(1),
        adoptedAt: day(4),
        approval: {
          by: "owner",
          quote: { kind: "untrusted", text: ownerApproval.quote },
          at: day(4),
        },
      },
    ],
  });
});
