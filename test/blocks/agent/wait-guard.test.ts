import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import {
  type JsonSchema,
  validateWithSchema,
} from "../../../src/contract/schema.ts";
import { DEFAULT_PARSE_LIMITS } from "../../../src/contract/untrusted.ts";

setDefaultTimeout(30_000);
type Adapter = {
  id: string;
  detect: string[];
  over?: string[];
  skills?: string;
  prWatch?: string;
  guard?: {
    kind: string;
    file?: string;
    stop?: string;
    command?: string;
    output?: string;
  };
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
    hooks: Record<
      string,
      { matcher?: string; hooks: { type: string; command: string }[] }[]
    >;
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
    steps: ["gh pr checks 42 --watch --fail-fast --interval 60"],
    then: result.then,
  });
  expect(result.then).toMatch(/fresh.*state.*act/i);
  expect(result.then).toContain("forge pr state 42");
  expect(result.then).toContain(
    "Run forge agent wait 42 again after each push",
  );
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
  expect(result.then).toContain("forge pr state 42");
  expect(result.steps[0]).toBe("gh pr view 42 --json url");
  expect(result.then).toContain(
    "Only if the harness reports it stopped watching the PR, run forge agent wait 42 once more and do its steps.",
  );
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
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  'node "C:/Forge install/templates/delivery/harness/guard.mjs"',
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
    expect(result.instruction).toContain("no command guard");
  }
});

test("output hooks preserve every existing hook and select each harness protocol", () => {
  for (const output of ["claude", "codex"]) {
    const adapter = { ...codex, guard: { ...codex.guard!, output } };
    const baseline = operations["agent.guard"]!(
      call({ id: "codex" }, [codex]),
    ) as Guard;
    const result = operations["agent.guard"]!(
      call({ id: "codex" }, [adapter]),
    ) as Guard;
    const hooks = result.config!.hooks;
    expect(hooks.PostToolUse).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `node "C:/Forge install/templates/delivery/harness/output-guard.mjs" ${output}`,
          },
        ],
      },
    ]);
    if (output === "claude")
      expect(hooks.PostToolUseFailure).toEqual(hooks.PostToolUse);
    else expect(hooks.PostToolUseFailure).toBeUndefined();
    const {
      PostToolUse: _post,
      PostToolUseFailure: _failure,
      ...existing
    } = hooks;
    expect(JSON.stringify(existing)).toBe(
      JSON.stringify(baseline.config!.hooks),
    );
  }
});

for (const harness of ["claude", "codex"])
  test(`shipped ${harness} adapter leaves output hooks opt-in`, () => {
    const decoded = yamlConfigCodec.decode(
      readFileSync(
        resolve(root, `../../../templates/delivery/agents/${harness}.yaml`),
        "utf8",
      ),
      DEFAULT_PARSE_LIMITS,
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.message);
    const adapter = decoded.value as Adapter;
    const result = operations["agent.guard"]!(
      call({ id: harness }, [adapter]),
    ) as Guard;
    const hooks = result.config!.hooks;
    expect(hooks.PostToolUse).toBeUndefined();
    expect(hooks.PostToolUseFailure).toBeUndefined();
    expect(JSON.stringify(hooks)).not.toContain("output-guard.mjs");
    expect(hooks.Stop![0]!.hooks[0]!.command).toContain("done-claim.mjs");
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toContain(
      "harness/guard.mjs",
    );
  });

