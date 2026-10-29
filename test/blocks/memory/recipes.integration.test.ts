import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");
const recipe = readFileSync(
  resolve(repo, "templates/delivery/harness/memory-rules.md"),
  "utf8",
);
const script = resolve(repo, "templates/delivery/harness/memory-start.mjs");
const node = Bun.which("node");
if (!node) throw new Error("Node is required to check the startup recipe");

function fixture(source: string, run: (root: string, hook: string) => void) {
  expect(existsSync(script)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "forge-memory-start-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    mkdirSync(join(root, "templates/delivery/harness"), { recursive: true });
    mkdirSync(join(root, "dist/bin"), { recursive: true });
    const hook = join(root, "templates/delivery/harness/memory-start.mjs");
    copyFileSync(script, hook);
    writeFileSync(join(root, "dist/bin/forge.js"), source);
    run(root, hook);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function start(root: string, hook: string, project?: string) {
  const env: Record<string, string> = {
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  if (project !== undefined) env.CLAUDE_PROJECT_DIR = project;
  return spawnSync(node!, [hook], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 19_000,
    windowsHide: true,
  });
}

for (const [name, output, code] of [
  ["invalid JSON", "not JSON", "INVALID_RESPONSE"],
  [
    "store failure",
    JSON.stringify({ ok: false, error: { code: "STATE_UNAVAILABLE" } }),
    "STATE_UNAVAILABLE",
  ],
  [
    "invalid success envelope",
    JSON.stringify({ ok: true, result: {} }),
    "INVALID_RESPONSE",
  ],
  [
    "untrusted error code",
    JSON.stringify({ ok: false, error: { code: "BAD\nstack" } }),
    "INVALID_RESPONSE",
  ],
] as const) {
  test(`integration: companion reports ${name} in one line without a stack`, () => {
    fixture(`process.stdout.write(${JSON.stringify(output)})`, (root, hook) => {
      const result = start(root, hook);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`Forge memory unavailable: ${code}\n`);
    });
  }, 30_000);
}

test("integration: companion uses its own CLI, notes input, runtime and session directory, rereading every start", () => {
  fixture(
    `import {readFileSync} from 'node:fs';
    const valid=JSON.stringify(process.argv.slice(2))===JSON.stringify(['memory','rules','--input','{"notes":true}']);
    console.log(JSON.stringify({ok:true,result:{text:{text:valid?readFileSync('notes.txt','utf8')+'|'+process.execPath:'wrong arguments'}}}));`,
    (root, hook) => {
      const project = join(root, "project with spaces");
      mkdirSync(project);
      for (const [cwd, text] of [
        [project, "fresh rule\nForge memory notes: general 1."],
        [root, "fallback directory"],
      ] as const) {
        writeFileSync(join(cwd, "notes.txt"), text);
        const result = start(root, hook, cwd === project ? project : undefined);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(`${text}|${node}\n`);
      }
      writeFileSync(join(project, "notes.txt"), "changed rule");
      expect(start(root, hook, project).stdout).toBe(`changed rule|${node}\n`);
    },
  );
}, 30_000);

test("integration: companion fails open for a missing CLI, process failure and bounded timeout", () => {
  for (const [source, code] of [
    ["process.exit(7)", "PROCESS_FAILED"],
    ["setInterval(()=>{},1000)", "ETIMEDOUT"],
  ] as const)
    fixture(source, (root, hook) => {
      const before = Date.now();
      const result = start(root, hook);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`Forge memory unavailable: ${code}\n`);
      expect(Date.now() - before).toBeLessThan(19_000);
    });
  fixture("", (root, hook) => {
    rmSync(join(root, "dist/bin/forge.js"));
    expect(start(root, hook).stdout).toBe(
      "Forge memory unavailable: PROCESS_FAILED\n",
    );
  });
}, 40_000);

test("startup recipe uses the installer operation and documents every SessionStart source including forks", () => {
  expect(recipe).toContain("forge agent memory claude");
  expect(recipe).toContain("forge agent memory codex");
  expect(recipe).toContain("including forks");
  expect(recipe).toContain("/hooks");
  for (const block of recipe.matchAll(/```sh\n([\s\S]*?)\n```/g))
    expect(block[1]).not.toContain("node -e");
}, 30_000);

test("startup upgrade replaces earlier memory hooks while preserving unrelated hooks", () => {
  const prose = recipe.replace(/\s+/gu, " ");
  expect(prose).toContain("existing Claude Code and Codex installations");
  expect(prose).toContain("replace the old inline");
  expect(prose).toContain("`forge memory rules | node -e ...`");
  expect(prose).toContain(
    "SessionStart entry or any earlier memory-start hook",
  );
  expect(prose).toContain("Preserve unrelated settings and hooks");
  expect(prose).toContain("exactly one Forge memory SessionStart hook");
}, 30_000);

test("startup renderer explains the agent-block prerequisite and user-level alternative", () => {
  const prose = recipe.replace(/\s+/gu, " ");
  expect(prose).toContain("`forge agent memory <id>` requires the agent block");
  expect(prose).toContain("the delivery template enables");
  expect(prose).toContain("In a memory-only project, enable the agent block");
  expect(prose).toContain(
    "render the entry once from a project with that block enabled",
  );
  expect(prose).toContain("The target hook file is user-level");
}, 30_000);

test("recipe gives a valid on-demand search and forge-loop requires it", () => {
  const loop = readFileSync(
    resolve(repo, "templates/delivery/skills/forge-loop/SKILL.md"),
    "utf8",
  );
  expect(recipe).toContain('forge memory search "<topic>"');
  expect(recipe).toContain("forge memory show <id>");
  expect(recipe).toContain("Prefer hits in the resolved scope or general");
  expect(recipe).toContain("Scope resolution uses the repo override");
  expect(recipe).toContain("`memory-scopes.json` under `FORGE_DEVICE_ROOT`");
  expect(recipe.indexOf("repo override")).toBeLessThan(
    recipe.indexOf("device alias"),
  );
  expect(recipe.indexOf("device alias")).toBeLessThan(
    recipe.indexOf("normalized folder name"),
  );
  expect(loop).toContain("Search memory before starting a task");
  expect(loop).toContain("search/show commands");
  expect(loop).toContain("never note text");
}, 30_000);

test("startup recipe documents decision dates and a complete-line rule budget", () => {
  const prose = recipe.replace(/\s+/gu, " ");
  expect(prose).toContain("`- [<scope>] <id> (created YYYY-MM-DD) <text>`");
  expect(prose).toContain(
    "`- [<scope>] <id> (created YYYY-MM-DD, updated YYYY-MM-DD) <text>`",
  );
  expect(prose).toContain("UTC");
  expect(prose).toContain("text, tags or scope");
  expect(prose).toContain("whole lines");
  expect(prose).toContain("createdAtApprox");
}, 30_000);
