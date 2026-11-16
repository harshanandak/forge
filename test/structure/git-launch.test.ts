import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Lexical guard: launch names containing spawn/exec/run/launch/command, with Git as the first
// string/array program (or Bun's {cmd:[...]}). Includes static shell-command prefixes and native
// extensions. No alias/data-flow analysis; variables must be resolved before launch. Only the
// shared resolver itself is exempt. Comment-only lines are blanked to preserve file:line output.
const LAUNCH =
  /\b[\w$]*(?:spawn|exec|run|launch|command)[\w$]*\s*\(\s*(?:\[\s*|\{\s*cmd\s*:\s*\[\s*)?(["'`])git(?:\.(?:exe|com|cmd|bat))?(?:\1(?=\s*[,)\]])|[ \t]+[^"'`\r\n]*\1)/gi;
function violations(file: string, text: string): string[] {
  if (file === "src/adapters/process/resolve.ts") return [];
  const code = text
    .split("\n")
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? "" : line))
    .join("\n");
  return [...code.matchAll(LAUNCH)].map(
    (match) =>
      `${file}:${code.slice(0, match.index).split("\n").length}: resolve Git before launch`,
  );
}
function scan(directory: string, relative: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = `${relative}/${entry.name}`,
      path = join(directory, entry.name);
    return entry.isDirectory()
      ? scan(path, file)
      : entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)
        ? violations(file, readFileSync(path, "utf8"))
        : [];
  });
}
test("Git launch programs in src, tools and templates use the shared resolver", () => {
  const root = join(import.meta.dirname, "../..");
  expect(
    ["src", "tools", "templates"].flatMap((dir) => scan(join(root, dir), dir)),
  ).toEqual([]);
}, 30_000);

test("Git launch guard catches direct APIs and program-taking helpers with file:line", () => {
  for (const call of [
    'spawn("git", [])',
    'spawnSync("git", [])',
    'execFile("git", [])',
    'execFileSync("git", [])',
    'exec("git status")',
    'execSync("git status")',
    'Bun.spawn(["git", "status"])',
    'Bun.spawnSync({cmd:["git", "status"]})',
    'run("git", [])',
    'launcher("git.exe", [])',
    'command("git", [])',
    'runner.launch("git.cmd", [])',
    "run(['git.bat', ...args])",
  ])
    expect(violations("templates/hook.cjs", `// sample\n${call}`)).toEqual([
      "templates/hook.cjs:2: resolve Git before launch",
    ]);
  for (const file of ["src/a.cts", "tools/a.ts", "templates/a.mjs"])
    expect(violations(file, 'run("git", [])')).toHaveLength(1);
  expect(
    violations(
      "tools/a.ts",
      'run(gitExecutable(), []); resolveExecutable("git", env, platform, probe)',
    ),
  ).toEqual([]);
  expect(violations("tools/a.ts", '// run("git", [])')).toEqual([]);
}, 30_000);
