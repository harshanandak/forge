import { afterEach, expect, test } from "bun:test";
import { resolveBlock } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { renderSkills } from "../../../src/surface/skills.ts";
import { openHarness, type Harness } from "./lib.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("forge/memory is a registered first-party source that resolves to its folder", () => {
  expect(Object.keys(firstPartyBlocks)).toContain("forge/memory");
  expect(
    resolveBlock("/unused", { builtin: "forge/memory" }).replaceAll("\\", "/"),
  ).toMatch(/src\/blocks\/memory\/?$/);
}, 30_000);

const operations = {
  "memory.scope": { effects: [], humanOnly: false },
  "memory.add": { effects: ["memory:write"], humanOnly: false },
  "memory.search": { effects: [], humanOnly: false },
  "memory.rules": { effects: [], humanOnly: false },
  "memory.show": { effects: [], humanOnly: false },
  "memory.propose-forget": { effects: ["memory:write"], humanOnly: false },
  "memory.forget": { effects: ["memory:write"], humanOnly: false },
  "memory.export": { effects: [], humanOnly: false },
  "memory.restore": { effects: ["memory:write"], humanOnly: false },
  "decision.propose": { effects: ["decision:write"], humanOnly: false },
  "decision.adopt": { effects: ["decision:write"], humanOnly: false },
  "decision.list": { effects: [], humanOnly: false },
} as const;

test("every operation is fully described in the catalog, so any surface can be generated from it", async () => {
  harness = await openHarness(["memory"]);
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
  // Notes work on the device alone; decisions belong to the project.
  const context = (op: string) =>
    mine.find((entry) => entry.op === op)?.declaration.context;
  expect(context("memory.add")).toBe("device");
  expect(context("memory.search")).toBe("device");
  expect(context("memory.rules")).toBe("device");
  expect(context("decision.propose")).toBe("project");
}, 60_000);

test("scope rejects notes while rules retains its opt-in input", async () => {
  harness = await openHarness(["memory"]);
  const scope = await harness.call("memory.scope", { notes: true });
  expect(scope.ok).toBe(false);
  if (!scope.ok) expect(scope.error.code).toBe("INPUT_INVALID");
  expect((await harness.call("memory.scope", {})).ok).toBe(true);
  expect((await harness.call("memory.rules", { notes: true })).ok).toBe(true);
}, 60_000);

test("scope input and generated skill retain the baseline empty-input contract", async () => {
  harness = await openHarness(["memory"]);
  const scope = harness.assembly.catalog
    .list()
    .find((entry) => entry.op === "memory.scope")!;
  const baselineInput = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  expect(scope.inputSchema).toEqual(baselineInput);
  expect(renderSkills([scope])).toEqual(
    renderSkills([{ ...scope, inputSchema: baselineInput }]),
  );
}, 60_000);
