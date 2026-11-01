// Bun cannot follow runtime-loaded blocks or subprocess entry points.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const base = git("merge-base", "origin/main", "HEAD");
const changed = [
  ...git("diff", "--name-only", base, "--").split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
];
const extra = new Set<string>();
for (const file of changed) {
  if (file.startsWith("src/blocks/memory/"))
    for (const test of [
      "test/blocks/memory/rules.test.ts",
      "test/blocks/memory/catalog.test.ts",
      "test/blocks/memory/recipes.integration.test.ts",
      "test/assembly/shared-store/shared-store.integration.test.ts",
    ])
      extra.add(test);
  if (/^tools\/(lane(?:-.*)?\.(?:ts|md)|digest\.ts)$/.test(file))
    for (const test of [
      "test/tools/lane.integration.test.ts",
      "test/tools/lane-run.integration.test.ts",
      "test/tools/lane-close.integration.test.ts",
      "test/tools/digest.integration.test.ts",
    ])
      extra.add(test);
  if (file === "tools/test-changed.ts")
    extra.add("test/tools/test-changed.integration.test.ts");
}
const files = [...extra].filter(existsSync);
const flags = ["--parallel", "--timeout", "30000"];
const run = (...args: string[]) => {
  console.log(`test:changed: bun ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(
  "test",
  ...flags,
  `--changed=${base}`,
  `--path-ignore-patterns={**/packed.integration.test.ts,${files.join(",")}}`,
  ...process.argv.slice(2),
);
if (files.length) run("test", ...flags, ...files, ...process.argv.slice(2));
if (changed.some((file) => /(?:^|\/)packed\.integration\.test\.ts$/.test(file)))
  run("run", "test:pack");
