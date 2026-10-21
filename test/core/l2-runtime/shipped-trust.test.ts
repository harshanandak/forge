import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { TrustStore, type TrustRecord } from "../../../src/core/trust/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { createAssembly } from "../../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";

/** A block that claims the shipped work block's id and declares a write effect. */
const files: Record<string, string> = {
  "block.json": JSON.stringify({
    schemaVersion: "forge.block/1",
    id: "forge/work",
    version: "1.0.0",
    authorAbi: "forge.author/v2",
    profile: "trusted-action/v2",
    entry: "index.cjs",
    docs: "docs.json",
    operations: {
      "sample.run": {
        input: "input.json",
        output: "output.json",
        context: "stateless",
        effects: ["sample:write"],
        idempotent: true,
        callers: ["human", "agent"],
        stability: "stable",
      },
    },
  }),
  "index.cjs": "module.exports = { 'sample.run': ({ input }) => input };",
  "docs.json": JSON.stringify({
    operations: { "sample.run": { title: "Run", summary: "Run sample." } },
  }),
  "input.json": '{"type":"string"}',
  "output.json": '{"type":"string"}',
};
const request = {
  schemaVersion: "forge.invocation/1",
  requestId: "shipped-1",
  op: "sample.run",
  input: "hello",
  caller: "agent",
  context: {},
} as const;

const code = (envelope: ResultEnvelope) =>
  envelope.ok ? undefined : envelope.error.code;

function run(shipped: boolean) {
  const block = captureBlock(
    "fixture",
    {
      open: () => ({
        ownership: "borrowed",
        value: { read: (name) => new TextEncoder().encode(files[name]) },
      }),
    },
    undefined,
    shipped,
  );
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./sample" } } },
    },
    new Map([["sample", block]]),
  );
  const records = new Map<string, TrustRecord>();
  const runtime = new Runtime(catalog, new TrustStore(records), {
    isolation: nodeRunIsolation,
    limits: { timeoutMs: 1000 },
  });
  return { records, result: runtime.invoke(request) };
}

test("shipped bytes run for an agent with no admission, grant or trust record", async () => {
  const { records, result } = run(true);
  const envelope = await result;
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.result, "hello");
  assert.equal(records.size, 0, "no trust record is written for shipped bytes");
}, 5000);

test("the same bytes from anywhere else still need human admission", async () => {
  const envelope = await run(false).result;
  assert.equal(code(envelope), "ADMISSION_REQUIRED");
}, 5000);

test("a path block reusing a built-in id is refused until admitted", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-shipped-"));
  try {
    const root = join(work, "project");
    const block = join(root, "blocks", "work");
    mkdirSync(block, { recursive: true });
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(block, name), text);
    const assembly = await createAssembly({
      root,
      deviceRoot: join(work, "device"),
    });
    try {
      const call = (op: string, input: unknown, caller: "human" | "agent") =>
        assembly.catalog.invoke({
          ...request,
          op,
          input,
          caller,
          context: {
            actor: { kind: caller, id: caller },
            project: { id: root, root },
            device: { id: assembly.deviceRoot },
          },
        });
      const added = await call("block.add", { path: "./blocks/work" }, "human");
      assert.equal(added.ok, true);
      if (!added.ok) throw new Error("registration failed");
      assert.equal((added.result as { admitted: boolean }).admitted, false);
      assert.equal(
        code(await call("sample.run", "hello", "agent")),
        "ADMISSION_REQUIRED",
      );
    } finally {
      await assembly.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 10000);
