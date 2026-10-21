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
