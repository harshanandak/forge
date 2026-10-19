import { test, expect } from "bun:test";
import { CapturedBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import type { BlockManifest } from "../../../src/generated/types.ts";
import { Recorder } from "../../../tools/conformance/record.ts";
import { assertConformance } from "../../../tools/conformance/assert.ts";

function fixture(withRefusal = true) {
  const declaration = {
    input: "input.json",
    output: "schemas/output.json",
    context: "stateless" as const,
    timeoutMs: 1000,
    effects: [],
    idempotent: true,
    callers: ["human" as const],
    stability: "experimental" as const,
  };
  const manifest: BlockManifest = {
    schemaVersion: "forge.block/1",
    id: "example.org/sample",
    version: "1.0.0",
    authorAbi: "forge.author/v1",
    profile: "trusted-action-sync/v1",
    entry: "entry.cjs",
    docs: "docs.json",
    operations: { "sample.read": declaration, "sample.write": declaration },
  };
  const files = new Map([
    ["input.json", '{"type":"string"}'],
    [
      "schemas/output.json",
      JSON.stringify({
        "x-conformance-refusals": withRefusal ? ["refusal.json"] : [],
        oneOf: [
          { type: "string" },
          ...(withRefusal ? [{ $ref: "refusal.json" }] : []),
        ],
      }),
    ],
    ["schemas/refusal.json", '{"const":false}'],
    [
      "entry.cjs",
      "module.exports={'sample.read':({input})=>{if(input==='error')throw Error('failure');return input==='refuse'?false:input},'sample.write':()=>false}",
    ],
    ["docs.json", "{}"],
  ]);
  const block = new CapturedBlock(files, manifest);
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./sample" } } },
    },
    new Map([["sample", block]]),
  );
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  const runtime = new Runtime(catalog, trust, { isolation: nodeRunIsolation });
  const recorder = new Recorder((request) => runtime.invoke(request));
  const call = (op: string, input: unknown = "value") =>
    recorder.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "conformance",
      op,
      input,
      caller: "human",
      context: {},
    });
  return { block, recorder, call };
}

const verify = (f: ReturnType<typeof fixture>) =>
  assertConformance([f.block], f.recorder.observations());

test("real outputs, refusals and errors conform; missing coverage fails", async () => {
  const f = fixture();
  await f.call("sample.read");
  expect(() => verify(f)).toThrow(/unobserved refusal/);
  await f.call("sample.read", "refuse");
  expect(() => verify(f)).toThrow(/sample.write.*unobserved/);
  await f.call("sample.write");
  await f.call("sample.read", "error");
  expect(() => verify(f)).not.toThrow();
  await f.call("sample.read", 7);
  expect(() => verify(f)).toThrow(/input/);
}, 5000);

test("removing the refusal schema branch fails on the real output", async () => {
  const f = fixture(false);
  await f.call("sample.read");
  await f.call("sample.write");
  expect(() => verify(f)).toThrow(/OUTPUT_INVALID/);
}, 5000);

test("malformed outputs and errors cannot pass as observations", async () => {
  const f = fixture();
  for (const outcome of [
    { ok: true, result: 7 },
    { ok: false, error: { code: "BAD" } },
    { ok: true, op: "sample.read", result: 7, status: "OK", warnings: [] },
  ]) {
    const observations = [
      { operation: "sample.read", input: "value", outcome },
    ];
    expect(() => assertConformance([f.block], observations)).toThrow();
  }
  await f.call("sample.unknown");
  expect(() => verify(f)).toThrow(/undeclared/);
}, 5000);
