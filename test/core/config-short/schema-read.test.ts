// A block's configSchema is read through the bounded capture: only regular files inside the block,
// read exactly, so a link out of the block or a device file never reaches the config defaults.
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigSchema } from "../../../src/assembly/capture.ts";

const SCHEMA = JSON.stringify({
  type: "object",
  properties: { greeting: { type: "string", default: "hi" } },
});
const dirs: string[] = [];
function block(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-schema-read-"));
  dirs.push(root);
  const dir = join(root, "blocks", "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "forge.block.json"),
    JSON.stringify({ configSchema: "schema.json" }),
  );
  return { root, dir };
}
function canLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch {
    return false; // Windows without symlink rights: nothing to prove here
  }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readConfigSchema", () => {
  test("reads the schema a block's manifest names", () => {
    const { root, dir } = block();
    writeFileSync(join(dir, "schema.json"), SCHEMA);
    expect(readConfigSchema(root, { path: "./blocks/hello" })).toEqual(
      JSON.parse(SCHEMA) as unknown,
    );
  }, 10_000);

  test("a schema linked from outside the block is not read", () => {
    const { root, dir } = block();
    const outside = join(root, "outside.json");
    writeFileSync(outside, SCHEMA);
    if (!canLink(outside, join(dir, "schema.json"))) return;
    expect(readConfigSchema(root, { path: "./blocks/hello" })).toBeUndefined();
  }, 10_000);

  test("a schema that is not a regular file is not read", () => {
    const { root, dir } = block();
    mkdirSync(join(dir, "schema.json"));
    expect(readConfigSchema(root, { path: "./blocks/hello" })).toBeUndefined();
  }, 10_000);
});
