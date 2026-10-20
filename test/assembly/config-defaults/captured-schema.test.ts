import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
