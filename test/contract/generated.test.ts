// Generated output is never committed, so what must hold is that generation is a pure function of
// schemas/: the same schemas give the same bytes, and a schema change changes the bytes.
import { expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, OUTPUTS, repoRoot, write } from "../../tools/gen/types.ts";

function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-gen-"));
  cpSync(join(repoRoot, "schemas"), join(dir, "schemas"), { recursive: true });
  return dir;
}

function outputs(dir: string): string[] {
  return Object.values(OUTPUTS).map((path) =>
    readFileSync(join(dir, path), "utf8"),
  );
}

test("generation is deterministic in memory", () => {
  expect([...generate()]).toEqual([...generate()]);
}, 30_000);

test("generating twice into a clean directory yields identical bytes", () => {
  const dir = scratchCopy();
  try {
    write(dir);
    const first = outputs(dir);
    write(dir);
    expect(outputs(dir)).toEqual(first);
    expect(first).toEqual([...generate(dir).values()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a schema change changes the generated output", () => {
  const dir = scratchCopy();
  try {
    write(dir);
    const before = outputs(dir);
    const path = join(dir, "schemas", "common.json");
    const schema = JSON.parse(readFileSync(path, "utf8")) as {
      $defs: Record<string, unknown>;
    };
    schema.$defs.Extra = { type: "string" };
    writeFileSync(path, JSON.stringify(schema, null, 2));
    write(dir);
    const after = outputs(dir);
    after.forEach((text, i) => expect(text).not.toBe(before[i]));
    expect(readFileSync(join(dir, OUTPUTS.types), "utf8")).toContain(
      "export type Extra = string;",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
