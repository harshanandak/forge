import { expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { agentAdapterObservation } from "../../../src/assembly/providers.ts";
import type { PatchStep, ShowResult } from "../../../src/core/config/config.ts";

setDefaultTimeout(30_000);

const say = {
  input: "value.json",
  output: "value.json",
  context: "stateless",
  timeoutMs: 1000,
  effects: [],
  idempotent: true,
  callers: ["human"],
  stability: "experimental",
};
// An outside block whose configSchema is only a `$ref` into another captured file.
const files: Record<string, unknown> = {
  "forge.block.json": {
    schemaVersion: "forge.block/1",
    id: "example.org/hello",
    version: "1.0.0",
    authorAbi: "forge.author/v1",
    profile: "trusted-action-sync/v1",
    entry: "entry.cjs",
    docs: "docs.json",
    configSchema: "config.json",
    files: ["defs.json"],
    operations: { "hello.say": say },
  },
  "config.json": { $ref: "defs.json#/$defs/Config" },
  "defs.json": {
    $defs: {
      Config: {
        type: "object",
        additionalProperties: false,
        required: ["greeting", "style"],
        properties: {
          greeting: { type: "string", default: "hi" },
          style: { type: "object", default: { loud: true } },
        },
      },
    },
  },
  "value.json": { type: "string" },
  "docs.json": {
    operations: { "hello.say": { title: "Say", summary: "Say." } },
  },
};

test("an outside block with a $ref config schema takes its defaults and can be configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-config-defaults-"));
  mkdirSync(join(root, "hello"));
  mkdirSync(join(root, ".forge"));
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(root, "hello", name), JSON.stringify(value));
  writeFileSync(join(root, "hello/entry.cjs"), "module.exports={}");
  writeFileSync(
    join(root, ".forge/config.yaml"),
    "blocks:\n  hello:\n    use: ./hello\n  check: {}\n",
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const { caller, context } = localCall(assembly);
  const call = async (op: string, input: unknown) =>
    (await assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: op,
      op,
      input,
      caller,
      context: context ?? {},
    })) as { ok: boolean; result: Record<string, unknown> };
  try {
    expect(assembly.catalog.unavailable().map((b) => b.name)).not.toContain(
      "hello",
    );
    const shown = (await call("config.show", {})).result;
    expect(shown.effective).toMatchObject({
      blocks: {
        hello: { config: { greeting: "hi", style: { loud: true } } },
        check: { source: { builtin: "forge/check" } },
      },
    });
    // an explicit empty object wins over the object default
    const set = await call("config.set", {
      path: "hello.style",
      value: {},
      expectRevision: shown.revision,
    });
    expect(set.ok).toBe(true);
    expect(
      (await call("config.explain", { path: "hello.style" })).result,
    ).toMatchObject({ value: {}, source: "project" });
    expect(
      (await call("config.explain", { path: "hello.greeting" })).result,
    ).toMatchObject({ value: "hi", source: "default" });
    // the captured schema, `$ref` and all, refuses a wrong value at its pointer
    expect(
      await call("config.set", {
        path: "hello.greeting",
        value: 5,
        expectRevision: set.result.revision,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INPUT_INVALID",
        pointer: "/blocks/hello/config/greeting",
      },
    });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function project(blockFiles: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "forge-config-defaults-"));
  mkdirSync(join(root, "hello"));
  mkdirSync(join(root, ".forge"));
  writeBlock(root, blockFiles);
  writeFileSync(join(root, "hello/entry.cjs"), "module.exports={}");
  writeFileSync(
    join(root, ".forge/config.yaml"),
    "blocks:\n  hello:\n    use: ./hello\n",
  );
  return root;
}
function writeBlock(root: string, blockFiles: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(blockFiles))
    writeFileSync(join(root, "hello", name), JSON.stringify(value));
}
function withGreeting(greeting: string): Record<string, unknown> {
  const defs = files["defs.json"] as {
    $defs: { Config: { properties: Record<string, unknown> } };
  };
  return {
    ...files,
    "defs.json": {
      $defs: {
        Config: {
          ...defs.$defs.Config,
          properties: {
            ...defs.$defs.Config.properties,
            greeting: { type: "string", default: greeting },
          },
        },
      },
    },
  };
}

