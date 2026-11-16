import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { SourceFile } from "./lib/repo.ts";
// Lexical guard: literal Git programs in launch calls, arrays and Bun cmd arrays. Follow named
// function declarations and relative imports to resolver/forwarder shapes, with no caller list.
// Computed aliases are outside this matcher. Blank comment-only lines preserve file:line.
const LAUNCH = new RegExp(
  String.raw`\b(spawn(?:Sync)?|exec(?:File)?(?:Sync)?|run(?:Command)?|launch(?:er)?|command)\s*\(\s*(?:\[\s*|\{\s*cmd\s*:\s*\[\s*)?(["'\`])git(?:\.(?:exe|com|cmd|bat))?(?:\2(?=\s*[,)\]])|[ \t]+[^"'\`\r\n]*\2)`,
  "gi",
);
const root = join(import.meta.dirname, "../..");
const DIRECT = String.raw`\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)\(\s*`;
const GIT_RETURN =
  /if\s*\([^)]*===\s*["']git["']\)\s*return\s+spawnSync\(gitExecutable\(/;
function resolves(name: string, file: SourceFile, seen: Set<string>): boolean {
  const key = `${file.path}:${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const definition = new RegExp(
    `\\bfunction ${name}\\s*\\(\\s*(\\w+)[\\s\\S]*?\\n {0,2}\\}`,
  ).exec(file.text);
  if (!definition) {
    const source = new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'](\\.[^"']+)`,
    ).exec(file.text)?.[1];
    const target = source && normalize(join(dirname(file.path), source));
    return (
      !!target &&
      resolves(
        name,
        { path: target, text: readFileSync(join(root, target), "utf8") },
        seen,
      )
    );
  }
  const [body, parameter] = [definition[0], definition[1]!];
  if (GIT_RETURN.test(body)) return true;
  if (new RegExp(`${DIRECT}${parameter}\\b`).test(body)) return false;
  if (/\bgitExecutable\(|\.resolve\(\s*\w+\[0\]/.test(body)) return true;
  return [
    ...body.matchAll(new RegExp(`\\b(\\w+)\\(\\s*${parameter}\\s*,`, "g")),
  ].some((call) => resolves(call[1]!, file, seen));
}
function violations(file: string, text: string): string[] {
  if (file === "src/adapters/process/resolve.ts") return [];
  const code = text.replace(/^[ \t]*(?:\/\/|\/\*|\*)[^\n]*/gm, "");
  return [...code.matchAll(LAUNCH)]
    .filter(
      (match) => !resolves(match[1]!, { path: file, text: code }, new Set()),
    )
    .map(
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
  expect(
    ["src", "tools", "templates"].flatMap((dir) => scan(join(root, dir), dir)),
  ).toEqual([]);
}, 30_000);
test("Git launch guard catches direct APIs and program-taking helpers with file:line", () => {
  for (const call of [
    ..."spawn spawnSync execFile execFileSync command"
      .split(" ")
      .map((name) => `${name}("git", [])`),
    'exec("git status")',
    'execSync("git status")',
    'Bun.spawn(["git", "status"])',
    'Bun.spawnSync({cmd:["git", "status"]})',
    ..."spawnSync(program, [])|Bun.spawn([program])|Bun.spawnSync([program])|Bun.spawn({cmd:[program]})|Bun.spawnSync({cmd:[program]})"
      .split("|")
      .map(
        (launch) =>
          `run("git", []); function run(program) {\n const unused = gitExecutable(); return ${launch};\n}`,
      ),
    'launcher("git.exe", [])',
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
      'import {runCommand} from "./run-command.ts"; run(gitExecutable(), []); resolveExecutable("git", env, platform, probe); command("git", []); function command(program) {\n return runCommand(program, [], {});\n}',
    ),
  ).toEqual([]);
  expect(violations("tools/a.ts", '// run("git", [])')).toEqual([]);
}, 30_000);
