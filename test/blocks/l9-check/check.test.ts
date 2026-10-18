import { expect, test } from "bun:test";
import {
  createCheck,
  verifyReceipt,
  type CheckServices,
} from "../../../src/blocks/check/index.ts";
import type { ProcessResult } from "../../../src/ports/process.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";

function fixture(result: Partial<ProcessResult> = {}) {
  const records = new Map<string, StateRecord>();
  const environments: Readonly<Record<string, string>>[] = [];
  const services: CheckServices = {
    root: "/project",
    environment: { ONLY_CHILD: "yes" },
    clock: { now: () => 1_700_000_000_000 },
    snapshot: () =>
      Promise.resolve({
        head: "abc123",
        filesDigest: "sha256:" + "a".repeat(64),
      }),
    output: createRunnerOutput(),
    process: {
      resolve: (path) => ({ kind: "resolved", path }),
      run(_executable, _args, options) {
        environments.push(options.env);
        return Promise.resolve({
          stdout: "done",
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          truncated: false,
          durationMs: 1,
          ...result,
        });
      },
    },
    state: {
      get: (key) => records.get(key),
      list: () => [...records.values()],
      events: () => [],
      put(key, value) {
        const record = {
          namespace: "forge/check",
          key,
          value: structuredClone(value),
          revision: 1,
          updatedAt: "2023-11-14T22:13:20.000Z",
          updatedBy: { kind: "human" as const, id: "test" },
        };
        records.set(key, record);
        return record;
      },
    },
  };
  return { services, records, environments, check: createCheck(services) };
}
const config = {
  commands: { test: "declared-tool test" },
  timeoutMs: 1000,
  maxOutputBytes: 8192,
};

test("recognized zero tests fail; unknown output uses the exit code and unknown count", async () => {
  expect(
    (await fixture({ stdout: "Tests:       0 total" }).check.run({}, config))
      .status,
  ).toBe("FAIL");
  const unknown = await fixture().check.run({}, config);
  expect(unknown.status).toBe("PASS");
  expect(unknown.runs[0]?.testCount).toBeNull();
  expect((await fixture({ exitCode: 7 }).check.run({}, config)).status).toBe(
    "FAIL",
  );
}, 1000);

test("changing input files during execution cannot yield a passing receipt", async () => {
  const { services } = fixture();
  let reads = 0;
  const receipt = await createCheck({
    ...services,
    snapshot: () =>
      Promise.resolve({
        head: "same",
        filesDigest: "sha256:" + String(++reads).repeat(64),
      }),
  }).run({}, config);
  expect(receipt.status).toBe("INCOMPLETE");
  expect(receipt.reason).toContain("changed");
}, 1000);

test("malformed reports, timeout and truncated output are incomplete and keep output", async () => {
  for (const result of [
    { stdout: '{"numTotalTests":' },
    { timedOut: true, exitCode: null },
    { truncated: true },
  ]) {
    const receipt = await fixture({
      stdout: "before timeout",
      ...result,
    }).check.run({}, config);
    expect(receipt.status).toBe("INCOMPLETE");
    expect(receipt.runs[0]?.stdout).toBe(result.stdout ?? "before timeout");
  }
}, 1000);

test("nothing declared or a requested missing check is never pass", async () => {
  expect(
    (await fixture().check.run({}, { ...config, commands: {} })).status,
  ).toBe("NOT_EXECUTED");
  expect((await fixture().check.run({ checks: ["lint"] }, config)).status).toBe(
    "NOT_EXECUTED",
  );
}, 1000);

test("receipts bind exact inputs and their content; stored evidence is verified on read", async () => {
  const { check, records } = fixture();
  const receipt = await check.run({ trigger: "manual" }, config);
  expect(verifyReceipt(receipt, receipt.inputsDigest)).toBe(true);
  expect(
    verifyReceipt({ ...receipt, status: "FAIL" }, receipt.inputsDigest),
  ).toBe(false);
  expect(verifyReceipt(receipt, "sha256:" + "b".repeat(64))).toBe(false);
  expect(check.show(receipt.id)).toEqual(receipt);
  const record = records.get(`runs/${receipt.id}`)!;
  records.set(record.key, { ...record, value: { ...receipt, status: "FAIL" } });
  expect(() => check.show(receipt.id)).toThrow("integrity");
}, 1000);

test("command, head, environment, budgets and trigger each change the input binding", async () => {
  const base = await fixture().check.run({}, config);
  for (const change of [
    { config: { ...config, timeoutMs: 2000 } },
    { config: { ...config, commands: { test: "other-tool test" } } },
    { input: { trigger: "hook" } },
    { services: { environment: { ONLY_CHILD: "changed" } } },
    {
      services: {
        snapshot: () =>
          Promise.resolve({
            head: "other",
            filesDigest: "sha256:" + "a".repeat(64),
          }),
      },
    },
  ]) {
    const { services } = fixture();
    const receipt = await createCheck({ ...services, ...change.services }).run(
      change.input ?? {},
      change.config ?? config,
    );
    expect(receipt.inputsDigest).not.toBe(base.inputsDigest);
  }
}, 1000);

test("child environments are private snapshots and failure stops remaining checks", async () => {
  const { check, environments, services } = fixture({ exitCode: 1 });
  const receipt = await check.run(
    {},
    { ...config, commands: { test: "a", lint: "b" } },
  );
  expect(environments).toHaveLength(1);
  expect(environments[0]).not.toBe(services.environment);
  expect(environments[0]).toEqual({ ONLY_CHILD: "yes" });
  expect(receipt.runs.map((run) => run.status)).toEqual([
    "FAIL",
    "NOT_EXECUTED",
  ]);
}, 1000);
