// gen --check: committed generated files must equal what the schemas produce, and a schema edit
// without regeneration fails the check.
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
import {
  drift,
  generate,
  main,
  OUTPUTS,
  repoRoot,
} from "../../tools/gen/types.ts";

function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-gen-"));
  cpSync(join(repoRoot, "schemas"), join(dir, "schemas"), { recursive: true });
  cpSync(join(repoRoot, "src", "generated"), join(dir, "src", "generated"), {
    recursive: true,
  });
  return dir;
}

test("the committed generated files match the schemas byte for byte", () => {
  expect(drift()).toEqual([]);
  expect(main(["--check"])).toBe(0);
}, 30_000);

test("generation is deterministic", () => {
  const first = generate();
  const second = generate();
  expect([...second]).toEqual([...first]);
}, 30_000);

test("a schema edit without regeneration fails the check, and regenerating fixes it", () => {
  const dir = scratchCopy();
  try {
    const path = join(dir, "schemas", "common.json");
    const schema = JSON.parse(readFileSync(path, "utf8")) as {
      $defs: Record<string, unknown>;
    };
    schema.$defs.Extra = { type: "string" };
    writeFileSync(path, JSON.stringify(schema, null, 2));
    expect(drift(dir).sort()).toEqual(
      [OUTPUTS.schemas, OUTPUTS.types, OUTPUTS.validators].sort(),
    );
    expect(main(["--check"], dir)).toBe(1);
    expect(main([], dir)).toBe(0);
    expect(drift(dir)).toEqual([]);
    expect(readFileSync(join(dir, OUTPUTS.types), "utf8")).toContain(
      "export type Extra = string;",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a hand edit to a generated file fails the check", () => {
  const dir = scratchCopy();
  try {
    const path = join(dir, OUTPUTS.types);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "readonly id: BlockId;",
        "readonly id: string;",
      ),
    );
    expect(drift(dir)).toEqual([OUTPUTS.types]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
