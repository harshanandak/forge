import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rejects } from "node:assert/strict";
import entry from "../../../src/blocks/check/entry.cts";
import { checkCrypto } from "../../../src/blocks/check/support.ts";
import { StreamCapture } from "../../../src/adapters/process/capture.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import type {
  CheckConfig,
  CheckServices,
} from "../../../src/blocks/check/types.ts";
import type { CryptoService } from "../../../src/blocks/check/services.ts";
import type { CatalogServices } from "../../../src/blocks/check/services.ts";
import type { CheckBlock } from "../../../src/blocks/check/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";

const pure = entry as unknown as {
  "check.run"(args: {
    config: CheckConfig;
    input: Record<string, never>;
    services: CatalogServices;
    signal: AbortSignal;
    deadline: number;
  }): Promise<import("../../../src/blocks/check/types.ts").CheckReceipt>;
  validateBudgets(config: CheckConfig): { totalBytes: number };
  digest(value: unknown, crypto: CryptoService): string;
  createCheck(services: CheckServices & { crypto: CryptoService }): CheckBlock;
};
const ceiling = 1048576;
const config: CheckConfig = {
  commands: {
    first: { argv: ["declared", "first"] },
    second: { argv: ["declared", "second"] },
  },
  timeoutMs: 1000,
  maxOutputBytes: 262144,
  outputHeadBytes: 4096,
  outputTailBytes: 4096,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 524288,
  report: "auto",
  stopOnFailure: false,
  inputs: [],
  maxInputBytes: 1024,
  environment: [],
};
function fixture(unavailable = false) {
  const records = new Map<string, StateRecord>();
  let snapshots = 0,
    launches = 0,
    resolves = 0;
  const hashSizes: number[] = [];
  const crypto: CryptoService = {
    ...checkCrypto,
    sha256(text) {
      const size = Buffer.byteLength(text);
      hashSizes.push(size);
      if (size > ceiling) throw new Error("LIMIT_EXCEEDED: host hash ceiling");
      return checkCrypto.sha256(text);
    },
  };
  const stream = "H" + "x".repeat(262142) + "T";
  const services: CheckServices & { crypto: CryptoService } = {
    crypto,
    root: "/clone",
    environment: {},
    clock: { now: () => 1700000000000 },
    output: createRunnerOutput(),
    snapshot: () => {
      snapshots++;
      return Promise.resolve({
        head: "head",
        filesDigest: "sha256:" + "a".repeat(64),
      });
    },
    process: {
      capability: "forge.process/v1",
      resolve(path) {
        resolves++;
        return unavailable
          ? {
              kind: "unavailable",
              reason: "Absent",
              remedy: "Declare an available command",
            }
          : { kind: "resolved", path };
      },
      run(_exe, _args, options) {
        launches++;
        const stdout = new StreamCapture(
            options.maxOutputBytes,
            options.capture,
          ),
          stderr = new StreamCapture(options.maxOutputBytes, options.capture);
        stdout.push(Buffer.from(stream));
        stderr.push(Buffer.from(stream));
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: 1,
          timedOut: false,
          truncated: stdout.truncated || stderr.truncated,
          ...(options.capture
            ? {
                outputEvidence: {
                  stdout: stdout.evidence(true),
                  stderr: stderr.evidence(true),
                },
              }
            : {}),
        });
      },
    },
    state: {
      get: (key) => records.get(key),
      list: () => [...records.values()],
      events: () => [],
      put(key, value) {
        const record = {
          key,
          value,
          namespace: "forge/check",
          revision: 1,
          updatedAt: "date",
          updatedBy: { kind: "human" as const, id: "test" },
        };
        records.set(key, record);
        return record;
      },
    },
  };
  return {
    engine: pure.createCheck(services),
    crypto,
    hashSizes,
    stream,
    counts: () => ({ snapshots, launches, resolves }),
  };
}

