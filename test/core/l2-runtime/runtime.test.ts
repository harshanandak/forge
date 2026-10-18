import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Catalog,
  captureBlock,
  addBlock,
  assembleCoreManifest,
} from "../../../src/core/catalog/index.ts";
import { TrustStore, secretReference } from "../../../src/core/trust/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import type {
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

test("discovery never activates code and denied admission never opens services", async () => {
  const f = fixture("services.spy(); return input");
  let calls = 0;
  try {
    assert.deepEqual(f.catalog.list(), ["sample.run"]);
    const runtime = new Runtime(f.catalog, f.trust, {
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
  ["async output", "return Promise.resolve(input)", "BLOCK_ASYNC_UNSUPPORTED"],
  [
    "rejected async output",
    "return Promise.reject(Error('refused'))",
    "BLOCK_ASYNC_UNSUPPORTED",
  ],
  ["non-JSON output", "return new Date()", "OUTPUT_INVALID"],
  ["hostile getter", "return {get x(){throw Error('bad')}}", "OUTPUT_INVALID"],
  ["time limit", "while(true) {}", "LIMIT_EXCEEDED"],
  ["output limit", "return 'x'.repeat(10000)", "LIMIT_EXCEEDED"],
] as const)
  test(`${name} fails closed and closes owned services`, async () => {
    const f = fixture(code);
    let closed = 0;
    try {
      f.trust.admit("human", f.block.digest);
      const runtime = new Runtime(f.catalog, f.trust, {
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
  const fragments = ["catalog", "trust"].map(
    (area) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../src/core/${area}/operations.json`, import.meta.url),
          "utf8",
        ),
      ) as Record<string, OperationDeclaration>,
  );
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
