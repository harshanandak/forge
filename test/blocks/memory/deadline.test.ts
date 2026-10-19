import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import type { InvocationRequest } from "../../../src/generated/types.ts";

// The operation deadline measures the handler's own work. Opening the store (directories, fsyncs,
// migrations) is the host's work, done before the handler starts, so a slow first open on a slow
// disk can never be charged to it.

function fixture(timeoutMs = 15000) {
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
        timeoutMs,
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

test("store preparation and evaluator opening finish before the declared handler budget starts", async () => {
  const f = fixture();
  try {
    const events: string[] = [];
    let now = 0;
    const runtime = new Runtime(f.catalog, f.trust, {
      clock: { now: () => now },
      services: async () => {
        // Directory creation, fsyncs and migrations may exceed the handler budget.
        now += 30000;
        await Promise.resolve();
        events.push(`services opened at ${now}`);
        return { ownership: "borrowed", value: {} };
      },
      isolation: {
        open: () => {
          now += 2000;
          return Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: {
                run(options) {
                  events.push(
                    `handler started at ${now} with ${options.timeoutMs} ms`,
                  );
                  return options.encode("hello");
                },
              },
            },
          });
        },
      },
    });
    expect(await runtime.invoke(f.request)).toMatchObject({
      ok: true,
      result: "hello",
    });
    expect(events).toEqual([
      "services opened at 30000",
      "handler started at 32000 with 15000 ms",
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("a store open longer than the declared handler budget leaves that whole budget for the handler", async () => {
  const f = fixture(20);
  try {
    let now = 0;
    let closed = 0;
    const runtime = new Runtime(f.catalog, f.trust, {
      clock: { now: () => now },
      services: () => {
        now += 60;
        return Promise.resolve({
          ownership: "owned",
          value: {},
          close: () => {
            closed++;
            return Promise.resolve();
          },
        });
      },
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: {
                run(options) {
                  expect(options.timeoutMs).toBe(20);
                  now += 19;
                  return options.encode("hello");
                },
              },
            },
          }),
      },
    });
    expect(await runtime.invoke(f.request)).toMatchObject({
      ok: true,
      result: "hello",
    });
    expect(closed).toBe(1);
  } finally {
    f.close();
  }
}, 30_000);
