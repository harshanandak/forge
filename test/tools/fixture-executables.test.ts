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
