import { expect, setDefaultTimeout, test } from "bun:test";
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
  expect(sweep.then).toMatch(/merged.*closed.*forge agent wait.*--done/i);
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
test("guard gives a clear warning when no done-claim guard exists", () => {
  for (const input of [{ id: "unknown" }, {}]) {
    const result = operations["agent.guard"]!(
      call(input, [{ id: "plain", detect: [], guard: { kind: "none" } }]),
    ) as Guard;
    expect(result.config).toBeUndefined();
    expect(result.instruction).toMatch(/no done-claim guard/i);
  }
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
