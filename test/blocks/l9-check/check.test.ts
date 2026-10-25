import { expect, test } from "bun:test";
import {
  createCheck,
  verifyReceipt,
  type CheckServices,
} from "../../../src/blocks/check/index.ts";
import type {
  ProcessResult,
  ResolvedExecutable,
  SpawnOptions,
} from "../../../src/ports/process.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import { operations } from "../../../src/blocks/check/operations.ts";
import { hash } from "../../../src/blocks/check/receipt.ts";
import { captured } from "./fakes.ts";
import { exitCode } from "../../../src/surface/result.ts";
import { finalizationTimeoutMs } from "../../../src/blocks/check/budget.ts";

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
      capability: "forge.process/v1",
      resolve: (path) => ({ kind: "resolved", path }),
      run(
        _executable: ResolvedExecutable,
        _args: readonly string[],
        options: SpawnOptions,
      ) {
        environments.push(options.env);
        return Promise.resolve(
          captured(
            {
              stdout: "done",
              stderr: "",
              exitCode: 0,
              signal: null,
              timedOut: false,
              truncated: false,
              durationMs: 1,
              ...result,
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
  outputHeadBytes: 1024,
  outputTailBytes: 1024,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 262144,
  report: "auto" as const,
  stopOnFailure: true,
  inputs: [],
  maxInputBytes: 1048576,
  environment: [],
};

test("receipt finalization rejects a write/readback exceeding its own allowance", async () => {
  const { services, records } = fixture();
  let now = services.clock.now();
  const engine = createCheck({
    ...services,
    clock: { now: () => now },
    state: {
      ...services.state,
      put(...args) {
        now += finalizationTimeoutMs(config.maxReceiptBytes);
        return services.state.put(...args);
      },
    },
  });
  const failure = await engine.run({}, config).catch((error: unknown) => error);
  expect(String(failure)).toContain(
    "Check receipt finalization deadline exceeded",
  );
  expect(records.size).toBe(1);
}, 1000);

test("native private writes need five seconds of finalization at the 512 KiB cap", () => {
  expect(finalizationTimeoutMs(524288)).toBe(5000);
}, 1000);

for (const [childExit, status, exit] of [
  [0, "PASS", 0],
  [7, "FAIL", 1],
] as const) {
  test(`an exactly cap-sized receipt survives a slow write and exits from ${status}`, async () => {
    const cap = 524288;
    const { services, records } = fixture();
    let now = services.clock.now();
    let outputBytes = 0;
    let writeMs = 0;
    const engine = createCheck({
      ...services,
      clock: { now: () => now },
      process: {
        ...services.process,
        run(_executable, _args, options) {
          const stdout = "x".repeat(Math.ceil(outputBytes / 2));
          const stderr = "x".repeat(Math.floor(outputBytes / 2));
          const evidence = captured(
            {
              stdout,
              stderr,
              exitCode: childExit,
              signal: null,
              timedOut: false,
              truncated: true,
              durationMs: 1,
            },
            options,
          );
          // Fill the encoded boundary exactly, independently of the conservative
          // retention reservation. Each fake stream stays below maxOutputBytes.
          return Promise.resolve({ ...evidence, stdout, stderr });
        },
      },
      state: {
        ...services.state,
        put(...args) {
          now += writeMs;
          return services.state.put(...args);
        },
      },
    });
    const capped = {
      ...config,
      maxReceiptBytes: cap,
      maxOutputBytes: 262144,
      outputHeadBytes: 0,
      outputTailBytes: 0,
    };
    // Calibrate fixed metadata, then the decimal stream byte counters.
    for (let i = 0; i < 2; i++) {
      const probe = await engine.run({}, capped);
      outputBytes +=
        cap - Buffer.byteLength(JSON.stringify(probe)) - (i === 0 ? 32 : 0);
      records.clear();
    }
    writeMs = finalizationTimeoutMs(cap) - 1;
    const receipt = await engine.run({}, capped, {
      signal: new AbortController().signal,
      deadline: now + finalizationTimeoutMs(cap) + 1000,
    });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBe(cap);
    expect(Math.ceil(outputBytes / 2)).toBeLessThanOrEqual(
      capped.maxOutputBytes,
    );
    expect(receipt.status).toBe(status);
    expect(engine.show(receipt.id)).toEqual(receipt);
    expect(records.size).toBe(1);
    // The surface maps the accepted receipt's status to the process exit code.
    expect(
      exitCode(
        status === "PASS"
          ? {
              ok: true,
              op: "check.run",
              status: "OK",
              result: receipt,
              warnings: [],
            }
          : {
              ok: false,
              op: "check.run",
              status: "FAIL",
              error: {
                code: "CHECK_FAIL",
                message: "Checks failed",
                retry: "never",
              },
              result: receipt,
              warnings: [],
            },
      ),
    ).toBe(exit);
  }, 5000);
}

test("report parsing and stop behavior are declared choices", async () => {
  const { check, environments } = fixture({ stdout: "Tests: 0 total" });
  const receipt = await check.run(
    {},
    {
      ...config,
      report: "exit-code",
      commands: { first: "a", second: "b" },
      stopOnFailure: false,
    },
  );
  expect(receipt.status).toBe("PASS");
  expect(receipt.runs.map((run) => run.testCount)).toEqual([null, null]);
  expect(environments).toHaveLength(2);
  const failed = fixture({ exitCode: 1 });
  await failed.check.run(
    {},
    { ...config, commands: { first: "a", second: "b" }, stopOnFailure: false },
  );
  expect(failed.environments).toHaveLength(2);
}, 1000);

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

test("Bun summaries give receipts a count and reject failures even on exit zero", async () => {
  for (const [total, failed, status] of [
    [3, 0, "PASS"],
    [3, 1, "FAIL"],
    [0, 0, "FAIL"],
  ] as const) {
    const receipt = await fixture({
      stderr: ` ${total - failed} pass\n ${failed} fail\nRan ${total} tests across 1 file. [1ms]\n`,
    }).check.run({}, config);
    expect(receipt.status).toBe(status);
    expect(receipt.runs[0]?.testCount).toBe(total);
  }
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

test("malformed reports and timeouts are incomplete and keep output", async () => {
  for (const result of [
    { stdout: '{"numTotalTests":' },
    { timedOut: true, exitCode: null },
  ]) {
    const receipt = await fixture({
      stdout: "before timeout",
      ...result,
    }).check.run({}, config);
    expect(receipt.status).toBe("INCOMPLETE");
    expect(receipt.runs[0]?.stdout).toBe(result.stdout ?? "before timeout");
  }
}, 1000);

// About 100 KB of progress around a summary that neither retained head nor tail contains.
const large = (summary: string) =>
  `${"progress line\n".repeat(3600)}${summary}\n${"progress line\n".repeat(3600)}`;

test("large output is judged from the full stream; retained output is display only", async () => {
  const passing = await fixture({
    stdout: large("Tests:       40 passed, 40 total"),
  }).check.run({}, config);
  expect(passing.status).toBe("PASS");
  expect(passing.runs[0]).toMatchObject({ truncated: true, testCount: 40 });
  expect(passing.runs[0]!.stdout).not.toContain("Tests:");
  expect(verifyReceipt(passing, passing.inputsDigest)).toBe(true);
  for (const exitCode of [0, 1]) {
    const failing = await fixture({
      stdout: large("Tests:       2 failed, 38 passed, 40 total"),
      exitCode,
    }).check.run({}, config);
    expect(failing.status).toBe("FAIL");
    expect(failing.runs[0]).toMatchObject({ truncated: true, testCount: 40 });
  }
  const zero = await fixture({
    stdout: large("Tests:       0 total"),
  }).check.run({}, config);
  expect(zero.status).toBe("FAIL");
  expect(zero.runs[0]?.testCount).toBe(0);
  const unknown = await fixture({ stdout: large("no summary here") }).check.run(
    {},
    config,
  );
  expect(unknown.status).toBe("PASS");
  expect(unknown.runs[0]?.testCount).toBeNull();
  expect(unknown.runs[0]?.reason).toContain("unknown");
}, 1000);

test("output the recognizer did not see in full is never judged", async () => {
  const { services } = fixture();
  const receipt = await createCheck({
    ...services,
    process: {
      ...services.process,
      run: (executable, args, options) =>
        services.process.run(executable, args, {
          ...options,
          observer: { push() {} },
        }),
    },
  }).run({}, config);
  expect(receipt.status).toBe("INCOMPLETE");
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

test("receipt enum validation rejects coercible values even with a matching content digest", async () => {
  const receipt = await fixture().check.run({}, config);
  const { digest: _digest, ...body } = receipt;
  const malformed = { ...body, status: ["PASS"] };
  expect(
    verifyReceipt(
      { ...malformed, digest: hash(malformed) },
      receipt.inputsDigest,
    ),
  ).toBe(false);
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

test("the async run handler awaits the process service and applies the invocation deadline", async () => {
  const { services, records } = fixture();
  const controller = new AbortController();
  let complete: ((result: ProcessResult) => void) | undefined;
  let observedTimeout = 0;
  let observedSignal: unknown;
  const pending = operations["check.run"]({
    input: {},
    config,
    signal: controller.signal,
    deadline: services.clock.now() + 250,
    services: {
      ...services,
      process: {
        ...services.process,
        run(
          _executable: ResolvedExecutable,
          _args: readonly string[],
          options: SpawnOptions,
        ) {
          observedTimeout = options.timeoutMs;
          observedSignal = "signal" in options ? options.signal : undefined;
          return new Promise<ProcessResult>((resolve) => {
            complete = (result) => resolve(captured(result, options));
          });
        },
      },
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(records.size).toBe(0);
  expect(observedTimeout).toBe(250);
  expect(observedSignal).toBe(controller.signal);
  expect(complete).toBeDefined();
  complete!({
    exitCode: 0,
    signal: null,
    stdout: "done",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
  });
  expect((await pending).status).toBe("PASS");
  expect(records.size).toBe(1);
}, 1000);

test("cancelled or expired invocations start no process and persist no receipt", async () => {
  for (const cancelled of [true, false]) {
    const { services, records, environments } = fixture();
    const controller = new AbortController();
    if (cancelled) controller.abort();
    const failure = await operations["check.run"]({
      input: {},
      config,
      services,
      signal: controller.signal,
      deadline: services.clock.now() + (cancelled ? 1000 : 0),
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain(
      cancelled ? "INVOCATION_CANCELLED" : "INVOCATION_TIMEOUT",
    );
    expect(environments).toHaveLength(0);
    expect(records.size).toBe(0);
  }
}, 1000);

test("cancellation during a process prevents subsequent commands and accepted receipts", async () => {
  const { services, records } = fixture();
  const controller = new AbortController();
  let launches = 0;
  const run = operations["check.run"]({
    input: {},
    config: { ...config, commands: { test: "a", lint: "b" } },
    signal: controller.signal,
    deadline: services.clock.now() + 1000,
    services: {
      ...services,
      process: {
        ...services.process,
        run() {
          launches++;
          controller.abort();
          return Promise.resolve({
            exitCode: null,
            signal: "SIGKILL",
            stdout: "before cancellation",
            stderr: "",
            timedOut: false,
            truncated: false,
            durationMs: 1,
          });
        },
      },
    },
  });
  const failure = await run.catch((error: unknown) => error);
  expect(String(failure)).toContain("INVOCATION_CANCELLED");
  expect(launches).toBe(1);
  expect(records.size).toBe(0);
}, 1000);
