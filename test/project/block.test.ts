import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForgeFailure,
  validateBlockManifest,
  validateDocsRecords,
} from "../../src/contract/index.ts";
import {
  createFolderFiles,
  createMemoryFiles,
  DETECTORS,
  detectProject,
  operations,
} from "../../src/blocks/project/index.ts";

const blockDir = join(import.meta.dirname, "../../src/blocks/project");

function json(path: string): unknown {
  return JSON.parse(readFileSync(join(blockDir, path), "utf8"));
}

function keys(tree: Record<string, string>): string[] {
  return detectProject(createMemoryFiles(tree)).observations.map((o) => o.key);
}

function valueOf(tree: Record<string, string>, key: string): unknown {
  return detectProject(createMemoryFiles(tree)).observations.find(
    (o) => o.key === key,
  )?.value;
}

test("the block manifest and docs record satisfy the contract and declare exactly the handler's operations", () => {
  const manifest = json("forge.block.json");
  expect(validateBlockManifest(manifest).ok).toBe(true);
  expect(validateDocsRecords(json("docs/records.json")).ok).toBe(true);
  const declared = Object.keys(
    (manifest as { operations: Record<string, unknown> }).operations,
  );
  expect(declared).toEqual(Object.keys(operations));
}, 30_000);

test("project.detect returns the report for the folder the runtime binds", () => {
  const files = createMemoryFiles({
    "package.json": JSON.stringify({ scripts: { test: "t" } }),
    "package-lock.json": "{}",
  });
  const out = operations["project.detect"]({ input: {}, services: { files } });
  expect(out.failures).toEqual([]);
  expect(out.observations.map((o) => o.key)).toContain(
    "/blocks/check/config/commands/test",
  );
}, 30_000);

test("project.detect without a project folder fails with a coded, non-retryable error", () => {
  for (const services of [undefined, {}, { files: {} }]) {
    let failure: unknown;
    try {
      operations["project.detect"]({ input: {}, services });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ForgeFailure);
    expect((failure as ForgeFailure).error).toMatchObject({
      code: "SERVICE_MISSING",
      retry: "never",
    });
  }
}, 30_000);

test("a detector that throws is reported and the others still run", () => {
  const files = createMemoryFiles({ "go.mod": "module x\n" });
  const report = detectProject(files, [
    {
      id: "broken",
      run: () => {
        throw new Error("boom");
      },
    },
    ...DETECTORS,
  ]);
  expect(report.failures).toEqual([{ detector: "broken", message: "boom" }]);
  expect(report.observations.map((o) => o.key)).toContain(
    "/blocks/project/detected/go/module",
  );
}, 30_000);

test("the manager a project declares wins over its lockfiles", () => {
  const tree = {
    "package.json": JSON.stringify({
      packageManager: "bun@1.1.0",
      scripts: { test: "x" },
    }),
    "package-lock.json": "{}",
    "yarn.lock": "",
  };
  expect(valueOf(tree, "/blocks/project/detected/node/packageManager")).toEqual(
    {
      name: "bun",
      version: "1.1.0",
    },
  );
  expect(valueOf(tree, "/blocks/check/config/commands/test")).toBe(
    "bun run test",
  );
  expect(keys(tree)).not.toContain(
    "/blocks/project/detected/node/packageManagerConflict",
  );
}, 30_000);

test("lockfiles that disagree are a conflict to report, not a choice to make", () => {
  const tree = {
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "pnpm-lock.yaml": "",
    "yarn.lock": "",
  };
  expect(keys(tree)).toContain(
    "/blocks/project/detected/node/packageManagerConflict",
  );
  expect(keys(tree)).not.toContain(
    "/blocks/project/detected/node/packageManager",
  );
  expect(keys(tree)).not.toContain("/blocks/check/config/commands/test");
}, 30_000);

test("a package.json with no lockfile and no declaration offers scripts but no runnable command", () => {
  const tree = {
    "package.json": JSON.stringify({ scripts: { test: "x", lint: "y" } }),
  };
  expect(keys(tree)).toContain("/blocks/project/detected/node/scripts");
  expect(keys(tree).filter((key) => key.startsWith("/blocks/check/"))).toEqual(
    [],
  );
}, 30_000);

test("an unrecognised packageManager value is ignored in favour of the lockfile", () => {
  const tree = {
    "package.json": JSON.stringify({ packageManager: "mystery@1" }),
    "yarn.lock": "",
  };
  expect(valueOf(tree, "/blocks/project/detected/node/packageManager")).toEqual(
    { name: "yarn" },
  );
}, 30_000);

