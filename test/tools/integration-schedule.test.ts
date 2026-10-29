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
    ["tools", "lane-run"],
    ["tools", "lane"],
  ]) {
    const path = `test/${folder}/${name}.integration.test.ts`;
    expect(serial.split(" ").filter((arg) => arg === path)).toHaveLength(1);
    expect(ignore.match(path), `${path} excluded from bulk`).toBe(true);
  }
  const serialPaths = serial.split(" ").slice(4);
  expect(serialPaths).toHaveLength(6);
  const integrationPaths = [
    ...new Bun.Glob("test/**/*.integration.test.ts").scanSync("."),
  ]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.endsWith("/packed.integration.test.ts"));
  const parallelPaths = integrationPaths.filter((path) => !ignore.match(path));
  expect([...parallelPaths, ...serialPaths].sort()).toEqual(
    integrationPaths.sort(),
  );
  expect(
    ignore.match("test/integration/custom-block/packed.integration.test.ts"),
  ).toBe(true);
  expect(ignore.match("test/assembly/sqlite-acl.integration.test.ts")).toBe(
    false,
  );
}, 30_000);
