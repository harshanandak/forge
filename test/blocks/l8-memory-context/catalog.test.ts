import { afterEach, expect, test } from "bun:test";
import { resolveBlock } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { openHarness, type Harness } from "./lib.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("both blocks are registered first-party sources that resolve to their folders", () => {
  expect(Object.keys(firstPartyBlocks)).toContain("forge/memory");
  expect(Object.keys(firstPartyBlocks)).toContain("forge/context");
  expect(
    resolveBlock("/unused", { builtin: "forge/memory" }).replaceAll("\\", "/"),
  ).toMatch(/src\/blocks\/memory\/?$/);
  expect(
    resolveBlock("/unused", { builtin: "forge/context" }).replaceAll("\\", "/"),
  ).toMatch(/src\/blocks\/context\/?$/);
}, 30_000);

const operations = {
  "memory.add": { effects: ["memory:write"], humanOnly: false },
  "memory.search": { effects: [], humanOnly: false },
  "memory.show": { effects: [], humanOnly: false },
  "memory.forget": { effects: ["memory:write"], humanOnly: true },
  "memory.export": { effects: [], humanOnly: false },
  "memory.restore": { effects: ["memory:write"], humanOnly: true },
  "decision.propose": { effects: ["decision:write"], humanOnly: false },
  "decision.adopt": { effects: ["decision:write"], humanOnly: true },
  "decision.list": { effects: [], humanOnly: false },
  "context.handoff": { effects: ["context:write"], humanOnly: false },
  "context.show": { effects: [], humanOnly: false },
} as const;

test("every operation is fully described in the catalog, so any surface can be generated from it", async () => {
  harness = await openHarness(["memory", "context"]);
  const listed = harness.assembly.catalog.list();
  const mine = listed.filter((entry) => entry.op in operations);
  expect(mine.map((entry) => entry.op).sort()).toEqual(
    Object.keys(operations).sort(),
  );
  for (const entry of mine) {
    const expected = operations[entry.op as keyof typeof operations];
    expect(entry.declaration.effects).toEqual(expected.effects);
    expect(entry.declaration.callers.includes("agent")).toBe(
      !expected.humanOnly,
    );
    expect(entry.declaration.context).not.toBe("leased");
    expect(entry.declaration.stability).toBe("stable");
    expect(entry.docs.title.length).toBeGreaterThan(0);
    expect(entry.docs.summary.length).toBeGreaterThan(0);
    expect(entry.inputSchema.type).toBe("object");
    expect(entry.outputSchema?.type).toBe("object");
    expect(entry.admitted).toBe(true);
  }
  // Notes work on the device alone; decisions and handoffs belong to the project.
  const context = (op: string) =>
    mine.find((entry) => entry.op === op)?.declaration.context;
  expect(context("memory.add")).toBe("device");
  expect(context("memory.search")).toBe("device");
  expect(context("decision.propose")).toBe("project");
  expect(context("context.handoff")).toBe("project");
  expect(context("context.show")).toBe("project");
}, 60_000);
