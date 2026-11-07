import { expect, test } from "bun:test";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";
import { findUnsharedPowerShell, HELPER } from "./lib/powershell.ts";

test("every PowerShell spawn goes through the shared helper and its startup flags", () => {
  const files = readRepoFiles(
    listRepoFiles().filter(
      (path) => path.startsWith("test/") || path.startsWith("tools/"),
    ),
  );
  expect(format(findUnsharedPowerShell(files))).toEqual([]);
}, 30_000);

const helper = {
  path: HELPER,
  text: 'export const FLAGS = ["-NoProfile", "-NonInteractive"];\n',
};
const check = (path: string, text: string): number =>
  findUnsharedPowerShell([helper, { path, text }]).length;

test("the guard rejects a test that spawns PowerShell without the helper", () => {
  expect(
    check("test/a.integration.test.ts", 'spawnSync("powershell.exe", [])'),
  ).toBe(1);
  expect(check("test/a.integration.test.ts", 'Bun.which("pwsh")')).toBe(1);
  expect(
    check(
      "test/a.integration.test.ts",
      "const p = join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');",
    ),
  ).toBe(1);
}, 30_000);

test("the guard rejects spelled-out startup flags, with or without the helper", () => {
  const import_ = 'import { powerShellArgs } from "../powershell.ts";\n';
  expect(
    check("test/a.integration.test.ts", `${import_}const a = ["-NoProfile"];`),
  ).toBe(1);
  expect(
    check("tools/b.ts", "const a = ['-NonInteractive', '-Command'];"),
  ).toBe(1);
}, 30_000);

test("the guard accepts the helper, names-only files and unrelated text", () => {
  const import_ = 'import { powerShellArgs } from "../../powershell.ts";\n';
  expect(
    check(
      "test/a/b.integration.test.ts",
      `${import_}spawnSync("powershell.exe", powerShellArgs(script));`,
    ),
  ).toBe(0);
  expect(check("tools/ci/windows-trace.ts", 'const names = ["pwsh"];')).toBe(0);
  expect(
    check("test/a.test.ts", "// PowerShell 5.1 quoting for pwshell users"),
  ).toBe(0);
  expect(check("test/a.test.ts", "const f = 'mypwsh-tool';")).toBe(0);
}, 30_000);

test("the guard requires the helper to exist and pass both flags", () => {
  expect(findUnsharedPowerShell([])).toHaveLength(1);
  expect(
    findUnsharedPowerShell([
      { path: HELPER, text: 'export const F = ["-NoProfile"];' },
    ]),
  ).toHaveLength(1);
}, 30_000);