test("two commands emitting maximum output return a bounded, verified receipt with full stream digests", async () => {
  const f = fixture();
  const receipt = await f.engine.run({}, config);
  expect(receipt.runs).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(
    config.maxReceiptBytes,
  );
  const expected =
    "sha256:" + createHash("sha256").update(f.stream).digest("hex");
  for (const run of receipt.runs)
    for (const evidence of [run.stdoutEvidence, run.stderrEvidence]) {
      expect(evidence?.digest).toBe(expected);
      expect(evidence?.totalBytes).toBe(262144);
      expect(evidence?.complete).toBe(true);
      expect(Buffer.from(evidence!.head, "base64").length).toBe(
        config.outputHeadBytes,
      );
      expect(Buffer.from(evidence!.tail, "base64").length).toBe(
        config.outputTailBytes,
      );
    }
  expect(f.engine.show(receipt.id)).toEqual(receipt);
  expect(Math.max(...f.hashSizes)).toBeLessThanOrEqual(ceiling);
}, 1000);

test("captured preflight rejects conflicting budgets before reading any service slot", async () => {
  const services = new Proxy({} as CatalogServices, {
    get() {
      throw new Error("Service I/O before preflight");
    },
  });
  await rejects(
    pure["check.run"]({
      config: { ...config, maxReceiptBytes: 40000 },
      input: {},
      services,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
    }),
    { code: "INPUT_INVALID" },
  );
}, 1000);

test("one pure budget validator refuses conflicts before snapshot, resolution or execution", async () => {
  const maximum = Math.floor(
    (config.maxReceiptBytes - config.maxMetadataBytes) / (4 * 10),
  );
  expect(
    pure.validateBudgets({
      ...config,
      outputHeadBytes: 1,
      outputTailBytes: maximum - 1,
    }).totalBytes,
  ).toBe(config.maxReceiptBytes);
  expect(() =>
    pure.validateBudgets({
      ...config,
      outputHeadBytes: 1,
      outputTailBytes: maximum,
    }),
  ).toThrow(`maximum retained bytes per stream is ${maximum}`);
  expect(pure.validateBudgets(config).totalBytes).toBeLessThanOrEqual(
    config.maxReceiptBytes,
  );
  for (const changes of [
    { maxReceiptBytes: 40000 },
    { maxMetadataBytes: 1 },
    { maxOutputBytes: 4096 },
  ]) {
    const f = fixture();
    await rejects(f.engine.run({}, { ...config, ...changes }), {
      code: "INPUT_INVALID",
      message: /INPUT_INVALID.*(?:maximum|at least)/,
    });
    expect(f.counts()).toEqual({ snapshots: 0, launches: 0, resolves: 0 });
  }
}, 1000);

test("large declaration bindings and UTF-8 boundary inputs use bounded, distinct hashes", async () => {
  const f = fixture(true);
  const commands = Object.fromEntries(
    Array.from({ length: 128 }, (_, i) => [
      "check" + i,
      { argv: ["declared", "a".repeat(4200)] },
    ]),
  );
  const receipt = await f.engine.run(
    {},
    {
      ...config,
      commands,
      outputHeadBytes: 1,
      outputTailBytes: 1,
      maxMetadataBytes: 850000,
      maxReceiptBytes: ceiling,
    },
  );
  expect(receipt.runs).toHaveLength(128);
  expect(f.engine.show(receipt.id)).toEqual(receipt);
  const value = "😀".repeat(ceiling / 4);
  const edge = "x".repeat(ceiling - 2);
  expect(pure.digest(edge, f.crypto)).toBe(
    "sha256:" + createHash("sha256").update(JSON.stringify(edge)).digest("hex"),
  );
  expect(pure.digest(edge + "x", f.crypto)).not.toBe(
    pure.digest(edge, f.crypto),
  );
  const prefix = "a".repeat(Math.floor(ceiling / 3) - 2),
    suffix = "x".repeat(ceiling);
  expect(pure.digest(prefix + "😀" + suffix, f.crypto)).not.toBe(
    pure.digest(prefix + "😁" + suffix, f.crypto),
  );
  expect(pure.digest({ value }, f.crypto)).toBe(
    pure.digest({ value }, f.crypto),
  );
  expect(pure.digest({ value }, f.crypto)).not.toBe(
    pure.digest({ value: value + "x" }, f.crypto),
  );
  expect(Math.max(...f.hashSizes)).toBeLessThanOrEqual(ceiling);
}, 5000);
