import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type JsonSchema,
  validateWithSchema,
} from "../../../src/contract/schema.ts";

setDefaultTimeout(30_000);
type Adapter = {
  id: string;
  detect: string[];
  prWatch?: string;
  guard?: { kind: string; file?: string; stop?: string; command?: string };
};
type Call = {
  input: {
    pr?: number;
    done?: boolean;
    sweep?: boolean;
    fallback?: boolean;
    id?: string;
  };
  config: { adapters: Adapter[] };
  services: {
    environment: {
      packageRoot: string;
      platform: NodeJS.Platform;
      select(names: readonly string[]): Record<string, string>;
    };
  };
};
type Wait = { kind: string; steps: string[]; then: string };
type Guard = {
  file?: string;
  instruction: string;
  config?: {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
  };
};
const operations = require("../../../src/blocks/agent/entry.cts") as Record<
  string,
  (call: Call) => Wait | Guard
>;
const root = resolve(import.meta.dirname, "../../../src/blocks/agent");
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});
function call(
  input: Call["input"],
  adapters: Adapter[] = [],
  env: Record<string, string> = {},
): Call {
  return {
    input,
    config: { adapters },
    services: {
      environment: {
        packageRoot: "C:/Forge install",
        platform: "win32",
        select: (names) =>
          Object.fromEntries(
            names
              .filter((name) => env[name] !== undefined)
              .map((name) => [name, env[name]!]),
          ),
      },
    },
  };
}
const codex: Adapter = {
  id: "codex",
  detect: ["CODEX_THREAD_ID"],
  prWatch: "t3-tool",
  guard: {
    kind: "hook",
    file: "~/.codex/hooks.json",
    stop: "Stop",
    command: "PreToolUse",
  },
};
function wait(
  input: Call["input"],
  adapters: Adapter[] = [],
  env: Record<string, string> = {},
): Wait {
  return operations["agent.wait"]!(call(input, adapters, env)) as Wait;
}
test("wait renders the foreground command without running or backgrounding it", () => {
  const result = wait({ pr: 42 });
  expect(result).toEqual({
    kind: "gh-checks",
    steps: ["gh pr checks 42 --watch"],
    then: result.then,
  });
  expect(result.then).toMatch(/fresh.*state.*act/i);
  expect(wait({ pr: 42, done: true }).steps).toEqual([]);
  expect(wait({ sweep: true }).steps).toEqual([]);
});
test("wait uses exactly-one detection, with fallback for old, ambiguous and watch-block adapters", () => {
  expect(wait({ pr: 42 }, [codex], { CODEX_THREAD_ID: "1" }).kind).toBe(
    "t3-tool",
  );
  expect(
    wait({ pr: 42, fallback: true }, [codex], { CODEX_THREAD_ID: "1" }),
  ).toEqual(wait({ pr: 42 }));
  for (const adapters of [
    [{ id: "old", detect: ["YES"] }],
    [{ id: "block", detect: ["YES"], prWatch: "watch-block" }],
    [codex, { id: "other", detect: ["YES"], prWatch: "t3-tool" }],
  ]) {
    expect(
      wait({ pr: 42 }, adapters, { YES: "1", CODEX_THREAD_ID: "1" }).kind,
    ).toBe("gh-checks");
  }
});
test("T3 wait links the real URL before watching, and cleanup names native tools", () => {
  const env = { CODEX_THREAD_ID: "1" };
  const result = wait({ pr: 42 }, [codex], env);
  expect(result.steps[0]).toBe("gh pr view 42 --json url");
  expect(result.steps[1]).toMatch(/link_pull_request.*URL.*stdout/);
  expect(result.steps[2]).toMatch(/watch_pull_request.*42/);
  expect(wait({ pr: 42, done: true }, [codex], env).steps.join(" ")).toMatch(
    /unwatch_pull_request.*42/,
  );
  expect(result.then).toMatch(
    /end the turn; T3 wakes this thread on PR events/i,
  );
  const sweep = wait({ pr: 42, sweep: true }, [codex], env);
  expect(sweep.steps).toEqual(["list_thread_pull_requests"]);
  expect(sweep.then).toMatch(
    /session resumed.*forge agent wait.*--done.*merged.*closed/i,
  );
});
test("guard renders a quoted installed companion path for a named or detected hook", () => {
  for (const input of [{ id: "codex" }, {}]) {
    const result = operations["agent.guard"]!(
      call(input, [codex], { CODEX_THREAD_ID: "1" }),
    ) as Guard;
    expect(result.file).toBe("~/.codex/hooks.json");
    expect(result.config).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'node "C:/Forge install/templates/delivery/skills/forge-build/done-claim.mjs"',
              },
            ],
          },
        ],
      },
    });
    expect(result.instruction).toMatch(/merge/i);
  }
});
test("guard gives a clear warning when the named adapter has no done-claim guard", () => {
  for (const input of [{ id: "plain" }]) {
    const result = operations["agent.guard"]!(
      call(input, [{ id: "plain", detect: [], guard: { kind: "none" } }]),
    ) as Guard;
    expect(result.config).toBeUndefined();
    expect(result.instruction).toMatch(/no done-claim guard/i);
  }
});

