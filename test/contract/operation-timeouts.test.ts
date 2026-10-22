import { expect, setDefaultTimeout, test } from "bun:test";
import { resolveComposition } from "../../src/contract/composition.ts";
import type {
  BlockManifest,
  ConfigDocument,
} from "../../src/generated/types.ts";

setDefaultTimeout(10_000);

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
