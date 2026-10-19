import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateBlockManifest,
  validateDocsRecords,
} from "../../../src/generated/validators.ts";
import {
  isSchemaObject,
  validateWithSchema,
} from "../../../src/contract/schema.ts";

const root = resolve(import.meta.dirname, "../../../src/blocks/git");
const json = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(root, path), "utf8")) as unknown;
test("git declares eight ordinary operations and explicit bounded config", () => {
  const result = validateBlockManifest(json("forge.block.json"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Invalid git manifest");
  expect(Object.keys(result.value.operations).sort()).toEqual([
    "branch.push",
    "hook.install",
    "hook.remove",
    "hook.status",
    "worktree.clean",
    "worktree.create",
    "worktree.list",
    "worktree.remove",
  ]);
  const docs = validateDocsRecords(json(result.value.docs));
  expect(docs.ok).toBe(true);
  if (!docs.ok) throw new Error("Invalid docs");
  for (const [op, declaration] of Object.entries(result.value.operations)) {
    expect(docs.value.operations[op]?.summary.length).toBeGreaterThan(0);
    expect(declaration.timeoutMs).toBeGreaterThan(0);
    expect(json(declaration.input)).toBeDefined();
    expect(json(declaration.output)).toBeDefined();
    expect(declaration.effects.includes("external:write")).toBe(
      !["worktree.list", "hook.status"].includes(op),
    );
  }
  const schema = json("schemas/config.json");
  if (!isSchemaObject(schema)) throw new Error("Invalid config schema");
  expect(validateWithSchema(schema, {}).length).toBeGreaterThan(0);
}, 30000);
