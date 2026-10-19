import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import type { InvocationRequest } from "../../../src/generated/types.ts";

// The operation deadline measures the handler's own work. Opening the store (directories, fsyncs,
// migrations) is the host's work, done before the handler starts, so a slow first open on a slow
// disk can never be charged to it.

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "deadline-"));
  const write = (name: string, value: unknown) =>
    writeFileSync(
      join(root, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  write("block.json", {
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
        callers: ["agent"],
        stability: "stable",
      },
    },
  });
  write("input.json", { type: "string" });
  write("output.json", { type: "string" });
  write("docs.json", "{}");
  write("index.cjs", "module.exports = { 'sample.run': ({input}) => input };");
  const block = captureBlock(root, nodeFileCapture);
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
    requestId: "request-1",
    op: "sample.run",
    input: "hello",
    caller: "agent",
    context: {},
  };
  return {
    catalog,
    trust,
    request,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("opening services finishes before the handler starts, and its time is not the handler's", async () => {
  const f = fixture();
  try {
    const events: string[] = [];
    let clock = 0;
    const runtime = new Runtime(f.catalog, f.trust, {
      services: async () => {
        // A first open on a slow disk: directory creation, fsyncs and migrations.
        clock += 10_000;
        await Promise.resolve();
        events.push(`services opened at ${clock}`);
        return { ownership: "borrowed", value: {} };
      },
      isolation: {
        async open() {
          const opened = await nodeRunIsolation.open();
          if (!opened.ok) return opened;
          return {
            ok: true,
            handle: {
              ownership: "owned",
              value: {
                run(options) {
                  events.push(
                    `handler started at ${clock} with ${options.timeoutMs} ms`,
                  );
                  return opened.handle.value.run(options);
                },
              },
              close: () => opened.handle.close(),
            },
          };
        },
      },
    });
    const result = await runtime.invoke(f.request);
    expect(result.ok).toBe(true);
    // The handler's whole budget starts after the 10,000 ms open, undiminished.
    expect(events).toEqual([
      "services opened at 10000",
      "handler started at 10000 with 1000 ms",
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("a store open slower than the handler deadline does not fail the operation", async () => {
  const f = fixture();
  try {
    const runtime = new Runtime(f.catalog, f.trust, {
      limits: { timeoutMs: 20 },
      services: async () => {
        // Three times the handler's whole deadline spent opening.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ownership: "borrowed", value: {} };
      },
      isolation: nodeRunIsolation,
    });
    const result = await runtime.invoke(f.request);
    expect(result.ok).toBe(true);
  } finally {
    f.close();
  }
}, 30_000);
