import { expect, setDefaultTimeout, test } from "bun:test";
import { resolveComposition } from "../../src/contract/composition.ts";
import { nameDistance } from "../../src/contract/distance.ts";
import type {
  BlockManifest,
  ConfigDocument,
} from "../../src/generated/types.ts";
import { validateConfigDocument } from "../../src/generated/validators.ts";

setDefaultTimeout(10_000);

test("bounded spelling distance preserves close matches and caps distant names", () => {
  for (const [a, b, distance] of [
    ["", "", 0],
    ["", "ab", 2],
    ["sample.create", "sample.craete", 2],
    ["abc", "abcde", 2],
    ["abcde", "abc", 2],
    ["kitten", "sitting", 3],
    ["a", "a-long-name", 10],
  ] as const) {
    expect(nameDistance(a, b)).toBe(distance);
    expect(nameDistance(a, b, 2)).toBe(Math.min(distance, 3));
  }
});

const manifest: BlockManifest = {
  schemaVersion: "forge.block/1",
  id: "example.org/sample",
  version: "1.0.0",
  authorAbi: "forge.author/v1",
  profile: "trusted-action-sync/v1",
  entry: "index.cjs",
  docs: "docs.json",
  operations: {
    "sample.create": {
      input: "input.json",
      output: "output.json",
      context: "stateless",
      effects: [],
      idempotent: true,
      callers: ["agent", "human"],
      stability: "stable",
      timeoutMs: 1000,
    },
  },
};

function config(key: string): ConfigDocument {
  return {
    schemaVersion: "forge.config/1",
    blocks: {
      sample: {
        source: { path: "./sample" },
        rename: { sample: "local" },
        operationTimeouts: { [key]: 15000 },
      },
    },
  };
}

test("misspelled timeout keys name the mistake, closest declaration and fix", () => {
  const result = resolveComposition(
    config("sample.craete"),
    new Map([["sample", manifest]]),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("Expected invalid timeout key");
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatchObject({
    code: "INPUT_INVALID",
    retry: "never",
  });
  expect(result.errors[0]?.message).toContain(
    '.forge/config.yaml: blocks.sample.operationTimeouts["sample.craete"]:',
  );
  expect(result.errors[0]?.message).toContain("did you mean sample.create?");
  expect(result.errors[0]?.message).toContain("Fix:");
  expect(result.errors[0]?.message).toContain("remove");
});

test("an operation from a block not bound to the instance fails even when its manifest is available", () => {
  const foreign: BlockManifest = {
    ...manifest,
    id: "example.org/foreign",
    operations: { "foreign.create": manifest.operations["sample.create"]! },
  };
  const result = resolveComposition(
    config("foreign.create"),
    new Map([
      ["sample", manifest],
      ["foreign", foreign],
    ]),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("Expected unbound timeout operation");
  expect(result.errors[0]?.message).toContain("foreign.create");
  expect(result.errors[0]?.message).toContain("block is not bound");
  expect(result.errors[0]?.message).toContain("sample.create");
});

test("timeout keys use the bound manifest's original names before local renames", () => {
  const document = config("sample.create");
  const result = resolveComposition(document, new Map([["sample", manifest]]));
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error("Expected valid timeout key");
  expect(result.composition.operations.get("local.create")?.declaredOp).toBe(
    "sample.create",
  );
  expect(document.blocks.sample?.operationTimeouts?.["sample.create"]).toBe(
    15000,
  );
  expect(
    resolveComposition(config("local.create"), new Map([["sample", manifest]]))
      .ok,
  ).toBe(false);
});

test("schema-limit invalid overrides bound diagnostics and suggestion work", () => {
  let enumerations = 0;
  const operations = new Proxy(
    Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [
        `${"a".repeat(21)}.${"a".repeat(18)}${String(i).padStart(3, "0")}`,
        manifest.operations["sample.create"]!,
      ]),
    ),
    {
      ownKeys(target) {
        enumerations += 1;
        if (enumerations > 1024)
          throw Error("unbounded suggestion candidate enumeration");
        return Reflect.ownKeys(target);
      },
    },
  );
  const overrides = Object.fromEntries(
    Array.from({ length: 512 }, (_, i) => [
      `${"a".repeat(21)}.${"a".repeat(17)}b${String(i).padStart(3, "0")}`,
      3000,
    ]),
  );
  const document: ConfigDocument = {
    schemaVersion: "forge.config/1",
    blocks: Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [
        `instance${i}`,
        {
          source: { path: "./sample" },
          rename: { ["a".repeat(21)]: `local${i}` },
          operationTimeouts: overrides,
        },
      ]),
    ),
  };
  expect(validateConfigDocument(document).ok).toBe(true);
  const start = performance.now();
  const result = resolveComposition(
    document,
    new Map(
      Object.keys(document.blocks).map((name) => [
        name,
        { ...manifest, operations },
      ]),
    ),
  );
  const elapsed = performance.now() - start;
  console.info(`schema-limit timeout validation: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(5000);
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("Expected invalid overrides");
  expect(result.errors).toHaveLength(5);
  expect(result.errors[4]?.message).toContain("131068 more unknown");
  expect(enumerations).toBeLessThanOrEqual(1024);
}, 60_000);
