import { expect, test } from "bun:test";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { invocationDeadline } from "../../../src/core/runtime/deadline.ts";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import {
  validateConfigDocument,
  validateOperationDeclaration,
} from "../../../src/generated/validators.ts";
import type {
  ConfigDocument,
  InvocationRequest,
  OperationDeclaration,
} from "../../../src/generated/types.ts";

function fixture(timeoutMs?: number, config?: ConfigDocument) {
  const operation: OperationDeclaration = {
    input: "input.json",
    output: "output.json",
    context: "stateless",
    effects: [],
    idempotent: true,
    callers: ["human", "agent"],
    stability: "stable",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const files = new Map(
    Object.entries({
      "block.json": JSON.stringify({
        schemaVersion: "forge.block/1",
        id: "example.org/sample",
        version: "1.0.0",
        authorAbi: "forge.author/v1",
        profile: "trusted-action-sync/v1",
        entry: "index.cjs",
        docs: "docs.json",
        operations: { "sample.run": operation },
      }),
      "index.cjs": "module.exports={};",
      "input.json": "{}",
      "output.json": "{}",
      "docs.json": "{}",
    }),
  );
  const block = captureBlock("fixture", {
    open: () => ({
      ownership: "borrowed",
      value: { read: (name) => new TextEncoder().encode(files.get(name)) },
    }),
  });
  const catalog = new Catalog(
    config ?? {
      schemaVersion: "forge.config/1",
      blocks: { sample: { source: { path: "./sample" } } },
    },
    new Map([["sample", block]]),
  );
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  const request: InvocationRequest = {
    schemaVersion: "forge.invocation/1",
    requestId: "deadline",
    op: "sample.run",
    caller: "agent",
    context: {},
    input: {},
  };
  return { catalog, trust, request, operation };
}

test("a declared durable operation can spend more than one second in services and in its write", async () => {
  const f = fixture(15000);
  let now = 100;
  let budget = 0;
  let writes = 0;
  const runtime = new Runtime(f.catalog, f.trust, {
    clock: { now: () => now },
    services: () => {
      now += 2000;
      return Promise.resolve({ ownership: "borrowed", value: {} });
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
                budget = options.timeoutMs;
                now += 2000;
                writes++;
                return options.encode("written");
              },
            },
          },
        }),
    },
  });
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: true,
    result: "written",
  });
  expect(writes).toBe(1);
  expect(budget).toBe(13000);
}, 30000);

test("the deadline includes service and evaluator acquisition without waiting for wall time", async () => {
  const f = fixture(15000);
  let now = 0;
  let runs = 0;
  const runtime = new Runtime(f.catalog, f.trust, {
    clock: { now: () => now },
    services: () => {
      now = 15000;
      return Promise.resolve({ ownership: "borrowed", value: {} });
    },
    isolation: {
      open: () => {
        runs++;
        throw Error("must not open");
      },
    },
  });
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: false,
    error: { code: "INVOCATION_TIMEOUT", retry: "never" },
  });
  expect(runs).toBe(0);
}, 30000);

test("expiry during a write is a typed failure requiring reconciliation", async () => {
  const f = fixture(15000);
  let now = 0;
  const runtime = new Runtime(f.catalog, f.trust, {
    clock: { now: () => now },
    isolation: {
      open: () =>
        Promise.resolve({
          ok: true,
          handle: {
            ownership: "owned",
            close: () => Promise.resolve(),
            value: {
              run(options) {
                now = 15001;
                return options.encode("written");
              },
            },
          },
        }),
    },
  });
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: false,
    error: { code: "INVOCATION_TIMEOUT", retry: "reconcile_first" },
  });
}, 30000);

test("config adjusts the original operation name and host budgets remain ceilings", async () => {
  const f = fixture(1000, {
    schemaVersion: "forge.config/1",
    runtime: { timeoutMs: 12000 },
    blocks: {
      sample: {
        source: { path: "./sample" },
        operationTimeouts: { "sample.run": 15000 },
        rename: { sample: "local" },
      },
    },
  });
  let budget = 0;
  const runtime = new Runtime(f.catalog, f.trust, {
    limits: { timeoutMs: 14000 },
    clock: { now: () => 0 },
    isolation: {
      open: () =>
        Promise.resolve({
          ok: true,
          handle: {
            ownership: "owned",
            close: () => Promise.resolve(),
            value: {
              run(options) {
                budget = options.timeoutMs;
                return options.encode("ok");
              },
            },
          },
        }),
    },
  });
  expect(await runtime.invoke({ ...f.request, op: "local.run" })).toMatchObject(
    { ok: true },
  );
  expect(budget).toBe(12000);
}, 30000);

test("legacy manifests need an explicit embedding or composition budget", async () => {
  const f = fixture();
  let opens = 0;
  const runtime = new Runtime(f.catalog, f.trust, {
    services: () => {
      opens++;
      return Promise.resolve({ ownership: "borrowed", value: {} });
    },
  });
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: false,
    error: { code: "INPUT_INVALID" },
  });
  expect(opens).toBe(0);
  const deadline = invocationDeadline(
    {
      declared: undefined,
      configured: undefined,
      host: 15000,
      embedding: undefined,
    },
    { now: () => 0 },
  );
  expect(deadline.remaining()).toBe(15000);
}, 30000);

for (const invalid of [0, -1, 1.5, 2147483648, NaN, Infinity])
  test(`deadline declarations and configured overrides refuse ${invalid}`, () => {
    const f = fixture();
    expect(
      validateOperationDeclaration({ ...f.operation, timeoutMs: invalid }).ok,
    ).toBe(false);
    expect(
      validateConfigDocument({
        schemaVersion: "forge.config/1",
        runtime: { timeoutMs: invalid },
        blocks: {},
      }).ok,
    ).toBe(false);
    expect(
      validateConfigDocument({
        schemaVersion: "forge.config/1",
        blocks: {
          sample: {
            source: { path: "./sample" },
            operationTimeouts: { "sample.run": invalid },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      () => new Runtime(f.catalog, f.trust, { limits: { timeoutMs: invalid } }),
    ).toThrow();
  }, 30000);

test("both safety endpoints are valid, and remaining time never becomes an unbounded timer", () => {
  for (const value of [1, 2147483647]) {
    let now = 0;
    const deadline = invocationDeadline(
      {
        declared: value,
        configured: undefined,
        host: undefined,
        embedding: undefined,
      },
      { now: () => now },
    );
    expect(deadline.remaining()).toBe(value);
    now = value;
    expect(() => deadline.remaining()).toThrow();
  }
}, 30000);
