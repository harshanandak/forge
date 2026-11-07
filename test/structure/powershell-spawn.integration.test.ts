import { expect, test } from "bun:test";
import { powerShellArgs } from "../powershell.ts";
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

test("the helper builds the exact startup arguments the tests rely on", () => {
  // Written out on purpose: the other tests compare against the helper itself.
  expect(powerShellArgs("x")).toEqual([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "x",
  ]);
}, 30_000);

const helper = {
  path: HELPER,
  text: 'export const FLAGS = ["-NoProfile", "-NonInteractive"];\n',
};
const check = (path: string, text: string): number =>
  findUnsharedPowerShell([helper, { path, text }]).length;
const TEST = "test/a.integration.test.ts";
const IMPORT = 'import { powerShellArgs } from "../powershell.ts";\n';

test("the guard rejects a test that spawns PowerShell without the helper", () => {
  expect(check(TEST, 'spawnSync("powershell.exe", [])')).toBe(1);
  expect(check(TEST, 'Bun.which("pwsh")')).toBe(1);
  expect(check(TEST, 'spawnSync("powershell", [])')).toBe(1);
  expect(
    check(TEST, "const p = join(r, 'WindowsPowerShell/v1.0/powershell.exe');"),
  ).toBe(1);
  expect(
    check(TEST, 'const p = "C:/Program Files/PowerShell/7/pwsh.exe";'),
  ).toBe(1);
  expect(
    check(TEST, 'const p = "C:\\\\Windows\\\\System32\\\\powershell.exe";'),
  ).toBe(1);
}, 30_000);

test("the guard rejects a raw spawn next to an import of the batch wrapper", () => {
  const wrapper = 'import { powerShellBatch } from "../child-step.ts";\n';
  expect(
    check(TEST, `${wrapper}spawnSync("powershell.exe", ["-Command", s]);`),
  ).toBe(2);
  expect(check(TEST, `${wrapper}spawnSync("powershell.exe", [s]);`)).toBe(1);
  expect(
    check(
      TEST,
      `${wrapper}const b = powerShellBatch();\nb.run("powershell.exe", [], 1);`,
    ),
  ).toBe(0);
}, 30_000);

test("the guard rejects spelled-out flags in any letter case or shape", () => {
  expect(check(TEST, `${IMPORT}const a = ["-NoProfile"];`)).toBe(1);
  expect(check(TEST, `${IMPORT}const a = ["-noprofile"];`)).toBe(1);
  expect(check(TEST, `${IMPORT}const a = "-NoProfile -NonInteractive";`)).toBe(
    1,
  );
  expect(check(TEST, `${IMPORT}const a = \`x -NONINTERACTIVE y\`;`)).toBe(1);
  expect(
    check("tools/b.ts", "const a = ['-NonInteractive', '-Command'];"),
  ).toBe(1);
  expect(check("tools/b.ts", 'const a = ["-Command", script];')).toBe(1);
}, 30_000);

test("the guard accepts the helper, names-only files and unrelated text", () => {
  expect(
    check(
      "test/a/b.integration.test.ts",
      'import { powerShellArgs } from "../../powershell.ts";\nspawnSync("powershell.exe", powerShellArgs(script));',
    ),
  ).toBe(0);
  expect(check("tools/ci/windows-trace.ts", 'const names = ["pwsh"];')).toBe(0);
  expect(
    check("test/a.test.ts", "// PowerShell 5.1 quoting for pwshell users"),
  ).toBe(0);
  expect(
    check("test/a.test.ts", "// -NoProfile is spelled by the helper"),
  ).toBe(0);
  expect(check("test/a.test.ts", "const f = 'mypwsh-tool';")).toBe(0);
  expect(check("test/a.test.ts", 'test("never PowerShell", () => {});')).toBe(
    0,
  );
  expect(
    check(
      "test/a.test.ts",
      'const a = ["secret-file", "--ignore-file", "stale-command-"];',
    ),
  ).toBe(0);
}, 30_000);

test("the guard requires the helper to exist and pass both flags", () => {
  expect(findUnsharedPowerShell([])).toHaveLength(1);
  expect(
    findUnsharedPowerShell([
      { path: HELPER, text: 'export const F = ["-NoProfile"];' },
    ]),
  ).toHaveLength(1);
}, 30_000);

test("the guard requires the batch wrapper to build its arguments through the helper", () => {
  const wrapper = (text: string) =>
    findUnsharedPowerShell([helper, { path: "test/child-step.ts", text }])
      .length;
  expect(wrapper("export const x = 1;")).toBe(1);
  expect(
    wrapper(
      'import { powerShellArgs } from "./powershell.ts";\nconst a = powerShellArgs(c);',
    ),
  ).toBe(0);
}, 30_000);