test("a malformed package.json is reported, not skipped silently", () => {
  const tree = { "package.json": "{ not json" };
  expect(keys(tree)).toEqual(["/blocks/project/detected/node/unreadable"]);
}, 30_000);

test("a script name that could be read as a flag or shell syntax is never offered as a command", () => {
  const tree = {
    "package.json": JSON.stringify({ scripts: { test: "x", build: "y" } }),
    "package-lock.json": "{}",
  };
  expect(keys(tree)).toContain("/blocks/check/config/commands/build");
  const odd = {
    "package.json": JSON.stringify({
      scripts: { "-test": "x", "lint; rm": "y" },
    }),
    "package-lock.json": "{}",
  };
  expect(keys(odd).filter((key) => key.startsWith("/blocks/check/"))).toEqual(
    [],
  );
}, 30_000);

test("make targets and just recipes are read the way those tools write them", () => {
  const make = [
    "CC := gcc",
    "VAR ?= 1",
    ".PHONY: all",
    "all test: deps",
    "\tgcc",
    "%.o: %.c",
    "\tgcc -c",
    "lint:: ",
    "",
  ].join("\n");
  expect(
    valueOf({ Makefile: make }, "/blocks/project/detected/tasks/make"),
  ).toEqual({
    targets: ["all", "test"],
  });
  const just = [
    'set shell := ["sh", "-c"]',
    "alias t := test",
    "export FOO := bar",
    "test +args='-q' flag=\"a b\": build",
    "    run {{args}}",
    "build:",
    "    make",
    "@fmt:",
    "    fmt",
  ].join("\n");
  expect(
    valueOf({ justfile: just }, "/blocks/project/detected/tasks/just"),
  ).toEqual({
    targets: ["test", "build", "fmt"],
  });
}, 30_000);

test("a decision log is found whichever way the project numbers its records", () => {
  const records = (path: string, files: string[]): Record<string, string> =>
    Object.fromEntries(files.map((name) => [`${path}/${name}`, "# x\n"]));
  expect(
    valueOf(
      records("doc/decisions", ["ADR-001-a.md", "ADR-002-b.md"]),
      "/blocks/project/detected/decisions/records",
    ),
  ).toEqual({
    layout: "file-per-record",
    path: "doc/decisions",
    count: 2,
    idPattern: "ADR-NNN",
    highest: 2,
  });
  expect(
    valueOf(
      { "DECISIONS.md": "## D-003 x\n## D-12 y\n" },
      "/blocks/project/detected/decisions/records",
    ),
  ).toEqual({
    layout: "single-file",
    path: "DECISIONS.md",
    count: 2,
    idPattern: "D-NNN",
    highest: 12,
  });
}, 30_000);

test("a hook manager's own sample hooks are not reported as the project's hooks", () => {
  const tree = {
    ".git/hooks/pre-commit.sample": "#!/bin/sh\n",
    ".git/hooks/pre-push.sample": "#!/bin/sh\n",
  };
  expect(keys(tree)).toEqual([]);
  expect(keys({ ".git/hooks/pre-commit": "#!/bin/sh\nrun-checks\n" })).toEqual([
    "/blocks/project/detected/hooks/managers/raw",
    "/blocks/project/detected/hooks/preCommit/raw",
  ]);
}, 30_000);

test("a plain test runner on pre-commit is not mistaken for a source-to-test gate", () => {
  const tree = {
    ".pre-commit-config.yaml":
      "repos:\n  - repo: local\n    hooks:\n      - id: unit\n        entry: run-all-tests --fast\n",
  };
  expect(keys(tree)).not.toContain(
    "/blocks/project/detected/hooks/existingTestGate",
  );
}, 30_000);

test("the folder reader answers for exact spelling only and never leaves the project", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-files-"));
  try {
    mkdirSync(join(root, "Docs"));
    writeFileSync(join(root, "Docs", "Note.md"), "hi");
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    const files = createFolderFiles(root);
    expect(files.read("Docs/Note.md")).toBe("hi");
    expect(files.exists("docs")).toBe(false);
    expect(files.exists("Docs/note.md")).toBe(false);
    expect(files.list("Docs")).toEqual(["Note.md"]);
    expect(files.read("bin.dat")).toBeUndefined();
    for (const escape of ["../x", "/etc/passwd", "C:/x", "a\\b", ""]) {
      expect(files.exists(escape)).toBe(false);
      expect(files.read(escape)).toBeUndefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
