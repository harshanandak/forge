import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  InvocationRequest,
  OperationDeclaration,
} from "../../../src/generated/types.ts";

// This program is run by Node against the installed tarball, never against source imports.
const installed = process.argv[2];
assert.ok(installed, "pass the installed package root");
const load = (area: string): string =>
  pathToFileURL(resolve(installed, `dist/src/core/${area}/index.js`)).href;
const { Catalog, captureBlock, addBlock } = (await import(
  load("catalog")
)) as typeof import("../../../src/core/catalog/index.ts");
const { Runtime } = (await import(
  load("runtime")
)) as typeof import("../../../src/core/runtime/index.ts");
const { TrustStore } = (await import(
  load("trust")
)) as typeof import("../../../src/core/trust/index.ts");
const root = mkdtempSync(join(tmpdir(), "runtime-artifact-"));
let completed = 0;
try {
  const execute = async (
    code: string,
    declaration: Partial<OperationDeclaration> = {},
    context: InvocationRequest["context"] = {},
    timeoutMs = 1000,
  ) => {
    writeFileSync(
      join(root, "block.json"),
      JSON.stringify({
        schemaVersion: "forge.block/1",
        id: "example.org/sample",
        version: "1.0.0",
        authorAbi: "forge.author/v1",
        profile: "trusted-action-sync/v1",
        entry: "index.cjs",
        docs: "docs.json",
        operations: {
          "sample.run": {
            input: "input.json",
            output: "output.json",
            context: "stateless",
            effects: [],
            idempotent: true,
            callers: ["human", "agent"],
            stability: "stable",
            ...declaration,
          },
        },
      }),
    );
    writeFileSync(join(root, "input.json"), '{"type":"string"}');
    writeFileSync(join(root, "output.json"), '{"type":"string"}');
    writeFileSync(join(root, "docs.json"), "{}");
    writeFileSync(
      join(root, "index.cjs"),
      `module.exports = { 'sample.run': ({input, services}) => { ${code} } };`,
    );
    const block = captureBlock(root);
    const catalog = new Catalog(
      {
        schemaVersion: "forge.config/1",
        blocks: { sample: { source: { path: "./sample" } } },
      },
      new Map([["sample", block]]),
    );
    const trust = new TrustStore();
    let invoked = 0;
    let closed = 0;
    const saved = new Map<string, unknown>();
    const runtime = new Runtime(catalog, trust, {
      limits: { timeoutMs, maxOutputBytes: 1000 },
      services: () =>
        Promise.resolve({
          ownership: "owned" as const,
          value: {
            spy: () => invoked++,
            save: (value: unknown) => saved.set("value", value),
          },
          close: () => {
            closed++;
            return Promise.resolve();
          },
        }),
    });
    const request: InvocationRequest = {
      schemaVersion: "forge.invocation/1",
      requestId: "artifact-1",
      caller: "agent",
      op: "sample.run",
      input: "hello",
      context,
    };
    assert.deepEqual(catalog.list(), ["sample.run"]);
    assert.equal(invoked, 0);
    assert.partialDeepStrictEqual(await runtime.invoke(request), { ok: false });
    assert.equal(invoked, 0);
    trust.admit("human", block.digest);
    trust.grant("human", block.digest, declaration.effects ?? []);
    assert.equal(addBlock(root, trust).admitted, true);
    const result = await runtime.invoke(request);
    if (declaration.context === "device" || declaration.context === "project")
      assert.equal(saved.get("value"), "hello");
    if (!(declaration.context === "leased" && declaration.leaseMode === "held"))
      assert.equal(closed, 1);
    completed++;
    return result;
  };
  assert.partialDeepStrictEqual(await execute("services.spy(); return input"), {
    ok: true,
    result: "hello",
  });
  assert.partialDeepStrictEqual(await execute("return 42"), {
    ok: false,
    error: { code: "OUTPUT_INVALID" },
  });
  assert.partialDeepStrictEqual(
    await execute("return Promise.resolve(input)"),
    { ok: false, error: { code: "BLOCK_ASYNC_UNSUPPORTED" } },
  );
  for (const [code, limit] of [
    ["while(true) {}", "timeoutMs"],
    ["return 'x'.repeat(10001)", "maxOutputBytes"],
  ]) {
    const result = await execute(
      code!,
      {},
      {},
      limit === "timeoutMs" ? 30 : 1000,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "LIMIT_EXCEEDED");
      assert.ok(result.error.message.includes(limit!));
    }
  }
  const actor = { kind: "agent" as const, id: "a" };
  for (const context of ["device", "project"] as const) {
    assert.partialDeepStrictEqual(
      await execute(
        "services.save(input); return input",
        { context, effects: ["sample:write"] },
        context === "device"
          ? { actor, device: { id: "d" } }
          : { actor, project: { id: "p" } },
      ),
      { ok: true },
    );
  }
  const ambient = { actor, project: { id: "p" }, session: { id: "s" } };
  assert.partialDeepStrictEqual(
    await execute(
      "return input",
      { context: "leased", leaseMode: "acquire" },
      ambient,
    ),
    { ok: true },
  );
  assert.partialDeepStrictEqual(
    await execute(
      "return input",
      { context: "leased", leaseMode: "held" },
      ambient,
    ),
    {
      ok: false,
      error: { code: "CONTEXT_MISSING", missing: ["leaseGeneration"] },
    },
  );
  const before = captureBlock(root);
  writeFileSync(join(root, "index.cjs"), "module.exports = {};\n");
  const changed = captureBlock(root);
  const trust = new TrustStore();
  trust.admit("human", before.digest);
  assert.throws(() => trust.check(changed.digest, []), /ADMISSION_REQUIRED/);
  assert.throws(
    () =>
      captureBlock(root, {
        maxBytes: 1,
        parse: {
          maxBytes: 100,
          maxDepth: 8,
          maxNodes: 100,
          maxStringLength: 100,
        },
      }),
    /LIMIT_EXCEEDED.*maxBytes/,
  );
  console.log(
    JSON.stringify({
      ok: true,
      path: "installed runtime API",
      completed,
      changedBytesRefused: true,
      captureLimitRefused: true,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
