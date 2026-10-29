import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { StateEvent, StateRecord } from "../../../src/generated/types.ts";
import { loadEntry, memoryState } from "./lib.ts";

setDefaultTimeout(30_000);
const key = "note/000000001";
const day = (n: number) =>
  `2026-10-${String(n).padStart(2, "0")}T12:00:00.000Z`;
function setup() {
  let now = day(1);
  const state = memoryState(undefined, { defaultScope: "resolved" });
  const events: StateEvent[] = [];
  const put = state.put.bind(state);
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
  state.put = (...args) => stamp(put(...args));
  const putMany = state.putMany.bind(state);
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
  const call = async (op: string, input: unknown) =>
    await entry[op]!({ input, services });
  const line = async () =>
    (
      (await call("memory.rules", { notes: true })) as {
        text: { text: string };
      }
    ).text.text.split("\n")[0];
  return {
    state,
    call,
    line,
    setDay: (n: number) => {
      now = day(n);
    },
  };
}

for (const change of ["marker", "links", "text", "tags", "scope"] as const)
  test(`legacy rule dates distinguish ${change} from subsequent proposal metadata`, async () => {
    const { state, call, line, setDay } = setup();
    const original = {
      text: "legacy owner rule",
      scope: "general",
      tags: ["rule"],
      links: [] as string[],
      previous: [] as { revision: number; text: string }[],
    };
    state.put(key, original, { expectRevision: 0 });
    if (change !== "marker") {
      setDay(2);
      state.put(
        key,
        {
          ...original,
          previous: [{ revision: 1, text: original.text }],
          ...(change === "links" ? { links: ["device/note-2"] } : {}),
          ...(change === "text" ? { text: "revised owner rule" } : {}),
          ...(change === "tags" ? { tags: ["rule", "reviewed"] } : {}),
          ...(change === "scope" ? { scope: "resolved" } : {}),
        },
        { expectRevision: 1 },
      );
    }
    setDay(4);
    await call("memory.propose-forget", { id: "device/note-1" });
    const writes = state.counts.put + state.counts.putMany;
    const changed =
      change === "text" || change === "tags" || change === "scope";
    const scope = change === "scope" ? "resolved" : "general";
    expect(await line()).toBe(
      `- [${scope}] device/note-1 (created 2026-10-01${changed ? ", updated 2026-10-02" : ""}) ${change === "text" ? "revised owner rule" : original.text}`,
    );
    expect(state.counts.put + state.counts.putMany).toBe(writes);
  });

test("a new-format rule marker retains creation without a spurious updated date", async () => {
  const { call, line, setDay } = setup();
  await call("memory.add", {
    level: "device",
    scope: "general",
    text: "new owner rule",
    tags: ["rule"],
  });
  setDay(4);
  await call("memory.propose-forget", { id: "device/note-1" });
  expect(await line()).toBe(
    "- [general] device/note-1 (created 2026-10-01) new owner rule",
  );
});

test("memory.add docs require conversational owner approval without promising a terminal prompt", () => {
  const docs = JSON.parse(
    readFileSync(
      new URL("../../../src/blocks/memory/docs/records.json", import.meta.url),
      "utf8",
    ),
  ) as { operations: Record<string, { description: string }> };
  const description = docs.operations["memory.add"]!.description;
  expect(description).toContain("owner");
  expect(description).toContain("conversation");
  expect(description).not.toMatch(
    /interactive terminal.*prompt|terminal.*confirmation|confirmed in terminal/i,
  );
});