for (const scenario of [
  {
    name: "schema value",
    path: "hello.greeting",
    invalid: 5,
    repaired: "hi",
    problem: "blocks.hello.config.greeting",
  },
  {
    name: "unavailable source",
    path: "/blocks/hello/source/path",
    invalid: "./missing-block",
    repaired: "./hello",
    problem: "blocks.hello.source",
  },
] as const) {
  for (const repairing of [false, true]) {
    test(`config show ${repairing ? "repairs" : "introduces"} a ${scenario.name} problem for one invocation only`, async () => {
      const root = project(files);
      const file = join(root, ".forge/config.yaml");
      const broken = repairing;
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: "forge.config/1",
          blocks: {
            hello: {
              source: {
                path:
                  broken && scenario.name === "unavailable source"
                    ? "./missing-block"
                    : "./hello",
              },
              config: {
                greeting: broken && scenario.name === "schema value" ? 5 : "hi",
                style: { loud: true },
              },
            },
          },
        }),
      );
      const before = readFileSync(file, "utf8");
      const assembly = await createAssembly({
        root,
        deviceRoot: join(root, "device"),
      });
      const { caller, context } = localCall(assembly);
      const show = async (input: unknown = {}) =>
        (await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: "show",
          op: "config.show",
          input,
          caller,
          context: context ?? {},
        })) as {
          ok: boolean;
          result: {
            valid: boolean;
            problems: string[];
            effective: unknown;
            revision: string;
          };
        };
      try {
        const baseline = await show();
        expect(baseline.ok).toBe(!broken);
        expect(baseline.result.valid).toBe(!broken);
        expect(baseline.result.problems).toHaveLength(broken ? 1 : 0);
        if (broken)
          expect(baseline.result.problems[0]).toContain(scenario.problem);

        const patched = await show({
          invocation: [
            {
              op: "set",
              path: scenario.path,
              value: repairing ? scenario.repaired : scenario.invalid,
            },
          ],
        });
        expect(patched.ok).toBe(repairing);
        expect(patched.result.valid).toBe(repairing);
        expect(patched.result.problems).toHaveLength(repairing ? 0 : 1);
        if (repairing) {
          expect(patched.result.effective).toMatchObject({
            blocks: {
              hello: {
                source: { path: "./hello" },
                config: { greeting: "hi", style: { loud: true } },
              },
            },
          });
        } else {
          expect(patched.result.problems[0]).toContain(scenario.problem);
          expect(patched.result.effective).toMatchObject({
            blocks: { hello: { enabled: false } },
          });
        }
        expect(patched.result.revision).toBe(baseline.result.revision);
        expect(readFileSync(file, "utf8")).toBe(before);
        expect((await show()).result).toEqual(baseline.result);
      } finally {
        await assembly.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const repairingRuntime of [false, true]) {
  test(`config show ${repairingRuntime ? "repairs persisted runtime validation" : "validates an invocation-only block"} without changing persisted state`, async () => {
    const root = project(files);
    const file = join(root, ".forge/config.yaml");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: {},
        ...(repairingRuntime ? { runtime: { timeoutMs: 0 } } : {}),
      }),
    );
    const before = readFileSync(file, "utf8");
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    const { caller, context } = localCall(assembly);
    const show = async (input: unknown = {}) =>
      (await assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: "show",
        op: "config.show",
        input,
        caller,
        context: context ?? {},
      })) as {
        ok: boolean;
        result: {
          valid: boolean;
          effective: { blocks: Record<string, unknown>; runtime?: unknown };
          problems: string[];
        };
      };
    try {
      const baseline = await show();
      expect(baseline.ok).toBe(!repairingRuntime);
      expect(baseline.result.valid).toBe(!repairingRuntime);
      expect(baseline.result.problems).toHaveLength(repairingRuntime ? 1 : 0);
      expect(baseline.result.effective.blocks).toEqual({});
      if (repairingRuntime) {
        expect(baseline.result.problems[0]).toContain("runtime.timeoutMs");
        expect(baseline.result.problems[0]).toContain("must be at least 1");
        expect(baseline.result.effective.runtime).toBeUndefined();
      }

      const patched = await show({
        invocation: [
          repairingRuntime
            ? { op: "set", path: "/runtime", value: { timeoutMs: 1000 } }
            : {
                op: "set",
                path: "/blocks/extra",
                value: { source: { path: "./missing-block" } },
              },
        ],
      });
      expect(patched.ok).toBe(repairingRuntime);
      expect(patched.result.valid).toBe(repairingRuntime);
      expect(patched.result.problems).toHaveLength(repairingRuntime ? 0 : 1);
      if (repairingRuntime) {
        expect(patched.result.effective.runtime).toEqual({ timeoutMs: 1000 });
        expect(patched.result.effective.blocks).toEqual({});
      } else {
        expect(patched.result.effective.blocks).toEqual({
          extra: { source: { path: "./missing-block" }, enabled: false },
        });
        expect(patched.result.problems[0]).toContain("blocks.extra.source");
        expect(patched.result.problems[0]).toContain("missing-block");
      }
      expect(readFileSync(file, "utf8")).toBe(before);
      const unpatched = await show();
      expect(unpatched.ok).toBe(baseline.ok);
      expect(unpatched.result).toEqual(baseline.result);
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function inspectInvocation(
  document: Record<string, unknown>,
  invocation: readonly PatchStep[],
  inspect: (
    shown: { ok: boolean; result: ShowResult },
    baseline: { ok: boolean; result: ShowResult },
  ) => void,
): Promise<void> {
  const root = project(files);
  const file = join(root, ".forge/config.yaml");
  writeFileSync(file, JSON.stringify(document));
  const before = readFileSync(file, "utf8");
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const { caller, context } = localCall(assembly);
  const show = async (input: unknown = {}) =>
    (await assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "show",
      op: "config.show",
      input,
      caller,
      context: context ?? {},
    })) as { ok: boolean; result: ShowResult };
  try {
    const baseline = await show();
    const shown = await show({ invocation });
    inspect(shown, baseline);
    expect(shown.result.revision).toBe(baseline.result.revision);
    expect(readFileSync(file, "utf8")).toBe(before);
    const unpatched = await show();
    expect(unpatched.ok).toBe(baseline.ok);
    expect(unpatched.result).toEqual(baseline.result);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("config show repairs an unavailable source and resolves the replacement source's defaults", async () => {
  await inspectInvocation(
    {
      schemaVersion: "forge.config/1",
      blocks: { hello: { source: { path: "./missing-block" } } },
    },
    [{ op: "set", path: "/blocks/hello/source/path", value: "./hello" }],
    (shown, baseline) => {
      expect(baseline.ok).toBe(false);
      expect(baseline.result.problems).toEqual([
        expect.stringContaining("blocks.hello.source"),
      ]);
      expect(shown.ok).toBe(true);
      expect(shown.result.valid).toBe(true);
      expect(shown.result.problems).toEqual([]);
      expect(shown.result.effective.blocks).toEqual({
        hello: {
          source: { path: "./hello" },
          config: { greeting: "hi", style: { loud: true } },
        },
      });
    },
  );
});

test("config show reports an invocation-introduced runtime schema problem", async () => {
  await inspectInvocation(
    { schemaVersion: "forge.config/1", blocks: {} },
    [{ op: "set", path: "/runtime", value: { timeoutMs: 0 } }],
    (shown) => {
      expect(shown.ok).toBe(false);
      expect(shown.result.valid).toBe(false);
      expect(shown.result.problems).toEqual([
        expect.stringContaining("runtime.timeoutMs"),
      ]);
      expect(shown.result.excluded).toEqual([
        {
          pointer: "/runtime",
          problems: [expect.stringContaining("runtime.timeoutMs")],
        },
      ]);
      expect(shown.result.effective.runtime).toBeUndefined();
    },
  );
});

test("config show resolves the built-in source of an invocation-only instance", async () => {
  const pointer = "/blocks/check/config/commands";
  const commands = { test: "node --test" };
  await inspectInvocation(
    { schemaVersion: "forge.config/1", blocks: {} },
    [{ op: "set", path: pointer, value: commands }],
    (shown) => {
      expect(shown.ok).toBe(true);
      expect(shown.result.valid).toBe(true);
      expect(shown.result.problems).toEqual([]);
      expect(shown.result.instances).toEqual([
        { name: "check", source: { builtin: "forge/check" }, enabled: true },
      ]);
      expect(shown.result.effective.blocks).toMatchObject({
        check: { source: { builtin: "forge/check" }, config: { commands } },
      });
      expect(
        shown.result.values.filter((entry) =>
          entry.pointer.startsWith(pointer),
        ),
      ).toEqual([
        { pointer, value: commands, layer: "invocation", active: true },
      ]);
    },
  );
});

test("derived agent adapters target the configured instance name", () => {
  expect(agentAdapterObservation("router")).toMatchObject([
    {
      key: "/blocks/router/config/adapters",
      value: [
        { id: "claude", detect: ["CLAUDECODE"] },
        { id: "codex", detect: ["CODEX_THREAD_ID"] },
        {
          id: "t3",
          detect: ["T3CODE_CLI_PATH", "T3CODE_THREAD_ID"],
          over: ["codex", "claude"],
          prWatch: "t3-tool",
        },
      ],
    },
  ]);
});

test("an unrelated block named agent never receives derived adapters", async () => {
  const root = project(files);
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { agent: { source: { path: "./hello" } } },
    }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const { caller, context } = localCall(assembly);
  try {
    const shown = (await assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "show",
      op: "config.show",
      input: {},
      caller,
      context: context ?? {},
    })) as {
      ok: boolean;
      result: {
        effective: { blocks: { agent: { config: unknown } } };
        problems: string[];
      };
    };
    expect(shown.ok).toBe(true);
    expect(shown.result.problems).toEqual([]);
    expect(shown.result.effective.blocks.agent.config).toEqual({
      greeting: "hi",
      style: { loud: true },
    });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reference of ["local", "cross-file", "true-target"]) {
  test(`a captured ${reference} property reference replaces detected commands`, async () => {
    const map = { type: "object", additionalProperties: { type: "string" } };
    const root = project({
      ...files,
      "config.json":
        reference === "cross-file"
          ? { $ref: "defs.json#/$defs/Config" }
          : {
              type: "object",
              $defs: { commands: reference === "true-target" ? true : map },
              properties: {
                commands: {
                  $ref: "#/$defs/commands",
                  ...(reference === "true-target"
                    ? { ...map, default: { manual: "run" } }
                    : {}),
                },
              },
            },
      "defs.json": {
        $defs: {
          Config: {
            type: "object",
            properties: { commands: { $ref: "#/$defs/commands" } },
          },
          commands: { $ref: "commands.schema.json", default: {} },
        },
      },
      "commands.schema.json": map,
      "forge.block.json": {
        ...(files["forge.block.json"] as Record<string, unknown>),
        files: ["defs.json", "commands.schema.json"],
      },
    });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: { lint: "detected-lint", test: "detected-test" },
      }),
    );
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  check:\n    use: ./hello\n",
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    const { caller, context } = localCall(assembly);
    const call = async (op: string, input: unknown) => {
      const result = (await assembly.catalog.invoke({
        schemaVersion: "forge.invocation/1",
        requestId: op,
        op,
        input,
        caller,
        context: context ?? {},
      })) as { ok: boolean; result: Record<string, unknown> };
      expect(result.ok).toBe(true);
      return result.result;
    };
    try {
      const shown = await call("config.show", {});
      expect(shown.problems).toEqual([]);
      const manualDefault =
        reference === "true-target"
          ? await call("config.explain", { path: "check.commands.manual" })
          : undefined;
      expect(
        (await call("config.explain", { path: "check.commands.lint" })).value,
      ).toBe("npm run lint");
      const set = await call("config.set", {
        path: "check.commands",
        value: { manual: "declared-command" },
        expectRevision: shown.revision,
      });
      expect(
        (await call("config.explain", { path: "check.commands" })).value,
      ).toEqual({ manual: "declared-command" });
      expect(
        await call("config.explain", { path: "check.commands.manual" }),
      ).toMatchObject({ value: "declared-command", source: "project" });
      const lint = await call("config.explain", {
        path: "check.commands.lint",
      });
      expect(lint.set).toBe(false);
      expect(lint.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: "derived",
            active: false,
            origin: {
              detector: "project.detect",
              file: "package.json",
              pointer: "/scripts/lint",
            },
            overriddenBy: {
              layer: "project",
              pointer: "/blocks/check/config/commands",
            },
          }),
        ]),
      );
      const saved = await call("config.save", { expectRevision: set.revision });
      // The work prefix is still derived; the replaced commands must not be saved.
      expect(saved.saved).toEqual(["/blocks/work/config/idPrefix"]);
      expect(
        (await call("config.save", { expectRevision: saved.revision })).saved,
      ).toEqual([]);
      expect(
        readFileSync(join(root, ".forge/config.yaml"), "utf8"),
      ).not.toContain("npm run lint");
      if (manualDefault !== undefined)
        expect(manualDefault).toMatchObject({
          value: "run",
          entries: [
            {
              layer: "default",
              active: true,
              pointer: "/blocks/check/config/commands",
              value: { manual: "run" },
            },
          ],
        });
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("overlapping calls each read the block bytes on their own", async () => {
  const root = project(withGreeting("hi"));
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const { caller, context } = localCall(assembly);
  try {
    // the show call is still running when a listing captures the block and its bytes change
    const pending = assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "show",
      op: "config.show",
      input: {},
      caller,
      context: context ?? {},
    });
    expect(assembly.catalog.list().length).toBeGreaterThan(0);
    writeBlock(root, withGreeting("hello"));
    const shown = (await pending) as {
      ok: boolean;
      result: { effective: unknown; problems: string[] };
    };
    expect(shown.ok).toBe(true);
    expect(shown.result.effective).toMatchObject({
      blocks: { hello: { config: { greeting: "hello" } } },
    });
    expect(shown.result.problems).toEqual([]);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a $ref config schema's sibling properties supply defaults too", async () => {
  const root = project({
    ...files,
    // `tone` is required and only declared beside the `$ref`; its default makes `use:` alone valid
    "config.json": {
      $ref: "defs.json#/$defs/Config",
      required: ["tone"],
      properties: { tone: { type: "string", default: "calm" } },
    },
    "defs.json": {
      $defs: {
        Config: {
          type: "object",
          required: ["greeting"],
          properties: { greeting: { type: "string", default: "hi" } },
        },
      },
    },
  });
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const { caller, context } = localCall(assembly);
  try {
    expect(assembly.catalog.unavailable()).toEqual([]);
    const shown = (await assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "show",
      op: "config.show",
      input: {},
      caller,
      context: context ?? {},
    })) as { ok: boolean; result: { effective: unknown; problems: string[] } };
    expect(shown.result.effective).toMatchObject({
      blocks: { hello: { config: { greeting: "hi", tone: "calm" } } },
    });
    expect(shown.result.problems).toEqual([]);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});
