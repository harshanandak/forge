import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");
const recipe = readFileSync(
  resolve(repo, "templates/delivery/harness/memory-rules.md"),
  "utf8",
);
const parser = recipe.split('node -e "')[1]?.split('"')[0];
if (!parser) throw new Error("SessionStart recipe needs its Node parser");
const node = Bun.which("node");
if (!node) throw new Error("Node is required to check the startup recipe");

for (const [name, input, code] of [
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
] as const) {
  test(`integration: recipe reports ${name} in one line without a stack`, () => {
    const result = spawnSync(node, ["-e", parser], {
      input,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`Forge memory unavailable: ${code}\n`);
  }, 30_000);
}

test("integration: recipe prints the memory pointer once without another header", () => {
  const text =
    "Forge memory notes: general 1.\nBefore a task, search memory for its topic.";
  const result = spawnSync(node, ["-e", parser], {
    input: JSON.stringify({ ok: true, result: { text: { text } } }),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`${text}\n`);
}, 30_000);

test("startup recipe matches every SessionStart source including forks", () => {
  const block = recipe.split("```json\n")[1]?.split("\n```")[0];
  if (!block) throw new Error("Missing hook configuration");
  const config = JSON.parse(block) as {
    hooks: { SessionStart: { matcher?: string }[] };
  };
  for (const hook of config.hooks.SessionStart)
    expect(hook.matcher).toBeUndefined();
}, 30_000);

test("recipe gives a valid on-demand search and loop requires it", () => {
  const loop = readFileSync(
    resolve(repo, "templates/delivery/skills/loop/SKILL.md"),
    "utf8",
  );
  expect(recipe).toContain('forge memory search "<topic>"');
  expect(recipe).toContain("forge memory show <id>");
  expect(recipe).toContain("only hits in the named scopes or unscoped");
  expect(loop).toContain("Search memory before starting a task");
  expect(loop).toContain("search/show commands");
  expect(loop).toContain("never note text");
}, 30_000);
