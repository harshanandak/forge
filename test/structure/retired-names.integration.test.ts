import { expect, test } from "bun:test";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";
import { findRetiredNames } from "./lib/retired.ts";

test("no retired name, path or shape from the DROP list is present", () => {
  const paths = listRepoFiles();
  expect(format(findRetiredNames(readRepoFiles(paths), paths))).toEqual([]);
}, 30_000);

test("the guard rejects retired names in content", () => {
  const names = [
    "uses beads for tracking",
    "set FORGE_ISSUE_BACKEND=x",
    "run forge prime first",
    "the shepherd daemon",
    "the Kernel store",
    "rail.tdd_intent is on",
    "install lefthook",
    "a /check command",
    "see KAP-12",
  ];
  for (const text of names) {
    expect(findRetiredNames([{ path: "docs/x.md", text }])).not.toEqual([]);
  }
}, 30_000);

test("the guard rejects retired paths and shapes", () => {
  const paths = [
    "lefthook.yml",
    ".husky/pre-push",
    "scripts/ship.sh",
    ".claude/commands/ship.md",
    "lib/_aliases.js",
    "test-weights.json",
    "web/dashboard/index.ts",
  ];
  for (const path of paths) {
    expect(findRetiredNames([], [path])).not.toEqual([]);
  }
}, 30_000);

test("the guard allows detectors, legacy readers, fixtures and clean docs", () => {
  const files = [
    {
      path: "src/blocks/project/detect-hooks.ts",
      text: "const known = ['lefthook', 'husky'];\n",
    },
    {
      path: "src/blocks/migrate/legacy/old.ts",
      text: "// reads the beads export\n",
    },
    { path: "test/fixtures/repo/lefthook.yml", text: "pre-push:\n" },
    {
      path: "docs/ok.md",
      text: "Run `bun check`; the CI Gate runs the checks.\n",
    },
  ];
  expect(findRetiredNames(files)).toEqual([]);
  const paths = [
    "test/fixtures/a/.husky/x",
    "test/project/fixtures/a/lefthook.yml",
  ];
  expect(findRetiredNames([], paths)).toEqual([]);
}, 30_000);

test("the retired-name exemption covers only detector modules of the project block, not its other files or paths", () => {
  const planted = [
    { path: "src/blocks/project/run.ts", text: "// installs lefthook\n" },
    { path: "src/blocks/project/index.ts", text: "// the shepherd daemon\n" },
    { path: "src/blocks/project/detect/node.ts", text: "// reads beads\n" },
    {
      path: "src/blocks/project/sub/detect-node.ts",
      text: "// kernel store\n",
    },
  ];
  for (const file of planted) {
    expect(findRetiredNames([file])).not.toEqual([]);
  }
  expect(findRetiredNames([], ["src/blocks/project/lefthook.yml"])).not.toEqual(
    [],
  );
  const allowed = [
    {
      path: "src/blocks/project/detect-trackers.ts",
      text: "// recognises beads, lefthook and husky\n",
    },
  ];
  expect(findRetiredNames(allowed)).toEqual([]);
}, 30_000);
