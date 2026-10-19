import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { nodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";
import type { CaptureLimits } from "../../../src/core/catalog/index.ts";
const captureBlock = (root: string, limits?: CaptureLimits) =>
  capture(root, nodeFileCapture, limits);
const addBlock = (root: string, trust: TrustStore) =>
  add(root, trust, nodeFileCapture);
import { operations as catalogOperations } from "../../../src/core/catalog/operations.ts";
import { operations as trustOperations } from "../../../src/core/trust/operations.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Catalog,
  captureBlock as capture,
  addBlock as add,
  assembleCoreManifest,
} from "../../../src/core/catalog/index.ts";
import { TrustStore, secretReference } from "../../../src/core/trust/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import type { SurfaceCatalog } from "../../../src/surface/catalog.ts";
import type {
  BlockManifest,
  InvocationRequest,
  OperationDeclaration,
} from "../../../src/generated/types.ts";

function fixture(
  code = "return input",
  declaration: Partial<OperationDeclaration> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  const manifest = {
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
  };
  writeFileSync(join(root, "block.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "input.json"), JSON.stringify({ type: "string" }));
  writeFileSync(join(root, "output.json"), JSON.stringify({ type: "string" }));
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
  const request: InvocationRequest = {
    schemaVersion: "forge.invocation/1",
    requestId: "request-1",
    op: "sample.run",
    input: "hello",
    caller: "agent",
    context: {},
  };
  return {
    root,
    block,
    catalog,
    trust,
    request,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("catalog_call advertises worst-case effects but enforces the target grants", async () => {
  const f = fixture("services.save(); return input", {
    effects: ["sample:write"],
  });
  let writes = 0;
  try {
    f.trust.admit("human", f.block.digest);
    const runtime = new Runtime(f.catalog, f.trust, {
      isolation: nodeRunIsolation,
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: { save: () => writes++ },
        }),
    });
    const catalog: SurfaceCatalog = {
      list: () => [
        {
          ...f.catalog.describe("sample.run"),
          inputSchema: { type: "string" },
          outputSchema: { type: "string" },
          admitted: true,
          docs: { title: "Run", summary: "Run sample." },
        },
      ],
      invoke: (request) => runtime.invoke(request),
    };
    const handlers = createMcpHandlers(catalog);
    const tool = handlers
      .listTools()
      .find((tool) => tool.name === "catalog_call");
    assert.partialDeepStrictEqual(tool?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    assert.partialDeepStrictEqual(
      await handlers.callTool("catalog_call", f.request),
      { ok: false, error: { code: "GRANT_REQUIRED" } },
    );
    assert.equal(writes, 0);
    f.trust.grant("human", f.block.digest, ["sample:write"]);
    assert.partialDeepStrictEqual(
      await handlers.callTool("catalog_call", f.request),
      { ok: true, result: "hello" },
    );
    assert.equal(writes, 1);
    f.trust.revoke("human", f.block.digest);
    assert.partialDeepStrictEqual(
      await handlers.callTool("catalog_call", f.request),
      { ok: false, error: { code: "ADMISSION_REQUIRED" } },
    );
    assert.equal(writes, 1);
  } finally {
    f.close();
  }
}, 5000);

test("catalog_call preserves canonical dry-run, context and request identity without trusting the payload caller", async () => {
  const f = fixture("services.save(); return input", {
    effects: ["sample:write"],
  });
  let opened = 0;
  const requests: InvocationRequest[] = [];
  try {
    f.trust.admit("human", f.block.digest);
    f.trust.grant("human", f.block.digest, ["sample:write"]);
    const runtime = new Runtime(f.catalog, f.trust, {
      isolation: nodeRunIsolation,
      services: () => {
        opened++;
        return Promise.resolve({
          ownership: "borrowed",
          value: { save: () => opened++ },
        });
      },
    });
    const catalog: SurfaceCatalog = {
      list: () => [
        {
          ...f.catalog.describe("sample.run"),
          inputSchema: { type: "string" },
          outputSchema: { type: "string" },
          admitted: true,
          docs: { title: "Run", summary: "Run sample." },
        },
      ],
      invoke: (request) => {
        requests.push(request);
        return runtime.invoke(request);
      },
    };
    const input = {
      ...f.request,
      caller: "human" as const,
      dryRun: true,
      context: { device: { id: "inner-device" } },
    };
    const direct = await runtime.invoke({ ...input, caller: "agent" });
    const handlers = createMcpHandlers(catalog);
    assert.deepEqual(await handlers.callTool("catalog_call", input), direct);
    assert.partialDeepStrictEqual(direct, {
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    assert.equal(opened, 0);
    assert.deepEqual(requests[0], { ...input, caller: "agent" });
    await createMcpHandlers(catalog, {}, { dryRun: true }).callTool(
      "catalog_call",
      { ...input, dryRun: false },
    );
    assert.equal(opened, 0);
  } finally {
    f.close();
  }
}, 5000);

test("discovery never activates code and denied admission never opens services", async () => {
  const f = fixture("services.spy(); return input");
  let calls = 0;
  try {
    assert.deepEqual(f.catalog.list(), ["sample.run"]);
    const runtime = new Runtime(f.catalog, f.trust, {
      isolation: nodeRunIsolation,
      services: () => {
        calls++;
        return Promise.resolve({
          ownership: "owned" as const,
          value: { spy: () => calls++ },
          close: () => Promise.resolve(),
        });
      },
    });
    assert.partialDeepStrictEqual(await runtime.invoke(f.request), {
      ok: false,
      error: { code: "ADMISSION_REQUIRED" },
    });
    assert.equal(calls, 0);
    f.trust.admit("human", f.block.digest);
    assert.partialDeepStrictEqual(await runtime.invoke(f.request), {
      ok: true,
      result: "hello",
    });
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
}, 5000);

test("changed entry bytes need fresh admission; matching captures reuse it", () => {
  const f = fixture();
  try {
    f.trust.admit("human", f.block.digest);
    assert.equal(captureBlock(f.root).digest, f.block.digest);
    writeFileSync(join(f.root, "index.cjs"), "module.exports = {};");
    const changed = captureBlock(f.root);
    assert.notEqual(changed.digest, f.block.digest);
    assert.throws(
      () => f.trust.check(changed.digest, []),
      /ADMISSION_REQUIRED/,
    );
    assert.throws(
      () => f.trust.admit("agent", changed.digest),
      /ADMISSION_REQUIRED/,
    );
  } finally {
    f.close();
  }
}, 5000);

for (const [name, code, expected] of [
  ["invalid output", "return 3", "OUTPUT_INVALID"],
  [
    "rejected async output",
    "return Promise.reject(Error('refused'))",
    "BLOCK_EXECUTION_FAILED",
  ],
  ["non-JSON output", "return new Date()", "OUTPUT_INVALID"],
  ["hostile getter", "return {get x(){throw Error('bad')}}", "OUTPUT_INVALID"],
  ["time limit", "while(true) {}", "INVOCATION_TIMEOUT"],
  ["output limit", "return 'x'.repeat(10000)", "LIMIT_EXCEEDED"],
] as const)
  test(`${name} fails closed and closes owned services`, async () => {
    const f = fixture(code);
    let closed = 0;
    try {
      f.trust.admit("human", f.block.digest);
      const runtime = new Runtime(f.catalog, f.trust, {
        isolation: nodeRunIsolation,
        limits: {
          timeoutMs: name === "time limit" ? 20 : 1000,
          maxOutputBytes: 1000,
        },
        services: () =>
          Promise.resolve({
            ownership: "owned" as const,
            value: {},
            close: () => {
              closed++;
              return Promise.resolve();
            },
          }),
      });
      const result = await runtime.invoke(f.request);
      assert.partialDeepStrictEqual(result, {
        ok: false,
        error: { code: expected },
      });
      if (!result.ok && expected === "LIMIT_EXCEEDED")
        assert.match(result.error.message, /timeoutMs|maxOutputBytes/);
      assert.equal(closed, 1);
    } finally {
      f.close();
    }
  }, 5000);

for (const variant of ["device", "project", "acquire", "held"] as const)
  test(`${variant} enforces only declared context`, async () => {
    const leased = variant === "acquire" || variant === "held";
    const f = fixture("services.save(input); return input", {
      context: leased ? "leased" : variant,
      ...(leased ? { leaseMode: variant } : {}),
      effects: ["sample:write"],
    });
    try {
      f.trust.admit("human", f.block.digest);
      f.trust.grant("human", f.block.digest, ["sample:write"]);
      const context = {
        actor: { kind: "agent" as const, id: "a" },
        device: { id: "d" },
        project: { id: "p", root: "/project" },
        session: { id: "s" },
      };
      const saved = new Map<string, unknown>();
      const result = await new Runtime(f.catalog, f.trust, {
        isolation: nodeRunIsolation,
        services: (_instance, bound) => {
          assert.equal(bound.variant, leased ? "leased" : variant);
          return Promise.resolve({
            ownership: "borrowed",
            value: { save: (value: unknown) => saved.set("value", value) },
          });
        },
      }).invoke({
        ...f.request,
        context,
      });
      assert.partialDeepStrictEqual(
        result,
        variant === "held"
          ? {
              ok: false,
              error: { code: "CONTEXT_MISSING", missing: ["leaseGeneration"] },
            }
          : { ok: true },
      );
      assert.equal(
        saved.get("value"),
        variant === "held" ? undefined : "hello",
      );
    } finally {
      f.close();
    }
  }, 5000);

test("capture size limit stops before activation", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        captureBlock(f.root, {
          maxBytes: 1,
          parse: {
            maxBytes: 100,
            maxDepth: 8,
            maxNodes: 100,
            maxStringLength: 100,
          },
        }),
      /maxBytes/,
    );
  } finally {
    f.close();
  }
}, 5000);

test("raw-byte capture includes BOM, docs and schemas and admission is reused only for matching bytes", () => {
  const f = fixture();
  try {
    assert.equal(addBlock(f.root, f.trust).admitted, false);
    f.trust.admit("human", f.block.digest);
    assert.equal(addBlock(f.root, f.trust).admitted, true);
    for (const name of [
      "index.cjs",
      "docs.json",
      "input.json",
      "output.json",
      "block.json",
    ]) {
      const path = join(f.root, name);
      const bytes = readFileSync(path);
      writeFileSync(
        path,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      );
      assert.notEqual(captureBlock(f.root).digest, f.block.digest);
      assert.equal(addBlock(f.root, f.trust).admitted, false);
      writeFileSync(path, bytes);
    }
  } finally {
    f.close();
  }
}, 5000);

test("discovery does not run a top-level activation spy", async () => {
  const f = fixture();
  try {
    const source =
      "args.services.spy(); module.exports = {'sample.run': ({input}) => input};";
    writeFileSync(join(f.root, "index.cjs"), source);
    const block = captureBlock(f.root);
    const catalog = new Catalog(f.catalog.config, new Map([["sample", block]]));
    let calls = 0;
    const runtime = new Runtime(catalog, f.trust, {
      isolation: nodeRunIsolation,
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: { spy: () => calls++ },
        }),
    });
    catalog.describe("sample.run");
    assert.equal(calls, 0);
    assert.partialDeepStrictEqual(await runtime.invoke(f.request), {
      ok: false,
      error: { code: "ADMISSION_REQUIRED" },
    });
    assert.equal(calls, 0);
    f.trust.admit("human", block.digest);
    assert.partialDeepStrictEqual(await runtime.invoke(f.request), {
      ok: true,
    });
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
}, 5000);

test("revocation during open refuses execution and still closes the owned handle", async () => {
  const f = fixture("services.spy(); return input");
  let calls = 0;
  let closed = 0;
  try {
    f.trust.admit("human", f.block.digest);
    const runtime = new Runtime(f.catalog, f.trust, {
      isolation: nodeRunIsolation,
      services: () => {
        f.trust.revoke("human", f.block.digest);
        return Promise.resolve({
          ownership: "owned",
          value: { spy: () => calls++ },
          close: () => {
            closed++;
            return Promise.resolve();
          },
        });
      },
    });
    assert.partialDeepStrictEqual(await runtime.invoke(f.request), {
      ok: false,
      error: { code: "ADMISSION_REQUIRED" },
    });
    assert.equal(calls, 0);
    assert.equal(closed, 1);
  } finally {
    f.close();
  }
}, 5000);

test("output structural limits and hostile getters never accept a result", async () => {
  for (const [code, limit] of [
    ["return Array(1000).fill('x')", "maxNodes"],
    ["return [[[[input]]]]", "maxDepth"],
    ["return 'long string'", "maxStringLength"],
  ]) {
    const f = fixture(code);
    try {
      f.trust.admit("human", f.block.digest);
      const runtime = new Runtime(f.catalog, f.trust, {
        isolation: nodeRunIsolation,
        limits: {
          parse: {
            maxBytes: 1000,
            maxNodes: 10,
            maxDepth: 2,
            maxStringLength: 8,
          },
        },
      });
      const result = await runtime.invoke(f.request);
      assert.partialDeepStrictEqual(result, {
        ok: false,
        status: "INCOMPLETE",
        error: { code: "LIMIT_EXCEEDED" },
      });
      if (!result.ok) assert.ok(result.error.message.includes(limit!));
    } finally {
      f.close();
    }
  }
}, 5000);

test("outside text is bounded before validation and SecretRef never accepts plaintext", async () => {
  const f = fixture();
  try {
    const runtime = new Runtime(f.catalog, f.trust, {
      isolation: nodeRunIsolation,
      limits: {
        parse: { maxBytes: 10, maxDepth: 2, maxNodes: 10, maxStringLength: 10 },
      },
    });
    assert.partialDeepStrictEqual(
      await runtime.invokeText('"xxxxxxxxxxxxxxxx"'),
      { ok: false, error: { code: "LIMIT_EXCEEDED" } },
    );
    assert.deepEqual(secretReference({ $secret: "SERVICE_KEY" }), {
      $secret: "SERVICE_KEY",
    });
    assert.throws(() => secretReference("plaintext"), /INPUT_INVALID/);
    assert.throws(
      () => f.trust.grant("agent", f.block.digest, ["sample:write"]),
      /GRANT_REQUIRED/,
    );
  } finally {
    f.close();
  }
}, 5000);

test("owned core fragments assemble without duplicate operations", () => {
  const fragments = [catalogOperations, trustOperations];
  const base = {
    schemaVersion: "forge.block/1" as const,
    id: "forge/core",
    version: "1.0.0",
    authorAbi: "forge.author/v1" as const,
    profile: "trusted-action-sync/v1" as const,
    entry: "index.cjs",
    docs: "docs.json",
  };
  const manifest = assembleCoreManifest(base, fragments);
  assert.equal(Object.keys(manifest.operations).length, 6);
  assert.throws(
    () => assembleCoreManifest(base, [...fragments, fragments[0]!]),
    /duplicate core operation/,
  );
}, 5000);
import { existsSync } from "node:fs";
import { CapturedBlock } from "../../../src/core/catalog/index.ts";

test("core manifest is generated from area declarations at check and build time", () => {
  const path = new URL(
    "../../../src/generated/core-manifest.json",
    import.meta.url,
  );
  assert.ok(existsSync(path), "assembled core manifest must be generated");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BlockManifest;
  assert.deepEqual(Object.keys(manifest.operations).sort(), [
    "block.add",
    "block.admit",
    "block.check",
    "catalog.call",
    "catalog.describe",
    "catalog.list",
  ]);
  for (const area of ["catalog", "trust"])
    assert.equal(
      existsSync(
        new URL(`../../../src/core/${area}/operations.json`, import.meta.url),
      ),
      false,
    );
}, 5000);

test("catalog call schemas enforce the canonical invocation and result contracts", () => {
  const f = fixture();
  try {
    const files = new Map(
      ["input", "output"].map((kind) => [
        `${kind}.json`,
        readFileSync(
          new URL(
            `../../../src/core/catalog/call.${kind}.schema.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ]),
    );
    const block = new CapturedBlock(files, f.block.manifest);
    assert.equal(block.validate("input.json", f.request), true);
    for (const bad of [
      { ...f.request, requestId: "" },
      { ...f.request, op: "invalid" },
      { ...f.request, context: { unexpected: true } },
    ])
      assert.equal(block.validate("input.json", bad), false);
    assert.equal(
      block.validate("output.json", {
        ok: true,
        op: "sample.run",
        status: "OK",
        warnings: [],
        result: "hello",
      }),
      true,
    );
    assert.equal(
      block.validate("output.json", {
        ok: true,
        status: "OK",
        warnings: [],
        error: {},
      }),
      false,
    );
  } finally {
    f.close();
  }
}, 5000);

test("captured relative schema dependencies without a suffix validate and void admission on change", () => {
  const f = fixture();
  try {
    const manifest: BlockManifest = {
      ...f.block.manifest,
      files: ["defs.json", "nested.json"],
    };
    writeFileSync(join(f.root, "block.json"), JSON.stringify(manifest));
    writeFileSync(
      join(f.root, "input.json"),
      JSON.stringify({ $ref: "defs.json#/$defs/X" }),
    );
    writeFileSync(
      join(f.root, "defs.json"),
      JSON.stringify({ $defs: { X: { $ref: "nested.json" } } }),
    );
    writeFileSync(
      join(f.root, "nested.json"),
      JSON.stringify({ type: "string" }),
    );
    const block = captureBlock(f.root);
    assert.equal(block.validate("input.json", "hello"), true);
    assert.equal(block.validate("input.json", 1), false);
    f.trust.admit("human", block.digest);
    writeFileSync(
      join(f.root, "nested.json"),
      JSON.stringify({ type: "number" }),
    );
    const changed = captureBlock(f.root);
    assert.equal(changed.validate("input.json", 1), true);
    assert.notEqual(changed.digest, block.digest);
    assert.throws(
      () => f.trust.check(changed.digest, []),
      /ADMISSION_REQUIRED/,
    );
  } finally {
    f.close();
  }
}, 5000);

test("missing embedding service provider is incomplete and never activates the handler", async () => {
  const f = fixture("throw Error('must not activate')");
  try {
    const manifest: BlockManifest = {
      ...f.block.manifest,
      requires: [{ slot: "state", interface: "forge.state@1" }],
    };
    writeFileSync(join(f.root, "block.json"), JSON.stringify(manifest));
    const block = captureBlock(f.root);
    const catalog = new Catalog(f.catalog.config, new Map([["sample", block]]));
    f.trust.admit("human", block.digest);
    assert.partialDeepStrictEqual(
      await new Runtime(catalog, f.trust).invoke(f.request),
      { ok: false, status: "INCOMPLETE", error: { code: "PROVIDER_MISSING" } },
    );
  } finally {
    f.close();
  }
}, 5000);
test("clients are constructed for only the invoked operation effects", async () => {
  const f = fixture();
  let writes = 0;
  try {
    const manifest: BlockManifest = {
      ...f.block.manifest,
      operations: {
        "sample.read": {
          ...f.block.manifest.operations["sample.run"]!,
          effects: [],
        },
        "sample.write": {
          ...f.block.manifest.operations["sample.run"]!,
          effects: ["sample:write"],
        },
      },
    };
    writeFileSync(join(f.root, "block.json"), JSON.stringify(manifest));
    writeFileSync(
      join(f.root, "index.cjs"),
      "module.exports = { 'sample.read': ({services}) => { services.write(); return 'written'; }, 'sample.write': ({services}) => { services.write(); return 'written'; } };",
    );
    const block = captureBlock(f.root);
    const catalog = new Catalog(f.catalog.config, new Map([["sample", block]]));
    f.trust.admit("human", block.digest);
    f.trust.grant("human", block.digest, ["sample:write"]);
    const scopes: import("../../../src/core/runtime/index.ts").ServiceScope[] =
      [];
    const runtime = new Runtime(catalog, f.trust, {
      isolation: nodeRunIsolation,
      services: (_instance, _context, scope) => {
        scopes.push(scope);
        const allowed =
          scope === undefined || scope.effects.includes("sample:write");
        return Promise.resolve({
          ownership: "borrowed",
          value: Object.freeze(allowed ? { write: () => writes++ } : {}),
        });
      },
    });
    assert.partialDeepStrictEqual(
      await runtime.invoke({ ...f.request, op: "sample.read" }),
      {
        ok: false,
        error: { code: "BLOCK_EXECUTION_FAILED" },
      },
    );
    assert.equal(writes, 0);
    assert.partialDeepStrictEqual(
      await runtime.invoke({ ...f.request, op: "sample.write" }),
      {
        ok: true,
        result: "written",
      },
    );
    assert.equal(writes, 1);
    assert.deepEqual(
      scopes.map(({ op, effects }) => ({ op, effects })),
      [
        { op: "sample.read", effects: [] },
        { op: "sample.write", effects: ["sample:write"] },
      ],
    );
    for (const scope of scopes) {
      assert.ok(Object.isFrozen(scope));
      assert.ok(Object.isFrozen((scope as { effects: unknown }).effects));
    }
  } finally {
    f.close();
  }
}, 5000);

test("catalog core imports no filesystem or platform path modules", () => {
  const source = readFileSync(
    new URL("../../../src/core/catalog/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /["'](?:node:)?(?:fs|path|os)(?:\/[^"']*)?["']|bun:/,
  );
}, 5000);

test("catalog capture accepts an injected source through the L1 handle", () => {
  const f = fixture();
  try {
    const reads: string[] = [];
    const memory = new Map(
      ["block.json", "index.cjs", "docs.json", "input.json", "output.json"].map(
        (name) => [name, readFileSync(join(f.root, name))],
      ),
    );
    const block = capture(f.root, {
      open: () => ({
        ownership: "borrowed",
        value: {
          read: (name, maxBytes) => {
            reads.push(name);
            const data = memory.get(name)!;
            assert.ok(data.length <= maxBytes);
            return data;
          },
        },
      }),
    });
    assert.equal(block.digest, f.block.digest);
    assert.deepEqual(
      new Set(reads),
      new Set([
        "block.json",
        "index.cjs",
        "docs.json",
        "input.json",
        "output.json",
      ]),
    );
    assert.throws(() =>
      nodeFileCapture.open(f.root).value.read("../outside", 1000),
    );
    assert.throws(
      () => nodeFileCapture.open(f.root).value.read(f.root, 1000),
      /INPUT_INVALID/,
    );
    assert.throws(
      () => nodeFileCapture.open(f.root).value.read(".", 1000),
      /regular files/,
    );
  } finally {
    f.close();
  }
}, 5000);

test("runtime uses the injected evaluator and closes both owned handles on every outcome", async () => {
  for (const outcome of [
    "success",
    "throw",
    "revoke",
    "close-failure",
    "unavailable",
  ] as const) {
    const f = fixture("throw Error('the real handler must not run')");
    const events: string[] = [];
    try {
      f.trust.admit("human", f.block.digest);
      const runtime = new Runtime(f.catalog, f.trust, {
        services: () =>
          Promise.resolve({
            ownership: "owned",
            value: {},
            close: () => {
              events.push("services closed");
              return Promise.resolve();
            },
          }),
        isolation: {
          open: async () => {
            await Promise.resolve();
            events.push("opened");
            if (outcome === "unavailable")
              return {
                ok: false,
                unavailable: {
                  kind: "unavailable",
                  reason: "evaluator unavailable",
                  remedy: "supply evaluator",
                },
              };
            if (outcome === "revoke") f.trust.revoke("human", f.block.digest);
            return {
              ok: true,
              handle: {
                ownership: "owned",
                value: {
                  run: (options) => {
                    events.push("ran");
                    assert.equal(options.operation, "sample.run");
                    assert.ok(
                      options.timeoutMs > 0 && options.timeoutMs <= 1000,
                    );
                    if (outcome === "throw") throw Error("evaluation failed");
                    return options.encode("injected result");
                  },
                },
                close: async () => {
                  await Promise.resolve();
                  events.push("isolation closed");
                  if (outcome === "close-failure")
                    throw Error("cleanup failed");
                },
              },
            };
          },
        },
      });
      const result = await runtime.invoke(f.request);
      if (outcome === "success")
        assert.partialDeepStrictEqual(result, {
          ok: true,
          result: "injected result",
        });
      else assert.equal(result.ok, false);
      assert.deepEqual(events, [
        "opened",
        ...(outcome === "revoke" || outcome === "unavailable" ? [] : ["ran"]),
        ...(outcome === "unavailable" ? [] : ["isolation closed"]),
        "services closed",
      ]);
    } finally {
      f.close();
    }
  }
}, 5000);

test("missing evaluator fails closed after admission without activating code", async () => {
  const f = fixture("throw Error('must not run')");
  try {
    f.trust.admit("human", f.block.digest);
    assert.partialDeepStrictEqual(
      await new Runtime(f.catalog, f.trust).invoke(f.request),
      {
        ok: false,
        status: "INCOMPLETE",
        error: { code: "PROVIDER_MISSING" },
      },
    );
  } finally {
    f.close();
  }
}, 5000);