test("R1b-2 POSIX guard quotes shell expansions, apostrophes and other metacharacters", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const fixture = call({ id: "codex" }, [codex]);
    fixture.services.environment.platform = platform;
    fixture.services.environment.packageRoot =
      '/tmp/Forge $(x) owner\'s `tick` $HOME "quoted"';
    const result = operations["agent.guard"]!(fixture) as Guard;
    expect(result.config!.hooks.Stop![0]!.hooks[0]!.command).toBe(
      "node '/tmp/Forge $(x) owner'\\''s `tick` $HOME \"quoted\"/templates/delivery/skills/forge-build/done-claim.mjs'",
    );
  }
});

test("R1b-2 Windows guard quotes spaces and dollar-parentheses and refuses embedded quotes", () => {
  const fixture = call({ id: "codex" }, [codex]);
  fixture.services.environment.packageRoot = "C:\\Forge $(x) install";
  const result = operations["agent.guard"]!(fixture) as Guard;
  expect(result.config!.hooks.Stop![0]!.hooks[0]!.command).toBe(
    'node "C:/Forge $(x) install/templates/delivery/skills/forge-build/done-claim.mjs"',
  );
  fixture.services.environment.packageRoot = 'C:/Forge "quoted" install';
  expect(() => operations["agent.guard"]!(fixture)).toThrow("INPUT_INVALID");
});
test("adapter schema keeps optional capabilities closed and validates guard branches", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/adapter.json"), "utf8"),
  ) as JsonSchema;
  for (const value of [
    codex,
    { id: "plain", detect: [], guard: { kind: "none" } },
    { id: "old", detect: [] },
  ])
    expect(validateWithSchema(schema, value)).toEqual([]);
  for (const extra of [
    { prWatch: "future" },
    { guard: { kind: "hook", file: "a", stop: "Stop" } },
    { guard: { kind: "none", file: "a" } },
    {
      guard: {
        kind: "hook",
        file: "a",
        stop: "Stop",
        command: "PreToolUse",
        extra: true,
      },
    },
  ])
    expect(
      validateWithSchema(schema, { id: "bad", detect: [], ...extra }),
    ).not.toEqual([]);
});
test("wait schema rejects missing identity, nonpositive numbers and conflicting modes", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/wait.input.json"), "utf8"),
  ) as JsonSchema;
  for (const value of [
    { pr: 42 },
    { pr: 42, done: true },
    { sweep: true },
    { pr: 42, sweep: true },
    { pr: 42, fallback: true },
  ])
    expect(validateWithSchema(schema, value)).toEqual([]);
  for (const value of [
    {},
    { pr: 0 },
    { pr: -1 },
    { pr: 1.5 },
    { done: true },
    { fallback: true },
    { pr: 42, done: true, sweep: true },
    { pr: 42, fallback: true, sweep: true },
    { pr: 42, fallback: true, done: true },
  ])
    expect(validateWithSchema(schema, value)).not.toEqual([]);
});
