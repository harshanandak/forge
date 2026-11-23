import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime, type ServiceScope } from "../../../src/core/runtime/index.ts";
import { TrustStore, admit, grant } from "../../fixtures/owner-approval.ts";
import type {
  InvocationRequest,
  ResultEnvelope,
} from "../../../src/generated/types.ts";
import { exitCode } from "../../../src/surface/result.ts";

// The operation deadline measures the handler's own work. Opening the store (directories, fsyncs,
// migrations) is the host's work, done before the handler starts, so a slow first open on a slow
// disk can never be charged to it.

function fixture(timeoutMs = 15000, effects: string[] = []) {
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
        effects,
        idempotent: true,
        callers: ["agent"],
        stability: "stable",
      },
    },
  });
  write("input.json", { type: "string" });
  write("output.json", { type: "string" });
  write("docs.json", "{}");
  write(
    "index.cjs",
    "module.exports = { 'sample.run': ({input}) => input, 'sample.run#check': () => 'checked' };",
  );
  const block = captureBlock(root, nodeFileCapture);
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./sample" } } },
    },
    new Map([["sample", block]]),
  );
  const trust = new TrustStore();
  admit(trust, block.digest);
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
    digest: block.digest,
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

const effects = ["memory:write"];
const missingGrant = {
  status: "INCOMPLETE",
  error: { code: "GRANT_REQUIRED" },
};
const checks = [
  ["check", { ok: true, result: "checked" }, 0, [[]]],
  ["plain", { ok: true, result: "hello" }, 0, [effects]],
  ["ungranted", missingGrant, 2, []],
] as const;
test.each(checks)(
  "runtime check: %s",
  async (mode, expected, exit, openedEffects) => {
    const f = fixture(15_000, effects);
    try {
      if (mode !== "ungranted") grant(f.trust, f.digest, effects);
      const scopes: ServiceScope[] = [];
      const runtime = new Runtime(f.catalog, f.trust, {
        isolation: nodeRunIsolation,
        services: (_instance, _context, scope) => {
          scopes.push(scope);
          return Promise.resolve({ ownership: "borrowed", value: {} });
        },
      });
      const invoke = runtime.invoke.bind(runtime) as unknown as (
        value: unknown,
        options: { check: boolean },
      ) => Promise<ResultEnvelope>;
      const plain = () => runtime.invoke(f.request);
      const result = await (mode === "plain"
        ? plain()
        : invoke(f.request, { check: true }));
      expect(result).toMatchObject(expected);
      expect(exitCode(result)).toBe(exit);
      expect(scopes.map((scope) => scope.effects)).toEqual([...openedEffects]);
      if (mode === "check") {
        await plain();
        expect(scopes).toMatchObject([
          { checking: true },
          { effects, checking: false },
        ]);
      }
    } finally {
      f.close();
    }
  },
  30_000,
);

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
