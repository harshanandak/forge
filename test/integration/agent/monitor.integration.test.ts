import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

setDefaultTimeout(30_000);
type Input = {
  pr?: number;
  done?: boolean;
  sweep?: boolean;
  fallback?: boolean;
};
type Wait = { kind: string; steps: string[]; then: string };
type Env = Record<string, string>;
type Monitor = { command: string; timeout_ms: number; description: string };
const operations = require("../../../src/blocks/agent/entry.cts") as Record<
  string,
  (call: unknown) => Wait
>;
const agentsRoot = resolve(
  import.meta.dirname,
  "../../../templates/delivery/agents",
);
const adapters = ["claude", "codex", "t3"].map(
  (id) =>
    parse(fs.readFileSync(join(agentsRoot, `${id}.yaml`), "utf8")) as unknown,
);
const root = fs.mkdtempSync(join(tmpdir(), "forge-monitor-"));
const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const fixtures: string[] = [];
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function wait(input: Input = { pr: 42 }, env: Env = { CLAUDECODE: "1" }): Wait {
  return operations["agent.wait"]!({
    input,
    config: { adapters },
    services: {
      environment: {
        select: (names: readonly string[]) =>
          Object.fromEntries(
            names
              .filter((name) => env[name] !== undefined)
              .map((name) => [name, env[name]!]),
          ),
      },
    },
  });
}
function monitor(): Monitor {
  const result = wait();
  expect(result.kind).toBe("monitor");
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]).toContain("Monitor");
  return JSON.parse(
    result.steps[0]!.slice(result.steps[0]!.indexOf("{")),
  ) as Monitor;
}
function executable(path: string, text: string) {
  fs.writeFileSync(path, `#!/bin/sh\n${text}\n`);
  fs.chmodSync(path, 0o755);
}
function fixture() {
  const path = join(root, `case-${fixtures.length}`);
  fixtures.push(path);
  fs.mkdirSync(join(path, "bin"), { recursive: true });
  executable(
    join(path, "bin/forge"),
    `
printf '%s\\n' "$*" >> "$FORGE_TEST_ROOT/calls"
[ "$1" = pr ] && [ "$2" = state ] && [ "$3" = 42 ] || exit 91
if [ "$#" -ne 3 ]; then
  [ "$#" -eq 5 ] && [ "$4" = --since ] && [ -n "$5" ] || exit 91
fi
count=0
if [ -f "$FORGE_TEST_ROOT/count" ]; then count=$(cat "$FORGE_TEST_ROOT/count"); fi
count=$((count + 1))
printf '%s' "$count" > "$FORGE_TEST_ROOT/count"
news='{"pr":42,"head":"abc","verdict":"waiting","reasons":[],"news":["head moved"],"end":false,"next":"token-one"}'
ready='{"pr":42,"head":"abc","verdict":"ready","reasons":[],"news":["ready"],"end":true,"next":"token-two"}'
case "$FORGE_TEST_MODE" in
  news)
    case "$count" in 1) printf '%s\\n' "$news";; 2) :;; *) printf '%s\\n' "$ready";; esac;;
  duration) if [ "$count" -eq 1 ]; then printf '%s\\n' "$news"; fi;;
  resume) :;;
  fail) exit 1;;
  reset)
    if [ "$count" -eq 2 ]; then :
    elif [ "$count" -eq 4 ]; then printf '%s\\n' "$news"
    elif [ "$count" -eq 6 ]; then printf '%s\\n' "$ready"
    else exit 1; fi;;
  *) exit 91;;
esac`,
  );
  executable(
    join(path, "bin/sleep"),
    `
printf '%s\\n' "$*" >> "$FORGE_TEST_ROOT/sleeps"
case "$FORGE_TEST_MODE" in
  duration|resume) printf '1' > "$FORGE_TEST_ROOT/time";;
  fail) time=0
    [ ! -f "$FORGE_TEST_ROOT/time" ] || time=$(cat "$FORGE_TEST_ROOT/time")
    printf '%s' "$((time + $1))" > "$FORGE_TEST_ROOT/time";;
esac`,
  );
  executable(
    join(path, "bin/date"),
    'if [ -f "$FORGE_TEST_ROOT/time" ]; then cat "$FORGE_TEST_ROOT/time"; else printf "0\\n"; fi',
  );
  executable(
    join(path, "bin/gh"),
    'printf "unexpected gh call\\n" >&2; exit 92',
  );
  return path;
}
function shellPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}
function run(command: string, mode: string, extra: Env = {}) {
  const path = fixture();
  const retained =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => retained.test(name)),
  );
  const result = spawnSync(
    bash,
    ["-c", 'PATH="$FORGE_TEST_ROOT/bin:$PATH"; export PATH\n' + command],
    {
      cwd: path,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...env,
        FORGE_TEST_ROOT: shellPath(path),
        FORGE_TEST_MODE: mode,
        ...extra,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return {
    stdout: result.stdout,
    calls: fs.readFileSync(join(path, "calls"), "utf8").trim().split("\n"),
    sleeps: fs
      .readFileSync(join(path, "sleeps"), "utf8")
      .trim()
      .split("\n")
      .map(Number),
  };
}
function events(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("shipped Claude adapter renders a bounded Monitor with fresh-state guidance", () => {
  const config = monitor();
  expect(config.timeout_ms).toBe(1_800_000);
  expect(config.description).toBe("PR #42: checks, threads, conflicts");
  expect(config.command).toContain("forge pr state");
  expect(config.command).not.toMatch(/\beval\b/);
  expect(wait().then).toMatch(/forge pr state 42/);
  expect(wait().then).toMatch(/rearm/i);
  expect(wait().then).toMatch(/(?:last|next).*token|token.*(?:last|next)/i);
});
test("cleanup has no Monitor, fallback uses gh-checks, and T3 overrides Claude", () => {
  for (const input of [
    { pr: 42, done: true },
    { sweep: true },
    { pr: 42, sweep: true },
  ])
    expect(wait(input).steps).toEqual([]);
  expect(wait({ pr: 42, fallback: true }).kind).toBe("gh-checks");
  for (const env of [{}, { CODEX_THREAD_ID: "1" }])
    expect(wait({ pr: 42 }, env).kind).toBe("gh-checks");
  for (const signal of ["T3CODE_THREAD_ID", "T3CODE_CLI_PATH"])
    expect(
      wait({ pr: 42 }, { CLAUDECODE: "1", [signal]: "fixture" }).kind,
    ).toBe("t3-tool");
});
test("Monitor polls news once, remains quiet on unchanged state, and stops at ready", () => {
  const result = run(monitor().command, "news");
  expect(events(result.stdout)).toHaveLength(2);
  expect(result.stdout.match(/head moved/g)).toHaveLength(1);
  expect(events(result.stdout)[1]!.end).toBe(true);
  expect(result.calls).toHaveLength(3);
  expect(result.calls[0]).toMatch(/^pr state 42(?: |$)/);
  expect(result.calls[1]).toContain("--since token-one");
  expect(result.calls[2]).toContain("--since token-one");
  expect(result.sleeps).toEqual([60, 60]);
});
test("Monitor honors cadence and hands its token to the next quiet bounded run", () => {
  const command = monitor().command;
  expect(run(command, "news", { FORGE_MONITOR_INTERVAL: "7" }).sleeps).toEqual([
    7, 7,
  ]);
  const result = run(command, "duration", {
    FORGE_MONITOR_INTERVAL: "7",
    FORGE_MONITOR_DURATION: "1",
  });
  const output = events(result.stdout);
  expect(output[0]!.news).toEqual(["head moved"]);
  expect(output.at(-1)).toMatchObject({
    pr: 42,
    kind: "rearm",
    next: "token-one",
  });
  expect(result.sleeps.length).toBeGreaterThan(0);
  expect(result.sleeps.every((seconds) => seconds > 0 && seconds <= 1)).toBe(
    true,
  );
  const resumed = run(command, "resume", {
    FORGE_MONITOR_SINCE: "token-one",
    FORGE_MONITOR_DURATION: "1",
  });
  expect(events(resumed.stdout)).toEqual([
    { pr: 42, kind: "rearm", next: "token-one" },
  ]);
  expect(
    resumed.calls.every((call) => call.includes("--since token-one")),
  ).toBe(true);
  expect(resumed.stdout).not.toContain("head moved");
});
test("Monitor stops on the fifteenth failure before rearm with default cadence and duration", () => {
  const result = run(monitor().command, "fail");
  expect(result.calls).toHaveLength(15);
  expect(events(result.stdout)).toEqual([
    { pr: 42, kind: "unreadable", fails: 15, next: "" },
  ]);
  expect(result.sleeps).toHaveLength(14);
  expect(result.sleeps).toEqual(Array(14).fill(60));
  expect(result.sleeps.reduce((total, seconds) => total + seconds, 0)).toBe(840);
});
test("successful empty and news polls each reset the consecutive failure counter", () => {
  const result = run(monitor().command, "reset", {
    FORGE_MONITOR_FAILURE_LIMIT: "2",
  });
  expect(result.calls).toHaveLength(6);
  expect(result.stdout).not.toContain("unreadable");
  expect(events(result.stdout).at(-1)!.end).toBe(true);
  expect(result.sleeps).toEqual([60, 60, 60, 60, 60]);
});
test("Monitor honors a test-only failure limit", () => {
  const result = run(monitor().command, "fail", {
    FORGE_MONITOR_FAILURE_LIMIT: "2",
  });
  expect(result.calls).toHaveLength(2);
  expect(events(result.stdout)).toEqual([
    { pr: 42, kind: "unreadable", fails: 2, next: "" },
  ]);
});
