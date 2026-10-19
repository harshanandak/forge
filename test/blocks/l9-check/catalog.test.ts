import { expect, test } from "bun:test";
import entry from "../../../src/blocks/check/entry.cts";
import { checkCrypto } from "../../../src/blocks/check/support.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import type { CatalogServices } from "../../../src/blocks/check/services.ts";
import type {
  CheckConfig,
  CheckReceipt,
} from "../../../src/blocks/check/types.ts";
import type { HandlerArgs } from "../../../src/contract/author.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import { validateWithSchema } from "../../../src/contract/schema.ts";
import schema from "../../../src/blocks/check/schemas/config.json" with { type: "json" };
type Args<T> = HandlerArgs<T, CheckConfig, CatalogServices>;
const handlers = entry as unknown as {
  "check.run"(
    args: Args<{ checks?: readonly string[] }>,
  ): Promise<CheckReceipt>;
  "check.list"(args: Args<Record<string, never>>): {
    commands: readonly string[];
  };
  "check.show"(args: Args<{ id: string }>): CheckReceipt | null;
};
const config: CheckConfig = {
  commands: { test: { argv: ["declared-command", "arg"] } },
  timeoutMs: 1000,
  maxOutputBytes: 8192,
  report: "auto",
  stopOnFailure: true,
  inputs: ["source.txt"],
  maxInputBytes: 4096,
  environment: ["SELECTED"],
};
function fixture() {
  const records = new Map<string, StateRecord>();
  const observed: string[] = [];
  const services: CatalogServices = {
    crypto: checkCrypto,
    output: createRunnerOutput(),
    files: {
      root: "/clone",
      read: () => undefined,
      snapshot(input) {
        expect(input.paths).toEqual(config.inputs);
        expect(input.maxBytes).toBe(4096);
        observed.push("snapshot");
        return Promise.resolve({
          head: "head",
          filesDigest: "sha256:" + "a".repeat(64),
        });
      },
    },
    environment: {
      select(names) {
        expect(names).toEqual(["SELECTED"]);
        return { SELECTED: "value" };
      },
    },
    process: {
      capability: "forge.process/v1",
      resolve: (path) => ({ kind: "resolved", path }),
      run(_executable, _args, options) {
        expect(options.env).toEqual({ SELECTED: "value" });
        expect(options.cwd).toBe("/clone");
        expect(options.signal).toBeDefined();
        observed.push("run");
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "Tests: 1 passed, 1 total",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        });
      },
    },
    state: {
      get: (key) => records.get(key),
      list: () => [...records.values()],
      events: () => [],
      put(key, value) {
        const record: StateRecord = {
          namespace: "forge/check",
          key,
          value,
          revision: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: { kind: "human", id: "fixture" },
        };
        records.set(key, record);
        return record;
      },
    },
  };
  return { services, observed, records };
}
test("captured handlers consume the shared service interfaces and read their accepted receipt", async () => {
  const { services, observed } = fixture();
  const args = {
    input: {},
    config,
    services,
    signal: new AbortController().signal,
    deadline: Date.now() + 1000,
  };
  expect(handlers["check.list"](args)).toEqual({ commands: ["test"] });
  expect(observed).toEqual([]);
  const receipt = await handlers["check.run"](args);
  expect(receipt.status).toBe("PASS");
  expect(receipt.runs[0]?.testCount).toBe(1);
  expect(observed).toEqual(["snapshot", "run", "snapshot"]);
  expect(
    handlers["check.show"]({ ...args, input: { id: receipt.id } }),
  ).toEqual(receipt);
}, 1000);
test("declared config rejects missing choices and out-of-range budgets", () => {
  expect(validateWithSchema(schema, config)).toEqual([]);
  for (const [key, value] of [
    ["timeoutMs", 0],
    ["timeoutMs", 2147483648],
    ["maxOutputBytes", 262145],
    ["maxInputBytes", 0],
    ["maxInputBytes", 67108865],
    ["report", "invented"],
    ["environment", ["BAD=NAME"]],
  ] as const)
    expect(
      validateWithSchema(schema, { ...config, [key]: value }).length,
    ).toBeGreaterThan(0);
  for (const key of Object.keys(config)) {
    const missing = { ...config } as Record<string, unknown>;
    delete missing[key];
    expect(validateWithSchema(schema, missing).length).toBeGreaterThan(0);
  }
}, 1000);
