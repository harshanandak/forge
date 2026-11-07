import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executablesUnder } from "./fixture-executables.ts";

setDefaultTimeout(5_000);

test("executables under a root are listed at any depth and in any letter case", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-exe-scan-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "claude.exe"), "");
    writeFileSync(join(root, "TOOL.EXE"), "");
    writeFileSync(join(root, "bin", "claude"), "#!/bin/sh\n");
    writeFileSync(join(root, "notes.exe.txt"), "");
    expect(executablesUnder(root).sort()).toEqual(
      [join("bin", "claude.exe"), "TOOL.EXE"].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root without executables, or one that is gone, lists nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-exe-scan-"));
  try {
    writeFileSync(join(root, "claude"), "#!/bin/sh\n");
    expect(executablesUnder(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(executablesUnder(root)).toEqual([]);
});

test("an entry that vanishes in the middle of the walk fails the guard instead of hiding executables", () => {
  const vanished = Object.assign(new Error("entry vanished"), {
    code: "ENOENT",
    path: join("root", "bin", "gone"),
  });
  expect(() =>
    executablesUnder("root", () => {
      throw vanished;
    }),
  ).toThrow(vanished);
  const missingRoot = Object.assign(new Error("root missing"), {
    code: "ENOENT",
    path: "root",
  });
  expect(
    executablesUnder("root", () => {
      throw missingRoot;
    }),
  ).toEqual([]);
});

test("a scan that fails for any reason but a missing root fails the guard", () => {
  const denied = Object.assign(new Error("scan denied"), { code: "EACCES" });
  expect(() =>
    executablesUnder("root", () => {
      throw denied;
    }),
  ).toThrow(denied);
});
