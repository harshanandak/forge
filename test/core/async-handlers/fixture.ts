import { captureBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import {
  Runtime,
  type RuntimeOptions,
} from "../../../src/core/runtime/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import type {
  InvocationRequest,
  OperationDeclaration,
} from "../../../src/generated/types.ts";

export function fixture(
  source: string,
  declaration: Partial<OperationDeclaration> = {},
  legacy = false,
) {
  const files = new Map(
    Object.entries({
      "block.json": JSON.stringify({
        schemaVersion: "forge.block/1",
        id: "example.org/async",
        version: "1.0.0",
        authorAbi: legacy ? "forge.author/v1" : "forge.author/v2",
        profile: legacy ? "trusted-action-sync/v1" : "trusted-action/v2",
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
      "index.cjs": `module.exports = { 'sample.run': ${source} };`,
      "docs.json": JSON.stringify({
        operations: { "sample.run": { title: "Run", summary: "Run sample." } },
      }),
      "input.json": '{"type":"string"}',
      "output.json": '{"type":"string"}',
    }),
  );
  const block = captureBlock("fixture", {
    open: () => ({
      ownership: "borrowed",
      value: { read: (name) => new TextEncoder().encode(files.get(name)!) },
    }),
  });
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./sample" } } },
    },
    new Map([["sample", block]]),
  );
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  const request: InvocationRequest = {
    schemaVersion: "forge.invocation/1",
    requestId: "async-1",
    op: "sample.run",
    input: "hello",
    caller: "agent",
    context: {},
  };
  return {
    block,
    catalog,
    trust,
    request,
    runtime: (options: RuntimeOptions = {}) =>
      new Runtime(catalog, trust, { isolation: nodeRunIsolation, ...options }),
  };
}