for (const platform of ["win32", "linux", "darwin"] as const) {
  test(`R2-3 ${platform} guard double-quotes installed paths containing spaces`, () => {
    const fixture = call({ id: "codex" }, [codex]);
    fixture.services.environment.platform = platform;
    fixture.services.environment.packageRoot =
      platform === "win32" ? "C:\\Forge install" : "/tmp/Forge install";
    const result = operations["agent.guard"]!(fixture) as Guard;
    expect(result.config!.hooks.Stop![0]!.hooks[0]!.command).toBe(
      `node "${platform === "win32" ? "C:" : "/tmp"}/Forge install/templates/delivery/skills/forge-build/done-claim.mjs"`,
    );
    expect(result.config!.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(
      `node "${platform === "win32" ? "C:" : "/tmp"}/Forge install/templates/delivery/harness/guard.mjs"`,
    );
  });
  for (const character of ["$", "`", '"', "'", "%", "!"]) {
    test(`R2-3 ${platform} guard refuses installed paths containing ${character}`, () => {
      const fixture = call({ id: "codex" }, [codex]);
      fixture.services.environment.platform = platform;
      fixture.services.environment.packageRoot = `/tmp/Forge ${character} install`;
      expect(() => operations["agent.guard"]!(fixture)).toThrow(
        `INPUT_INVALID: Unsupported path character ${character}`,
      );
    });
  }
  test(`R2-3 ${platform} guard refuses dollar-parentheses in installed paths containing spaces`, () => {
    const fixture = call({ id: "codex" }, [codex]);
    fixture.services.environment.platform = platform;
    fixture.services.environment.packageRoot =
      platform === "win32"
        ? "C:\\Forge $(x) install"
        : "/tmp/Forge $(x) install";
    expect(() => operations["agent.guard"]!(fixture)).toThrow(
      "INPUT_INVALID: Unsupported path character $",
    );
  });
}
test("guard refuses colliding hook events", () => {
  expect(() =>
    operations["agent.guard"]!(
      call({ id: "codex" }, [
        { ...codex, guard: { ...codex.guard!, command: "Stop" } },
      ]),
    ),
  ).toThrow("INPUT_INVALID");
});

for (const { field, event, output } of [
  { field: "command", event: "PostToolUse", output: "codex" },
  { field: "command", event: "PostToolUse", output: "claude" },
  { field: "stop", event: "PostToolUseFailure", output: "claude" },
] as const) {
  test(`guard refuses ${field} ${event} colliding with ${output} output`, () => {
    expect(() =>
      operations["agent.guard"]!(
        call({ id: "codex" }, [
          {
            ...codex,
            guard: { ...codex.guard!, [field]: event, output },
          },
        ]),
      ),
    ).toThrow(
      `INPUT_INVALID: Output hook event ${event} conflicts with guard.${field}; move guard.${field} to another event or drop guard.output`,
    );
  });
}

test("adapter schema keeps optional capabilities closed and validates guard branches", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/adapter.json"), "utf8"),
  ) as JsonSchema;
  for (const value of [
    codex,
    { id: "plain", detect: [], guard: { kind: "none" } },
    { id: "old", detect: [] },
    { id: "t3", detect: [], over: ["codex", "claude"] },
  ])
    expect(validateWithSchema(schema, value)).toEqual([]);
  for (const extra of [
    { over: ["codex", "codex"] },
    { over: ["Bad ID"] },
    { over: "claude" },
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

test("precedence inherits the first matching over adapter without mutating config", () => {
  const adapters: Adapter[] = [
    {
      ...codex,
      prWatch: "gh-checks",
      skills: ".agents/skills",
      over: ["claude"],
    },
    { id: "claude", detect: ["CLAUDECODE"], skills: ".claude/skills" },
    {
      id: "t3",
      detect: ["T3CODE_CLI_PATH"],
      over: ["codex", "claude"],
      prWatch: "t3-tool",
    },
  ];
  const before = structuredClone(adapters);
  const env = {
    CODEX_THREAD_ID: "1",
    CLAUDECODE: "1",
    T3CODE_CLI_PATH: "fixture",
  };
  expect(wait({ pr: 7 }, adapters, env).kind).toBe("t3-tool");
  expect(
    (operations["agent.guard"]!(call({}, adapters, env)) as Guard).file,
  ).toBe("~/.codex/hooks.json");
  expect(wait({ pr: 7, fallback: true }, adapters, env).kind).toBe("gh-checks");
  expect(adapters).toEqual(before);
});

test("precedence leaves unrelated ties and cycles undetected", () => {
  for (const adapters of [
    [
      { id: "a", over: ["b"] },
      { id: "b", over: ["a"] },
    ],
    [{ id: "a", over: ["missing"] }, { id: "b" }],
  ]) {
    expect(
      wait(
        { pr: 7 },
        adapters.map((adapter) => ({
          ...adapter,
          detect: ["YES"],
          prWatch: "t3-tool",
        })),
        { YES: "1" },
      ).kind,
    ).toBe("gh-checks");
  }
});

test("an adapter listing itself in over remains detected", () => {
  const solo: Adapter = {
    ...codex,
    id: "solo",
    over: ["solo"],
    guard: { ...codex.guard!, file: "solo.json" },
  };
  const env = { CODEX_THREAD_ID: "1" };
  expect(wait({ pr: 7 }, [solo], env).kind).toBe("t3-tool");
  expect(
    (operations["agent.guard"]!(call({}, [solo], env)) as Guard).file,
  ).toBe("solo.json");
});

test("precedence only inherits from the first matched adapter and preserves explicit capabilities", () => {
  const claude: Adapter = {
    ...codex,
    id: "claude",
    detect: ["CLAUDECODE"],
    guard: { ...codex.guard!, file: "~/.claude/settings.json" },
  };
  const t3: Adapter = {
    id: "t3",
    detect: ["T3"],
    over: ["missing", "codex", "claude"],
    prWatch: "t3-tool",
  };
  const env = { T3: "1", CLAUDECODE: "1" };
  expect(
    (operations["agent.guard"]!(call({}, [t3, codex, claude], env)) as Guard)
      .file,
  ).toBe("~/.claude/settings.json");
  const own = { ...t3, guard: { kind: "none" } };
  expect(
    (operations["agent.guard"]!(call({}, [own, claude], env)) as Guard).config,
  ).toBeUndefined();
  const first: Adapter = { id: codex.id, detect: codex.detect };
  expect(
    (
      operations["agent.guard"]!(
        call({}, [t3, first, claude], { ...env, CODEX_THREAD_ID: "1" }),
      ) as Guard
    ).config,
  ).toBeUndefined();
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
