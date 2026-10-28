import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

setDefaultTimeout(60_000);
const root = mkdtempSync(join(tmpdir(), "forge-route-"));
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const node = Bun.which("node")!;
// Copy only OS/process essentials: inherited harness variables must not choose the result.
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(name),
  ),
);
env.FORGE_DEVICE_ROOT = join(root, "device");
type WaitResult = { kind: string; steps: string[]; then: string };
type GuardResult = {
  file: string;
  instruction: string;
  config: { hooks: { Stop: { hooks: { type: string; command: string }[] }[] } };
};
function readResult<T>(stdout: string): T {
  return (JSON.parse(stdout) as { result: T }).result;
}
function hookPath(command: string): string {
  expect(command.startsWith("node ")).toBe(true);
  const quoted = command.slice(5);
  if (quoted.startsWith('"')) {
    expect(quoted).toMatch(/^"[^"]+"$/);
    return quoted.slice(1, -1);
  }
  const path = quoted.slice(1, -1).replaceAll("'\\''", "'");
  expect(quoted).toBe(`'${path.replaceAll("'", "'\\''")}'`);
  return path;
}
function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(node, [bin, ...args], {
    cwd: root,
    env: { ...env, ...extra },
    encoding: "utf8",
    windowsHide: true,
    timeout: 45_000,
  });
}
beforeAll(() => {
  writeFileSync(
    join(root, "package.json"),
    '{"name":"route-fixture","scripts":{"test":"node --version"}}',
  );
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    '{"schemaVersion":"forge.config/1","blocks":{}}',
  );
  const show = JSON.parse(run(["config", "show"]).stdout) as {
    result: { revision: string };
  };
  const imported = run([
    "template",
    "import",
    "delivery",
    "--expect-revision",
    show.result.revision,
  ]);
  expect(imported.stdout).toContain('"ok":true');
  expect(imported.status).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("imported delivery detects Claude without admission or persisted adapter config", () => {
  const result = run(["route", "get", "build", "--text"], { CLAUDECODE: "1" });
  expect(result.stdout).toContain(
    "line: current high standard claude single-family",
  );
  expect(result.status).toBe(0);
  expect(readFileSync(join(root, ".forge/config.yaml"), "utf8")).not.toContain(
    "adapters",
  );
});
test("no detect variable uses current", () => {
  const result = run(["route", "get", "build", "--text"]);
  expect(result.stdout).toContain(
    "line: current high standard current single-family",
  );
  expect(result.status).toBe(0);
});
test("Codex wins over inherited CLAUDECODE", () => {
  const result = run(["route", "get", "build", "--text"], {
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "test",
  });
  expect(result.stdout).toContain(
    "line: current high standard codex single-family",
  );
  expect(result.status).toBe(0);
});

for (const [name, extra, harness, guard, kind] of [
  [
    "T3 Claude with only the thread signal",
    { CLAUDECODE: "1", T3CODE_THREAD_ID: "fixture" },
    "t3",
    "~/.claude/settings.json",
    "t3-tool",
  ],
  [
    "T3 Codex with only the thread signal",
    { CODEX_THREAD_ID: "1", T3CODE_THREAD_ID: "fixture" },
    "t3",
    "~/.codex/hooks.json",
    "t3-tool",
  ],
  [
    "development Codex without a T3 signal ignores the overridable originator",
    { CODEX_THREAD_ID: "1", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" },
    "codex",
    "~/.codex/hooks.json",
    "gh-checks",
  ],
  [
    "T3 Claude",
    { CLAUDECODE: "1", T3CODE_CLI_PATH: "fixture" },
    "t3",
    "~/.claude/settings.json",
    "t3-tool",
  ],
  [
    "T3 Codex",
    { CODEX_THREAD_ID: "1", T3CODE_CLI_PATH: "fixture" },
    "t3",
    "~/.codex/hooks.json",
    "t3-tool",
  ],
  [
    "T3 Codex with inherited Claude",
    { CLAUDECODE: "1", CODEX_THREAD_ID: "1", T3CODE_CLI_PATH: "fixture" },
    "t3",
    "~/.codex/hooks.json",
    "t3-tool",
  ],
  [
    "Claude alone",
    { CLAUDECODE: "1" },
    "claude",
    "~/.claude/settings.json",
    "monitor",
  ],
  [
    "Codex alone",
    { CODEX_THREAD_ID: "1" },
    "codex",
    "~/.codex/hooks.json",
    "gh-checks",
  ],
  ["no harness", {}, "current", undefined, "gh-checks"],
] as const) {
  test(`${name} selects the shipped watch and guard`, () => {
    const route = run(["route", "get", "build"], extra);
    expect(route.status).toBe(0);
    expect(readResult<{ harness: string }>(route.stdout).harness).toBe(harness);
    const wait = run(["agent", "wait", "7"], extra);
    expect(wait.status).toBe(0);
    expect(readResult<WaitResult>(wait.stdout).kind).toBe(kind);
    if (guard) {
      const result = run(["agent", "guard"], extra);
      expect(result.status).toBe(0);
      expect(readResult<GuardResult>(result.stdout).file).toBe(guard);
    }
  });
}

test("inherited T3 detection supports the explicit worker wait fallback", () => {
  const result = run(["agent", "wait", "7", "--fallback"], {
    T3CODE_CLI_PATH: "fixture",
    CODEX_THREAD_ID: "1",
    CLAUDECODE: "1",
  });
  expect(result.status).toBe(0);
  expect(readResult<WaitResult>(result.stdout).kind).toBe("gh-checks");
});
test("the shipped Codex adapter detects only its exact variable", () => {
  const result = run(["route", "get", "build", "--text"], {
    CODEX_THREAD_ID: "test",
  });
  expect(result.stdout).toContain(
    "line: current high standard codex single-family",
  );
  expect(result.status).toBe(0);
  const companion = run(["route", "get", "build", "--text"], {
    CODEX_COMPANION_SESSION_ID: "test",
  });
  expect(companion.stdout).toContain(
    "line: current high standard current single-family",
  );
  expect(companion.status).toBe(0);
});
test("environment names follow the host platform's casing rules", () => {
  const result = run(["route", "get", "build", "--text"], { claudecode: "1" });
  const harness = process.platform === "win32" ? "claude" : "current";
  expect(result.stdout).toContain(
    `line: current high standard ${harness} single-family`,
  );
  expect(result.status).toBe(0);
});
test("explicit project adapters replace the derived list", () => {
  const config = join(root, ".forge/config.yaml");
  const original = readFileSync(config, "utf8");
  try {
    const show = JSON.parse(run(["config", "show"]).stdout) as {
      result: { revision: string };
    };
    const set = run([
      "config",
      "set",
      "--input",
      JSON.stringify({
        path: "agent.adapters",
        value: [],
        expectRevision: show.result.revision,
      }),
    ]);
    expect(set.stdout).toContain('"ok":true');
    expect(set.status).toBe(0);
    const result = run(["route", "get", "build", "--text"], {
      CLAUDECODE: "1",
      CODEX_THREAD_ID: "test",
    });
    expect(result.stdout).toContain(
      "line: current high standard current single-family",
    );
    expect(result.status).toBe(0);
  } finally {
    writeFileSync(config, original);
  }
});
test("a renamed forge/agent instance still detects the harness", () => {
  const config = join(root, ".forge/config.yaml");
  const original = readFileSync(config, "utf8");
  try {
    const show = JSON.parse(run(["config", "show"]).stdout) as {
      result: { revision: string };
    };
    const changed = run([
      "config",
      "apply",
      "--input",
      JSON.stringify({
        expectRevision: show.result.revision,
        patch: [
          { op: "remove", path: "/blocks/agent" },
          {
            op: "set",
            path: "/blocks/router",
            value: { source: { builtin: "forge/agent" } },
          },
        ],
      }),
    ]);
    expect(changed.stdout).toContain('"ok":true');
    expect(changed.status).toBe(0);
    const result = run(["route", "get", "build", "--text"], {
      CLAUDECODE: "1",
    });
    expect(result.stdout).toContain(
      "line: current high standard claude single-family",
    );
    expect(result.status).toBe(0);
  } finally {
    writeFileSync(config, original);
  }
});
test("unknown role lists all allowed roles with INPUT_INVALID", () => {
  const result = run(["route", "get", "deploy"]);
  expect(result.stdout).toContain("INPUT_INVALID");
  for (const role of [
    "intake",
    "plan",
    "cut",
    "build",
    "review",
    "land",
    "learn",
    "rate",
    "merge",
    "judge",
    "verify",
  ])
    expect(result.stdout).toContain(role);
  expect(result.status).toBe(6);
});
test("max names the routing file with INPUT_INVALID", () => {
  const result = run(["route", "get", "build", "--max"]);
  expect(result.stdout).toContain("~/.forge/routing.yaml");
  expect(result.stdout).toContain("INPUT_INVALID");
  expect(result.status).toBe(6);
});

test("agent wait and cleanup render guidance without contacting GitHub", () => {
  for (const harness of [{}, { CODEX_THREAD_ID: "1" }]) {
    const result = run(["agent", "wait", "42"], harness);
    expect(result.status).toBe(0);
    const value = readResult<WaitResult>(result.stdout);
    expect(value).toEqual({
      kind: "gh-checks",
      steps: ["gh pr checks 42 --watch --fail-fast --interval 60"],
      then: value.then,
    });
    expect(value.then).toMatch(/fresh.*state.*act/i);
    expect(value.then).toContain("forge pr state 42");
    expect(value.then).toContain(
      "Run forge agent wait 42 again after each push",
    );
  }
  for (const args of [["42", "--done"], ["--sweep"], ["42", "--sweep"]]) {
    const result = run(["agent", "wait", ...args]);
    expect(result.status).toBe(0);
    expect(readResult<WaitResult>(result.stdout).steps).toEqual([]);
  }
  expect(run(["agent", "wait", "0"]).status).toBe(6);
  expect(run(["agent", "wait", "42", "--done", "--sweep"]).status).toBe(6);
});

test("shipped guards resolve an existing installed companion from an unrelated cwd", () => {
  for (const [id, file] of [
    ["claude", "~/.claude/settings.json"],
    ["codex", "~/.codex/hooks.json"],
  ] as const) {
    const result = run(["agent", "guard", id]);
    expect(result.status).toBe(0);
    const guard = readResult<GuardResult>(result.stdout);
    expect(guard.file).toBe(file);
    const hook = guard.config.hooks.Stop[0]!.hooks[0]!;
    expect(hook.type).toBe("command");
    const path = hookPath(hook.command);
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("done-claim.mjs");
  }
  const detected = run(["agent", "guard"], { CODEX_THREAD_ID: "1" });
  expect(detected.status).toBe(0);
  expect(readResult<GuardResult>(detected.stdout).file).toBe(
    "~/.codex/hooks.json",
  );
  const unknown = run(["agent", "guard", "unknown"]);
  expect(unknown.status).toBe(6);
  for (const text of ["INPUT_INVALID", "claude", "codex"])
    expect(unknown.stdout).toContain(text);
});

test("R1b-1 a symlinked package prints its canonical hook path while logical prefix comparison fails", () => {
  const logical = join(root, "logical-package");
  const canonical = realpathSync(resolve(import.meta.dirname, "../../.."));
  symlinkSync(
    canonical,
    logical,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = spawnSync(
    node,
    [
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      join(logical, "dist/bin/forge.js"),
      "agent",
      "guard",
      "codex",
    ],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 45_000 },
  );
  expect(result.status).toBe(0);
  const guard = readResult<GuardResult>(result.stdout);
  const printed = hookPath(guard.config.hooks.Stop[0]!.hooks[0]!.command);
  const expected = join(
    logical,
    "templates/delivery/skills/forge-build/done-claim.mjs",
  );
  const oldPrefixComparison = printed.startsWith(logical.replaceAll("\\", "/"));
  console.log(
    JSON.stringify({
      logical,
      canonical,
      printed,
      oldPrefixComparison,
      resolvedPrinted: realpathSync(printed),
      resolvedExpected: realpathSync(expected),
    }),
  );
  expect(oldPrefixComparison).toBe(false);
  expect(printed).toBe(realpathSync(expected).replaceAll("\\", "/"));
  expect(realpathSync(printed)).toBe(realpathSync(expected));
});

test("R1-5 an undetected agent refuses and lists known ids", () => {
  const result = run(["agent", "guard"]);
  expect(result.status).toBe(6);
  for (const text of [
    "INPUT_INVALID",
    "no agent detected; name one:",
    "claude",
    "codex",
  ])
    expect(result.stdout).toContain(text);
});

test("configured T3 capability renders native watch and cleanup steps", () => {
  const config = join(root, ".forge/config.yaml");
  const original = readFileSync(config, "utf8");
  try {
    const show = JSON.parse(run(["config", "show"]).stdout) as {
      result: { revision: string };
    };
    const set = run([
      "config",
      "set",
      "--input",
      JSON.stringify({
        path: "agent.adapters",
        value: [
          {
            id: "t3",
            detect: ["T3_FIXTURE"],
            prWatch: "t3-tool",
            guard: { kind: "none" },
          },
        ],
        expectRevision: show.result.revision,
      }),
    ]);
    expect(set.status).toBe(0);
    for (const [args, step] of [
      [["42"], "watch_pull_request"],
      [["42", "--done"], "unwatch_pull_request"],
      [["--sweep"], "list_thread_pull_requests"],
    ] as const) {
      const result = run(["agent", "wait", ...args], { T3_FIXTURE: "1" });
      expect(result.status).toBe(0);
      const value = readResult<WaitResult>(result.stdout);
      expect(value.kind).toBe("t3-tool");
      expect(value.steps.join(" ")).toContain(step);
    }
    const guard = run(["agent", "guard"], { T3_FIXTURE: "1" });
    expect(guard.status).toBe(0);
    expect(readResult<GuardResult>(guard.stdout).instruction).toContain(
      "no done-claim guard for t3",
    );
    const fallback = run(["agent", "wait", "42", "--fallback"], {
      T3_FIXTURE: "1",
    });
    expect(fallback.status).toBe(0);
    expect(readResult<WaitResult>(fallback.stdout).steps).toEqual([
      "gh pr checks 42 --watch --fail-fast --interval 60",
    ]);
  } finally {
    writeFileSync(config, original);
  }
});

test("an invalid shipped adapter names its YAML file, field and allowed values", () => {
  const packageRoot = resolve(import.meta.dirname, "../../..");
  const fixture = join(root, "invalid-adapter-package");
  mkdirSync(fixture);
  cpSync(join(packageRoot, "dist"), join(fixture, "dist"), { recursive: true });
  cpSync(join(packageRoot, "templates"), join(fixture, "templates"), {
    recursive: true,
  });
  cpSync(join(packageRoot, "package.json"), join(fixture, "package.json"));
  symlinkSync(
    join(packageRoot, "node_modules"),
    join(fixture, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const file = join(fixture, "templates/delivery/agents/codex.yaml");
  const original = readFileSync(file, "utf8");
  for (const [field, value, allowed] of [
    ["prWatch", "bogus", ["t3-tool", "monitor", "watch-block", "gh-checks"]],
    ["guard", "{ kind: unknown }", ["hook", "none"]],
  ] as const) {
    writeFileSync(
      file,
      original.replace(
        new RegExp(`^${field}:.*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*`, "m"),
        `${field}: ${value}`,
      ),
    );
    const result = spawnSync(
      node,
      [join(fixture, "dist/bin/forge.js"), "agent", "wait", "42"],
      { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 45_000 },
    );
    expect(result.status).not.toBe(0);
    for (const text of ["codex.yaml", field, ...allowed])
      expect(result.stdout + result.stderr).toContain(text);
  }
  writeFileSync(file, `${original}\nunknownCapability: true\n`);
  const unknown = spawnSync(
    node,
    [join(fixture, "dist/bin/forge.js"), "agent", "wait", "42"],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 45_000 },
  );
  expect(unknown.status).not.toBe(0);
  for (const text of ["codex.yaml", "unknownCapability", "Unknown field"])
    expect(unknown.stdout + unknown.stderr).toContain(text);
});
