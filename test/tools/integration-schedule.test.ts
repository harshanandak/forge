import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("spawn-heavy integration files run once, after the parallel group", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const groups = pkg.scripts["test:integration"]!.split(" && ");
  expect(groups[0]).toBe("bun run build");
  expect(groups).toHaveLength(3);
  expect(groups[1]).toContain("--parallel --timeout 30000");
  expect(groups[1]).toContain("--path-ignore-patterns '");
  const ignore = new Bun.Glob(groups[1]!.split("'")[1]!);
  const serial = groups[2]!;
  expect(serial).toStartWith("bun test --timeout 30000 ");
  expect(serial).not.toContain("--parallel");
  for (const [folder, name] of [
    ["adapters/l5-state", "private-files"],
    ["surface", "help-examples"],
    ["adapters/vcs-git", "vcs-git"],
    ["assembly/shared-store", "shared-store"],
  ]) {
    const path = `test/${folder}/${name}.integration.test.ts`;
    expect(serial.split(" ").filter((arg) => arg === path)).toHaveLength(1);
    expect(ignore.match(path), `${path} excluded from bulk`).toBe(true);
  }
  expect(
    ignore.match("test/integration/custom-block/packed.integration.test.ts"),
  ).toBe(true);
  expect(ignore.match("test/assembly/sqlite-acl.integration.test.ts")).toBe(
    false,
  );
}, 30_000);
