import { expect, test } from "bun:test";
import { rejects, throws } from "node:assert/strict";
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
import manifest from "../../../src/blocks/check/forge.block.json" with { type: "json" };
import { validateBlockManifest } from "../../../src/contract/index.ts";
import { captured } from "./fakes.ts";
import {
  createCheck,
  validateBudgets,
} from "../../../src/blocks/check/index.ts";
import { commandArguments } from "../../../src/blocks/check/command.ts";

test("the check manifest uses locked major interface references in every slot", () => {
  expect(validateBlockManifest(manifest).ok).toBe(true);
  for (const requirement of manifest.requires) {
    expect(
      validateBlockManifest({
        ...manifest,
        requires: manifest.requires.map((item) =>
          item === requirement
            ? { ...item, interface: item.interface.replace(/@1$/, "@^1.0.0") }
            : item,
        ),
      }).ok,
    ).toBe(false);
  }
}, 1000);
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
  outputHeadBytes: 1024,
  outputTailBytes: 1024,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 262144,
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
        return Promise.resolve(
          captured(
            {
              exitCode: 0,
              signal: null,
              stdout: "Tests: 1 passed, 1 total",
              stderr: "",
              timedOut: false,
              truncated: false,
              durationMs: 1,
            },
            options,
          ),
        );
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

test("snapshot HEAD lookups have enough output independently of command retention", async () => {
  for (const width of [40, 64]) {
    for (const cap of [1, 40, 64]) {
      const { services, records } = fixture();
      const head = "a".repeat(width);
      services.files.snapshot = (input) => {
        // Windows may emit CRLF; the complete longest supported object id must fit.
        expect(input.maxOutputBytes).toBeGreaterThanOrEqual(66);
        return Promise.resolve({
          head,
          filesDigest: "sha256:" + "b".repeat(64),
        });
      };
      const run = services.process.run.bind(services.process);
      services.process.run = (executable, args, options) => {
        expect(options.maxOutputBytes).toBe(cap);
        return run(executable, args, options);
      };
      const receipt = await handlers["check.run"]({
        input: {},
        services,
        config: {
          ...config,
          maxOutputBytes: cap,
          outputHeadBytes: cap,
          outputTailBytes: 0,
        },
        signal: new AbortController().signal,
        deadline: Date.now() + 10000,
      });
      expect(receipt.subject).toBe(head);
      expect(records.size).toBe(1);
    }
  }
}, 1000);

test("snapshot requests use the invocation ceiling while commands keep their declared limit", async () => {
  for (const timeoutMs of [1, 1500, 5000, 120000]) {
    const { services } = fixture();
    const snapshotBudgets: number[] = [];
    const snapshot = services.files.snapshot.bind(services.files);
    services.files.snapshot = (input) => {
      snapshotBudgets.push(input.timeoutMs);
      return snapshot(input);
    };
    const run = services.process.run.bind(services.process);
    services.process.run = (executable, args, options) => {
      expect(options.timeoutMs).toBe(timeoutMs);
      return run(executable, args, options);
    };
    const receipt = await handlers["check.run"]({
      input: {},
      services,
      config: { ...config, timeoutMs },
      signal: new AbortController().signal,
      deadline: Date.now() + 500000,
    });
    expect(receipt.status).toBe("PASS");
    expect(snapshotBudgets).toHaveLength(2);
    expect(
      snapshotBudgets.every((budget) => budget > 120000 && budget <= 500000),
    ).toBe(true);
  }
}, 1000);

test("every command-string parser path rejects with INPUT_INVALID before service access", async () => {
  for (const command of ["tool && other", 'tool "unterminated', " "]) {
    const invalidConfig = { ...config, commands: { test: command } };
    expect(validateWithSchema(schema, invalidConfig)).toEqual([]);
    throws(() => commandArguments(command), { code: "INPUT_INVALID" });
    throws(() => validateBudgets(invalidConfig), { code: "INPUT_INVALID" });
    const { services, observed } = fixture();
    await rejects(
      handlers["check.run"]({
        input: {},
        config: invalidConfig,
        get services(): CatalogServices {
          throw Error("must not access services");
        },
        signal: new AbortController().signal,
        deadline: Date.now() + 10000,
      }),
      { code: "INPUT_INVALID" },
    );
    await rejects(
      createCheck({
        ...services,
        root: "/clone",
        environment: {},
        clock: { now: () => 0 },
        snapshot: () => {
          throw Error("must not snapshot");
        },
      }).run({}, invalidConfig),
      { code: "INPUT_INVALID" },
    );
    expect(observed).toEqual([]);
  }
}, 1000);

test("captured input bindings ignore invocation deadlines while deadline enforcement remains active", async () => {
  const { services, records } = fixture();
  const now = Date.now();
  const args = {
    input: {},
    config,
    services,
    signal: new AbortController().signal,
  };
  const first = await handlers["check.run"]({ ...args, deadline: now + 10000 });
  const second = await handlers["check.run"]({
    ...args,
    deadline: now + 20000,
  });
  expect(first.inputsDigest).toBe(second.inputsDigest);
  expect(first.id).not.toBe(second.id);
  await rejects(handlers["check.run"]({ ...args, deadline: now - 1 }), {
    code: "INVOCATION_TIMEOUT",
  });
  expect(records.size).toBe(2);
}, 1000);
