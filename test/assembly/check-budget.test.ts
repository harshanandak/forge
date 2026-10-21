import { expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, captureBlock } from "../../src/core/catalog/index.ts";
import { Runtime } from "../../src/core/runtime/index.ts";
import { TrustStore } from "../../src/core/trust/index.ts";
import { withCheckRunBudget } from "../../src/assembly/check-budget.ts";
import { ASSEMBLY_PROVIDES } from "../../src/assembly/providers.ts";
import { schemaDefaults } from "../../src/core/config/short.ts";
import schema from "../../src/blocks/check/schemas/config.json" with { type: "json" };
import manifest from "../../src/blocks/check/forge.block.json" with { type: "json" };
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { blockCapture } from "../../src/assembly/capture.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { validateBudgets } from "../../src/blocks/check/budget.ts";
import type { CheckConfig } from "../../src/blocks/check/types.ts";

test("assembled check.run preserves command config errors and exit 6", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-check-budget-"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(join(root, ".forge/config.yaml"), "blocks:\n  check: {}\n");
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) => {
    const handle = open(path);
    return {
      ...handle,
      value: {
        read: (name, budget) =>
          name === "entry.cjs"
            ? new TextEncoder().encode("module.exports={};")
            : handle.value.read(name, budget),
      },
    };
  });
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  try {
    for (const [command, message] of [
      [
        "tool && other",
        "Shell syntax needs a project-owned script; declare an argument array instead.",
      ],
      ['tool "unterminated', "Declared command contains an unclosed quote."],
    ]) {
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({ blocks: { check: { commands: { test: command } } } }),
      );
      const response = await runCli(
        assembly.catalog,
        ["check", "run"],
        localCall(assembly),
      );
      expect(response.envelope).toMatchObject({
        ok: false,
        op: "check.run",
        status: "FAIL",
        error: { code: "INPUT_INVALID", message, retry: "never" },
      });
      expect(response.exitCode).toBe(6);
    }
    for (const [changes, key, value, remedy] of [
      [
        { maxReceiptBytes: 40000 },
        "maxReceiptBytes",
        "40000",
        "maximum retained",
      ],
      [{ maxMetadataBytes: 1 }, "maxMetadataBytes", "1", "needs at least"],
      [{ maxOutputBytes: 1 }, "maxOutputBytes", "1", "maximum retained"],
    ] as const) {
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({
          blocks: { check: { commands: { test: "tool" }, ...changes } },
        }),
      );
      const response = await runCli(
        assembly.catalog,
        ["check", "run"],
        localCall(assembly),
      );
      expect(response.envelope).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID", retry: "never" },
      });
      expect(response.exitCode).toBe(6);
      if (!response.envelope.ok) {
        expect(response.envelope.error.message).toContain(key);
        expect(response.envelope.error.message).toContain(value);
        expect(response.envelope.error.message).toContain(remedy);
      }
    }
  } finally {
    await assembly.close();
    capture.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

function fixture(timeoutMs = 120000, override?: number, shipped = true) {
  const root = new URL("../../src/blocks/check/", import.meta.url);
  const block = captureBlock(
    "check",
    {
      open: () => ({
        ownership: "borrowed",
        value: {
          read: (name) =>
            name === "block.json"
              ? new TextEncoder().encode(JSON.stringify(manifest))
              : name === "schemas/run.output.json"
                ? new TextEncoder().encode("{}")
                : name === "entry.cjs"
                  ? new TextEncoder().encode("module.exports={};")
                  : readFileSync(new URL(name, root)),
        },
      }),
    },
    undefined,
    shipped,
  );
  const blocks = new Map([["checks", block]]);
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: {
        checks: {
          source: { builtin: "forge/check" },
          rename: { check: "verify" },
          config: {
            ...Object.fromEntries(
              schemaDefaults(schema).map(({ key, value }) => [key, value]),
            ),
            commands: { first: "tool", second: "tool" },
            timeoutMs,
          },
          ...(override === undefined
            ? {}
            : { operationTimeouts: { "check.run": override } }),
        },
      },
    },
    blocks,
    undefined,
    ASSEMBLY_PROVIDES,
  );
  const request = {
    schemaVersion: "forge.invocation/1",
    requestId: "budget",
    op: "verify.run",
    caller: "agent",
    context: {
      project: { id: "/fixture" },
      actor: { kind: "agent", id: "fixture" },
    },
    input: { checks: ["first"] },
  } as const;
  return { catalog, blocks, request };
}

test("a selected run exceeding 60 seconds finishes under its operation deadline", async () => {
  const f = fixture();
  let now = 0;
  const runtime = new Runtime(
    withCheckRunBudget(f.catalog, f.blocks, f.request),
    new TrustStore(),
    {
      clock: { now: () => now },
      services: () => Promise.resolve({ ownership: "borrowed", value: {} }),
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: {
                run(options) {
                  now += 90000;
                  return options.encode("completed");
                },
              },
            },
          }),
      },
    },
  );
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: true,
    result: "completed",
  });
}, 1000);

test("selected command budgets include two snapshots and finite finalization time", () => {
  const f = fixture();
  const selected = withCheckRunBudget(f.catalog, f.blocks, f.request);
  expect(selected.config.blocks.checks?.operationTimeouts?.["check.run"]).toBe(
    361000,
  );
  const all = withCheckRunBudget(f.catalog, f.blocks, {
    ...f.request,
    input: {},
  });
  expect(all.config.blocks.checks?.operationTimeouts?.["check.run"]).toBe(
    481000,
  );
  expect(f.catalog.config.blocks.checks?.operationTimeouts).toBeUndefined();
}, 1000);

test("sufficient explicit budgets, other operations and unshipped bytes keep their budgets", () => {
  for (const f of [fixture(120000, 500000), fixture(120000, undefined, false)])
    expect(withCheckRunBudget(f.catalog, f.blocks, f.request)).toBe(f.catalog);
  const f = fixture();
  expect(
    withCheckRunBudget(f.catalog, f.blocks, {
      ...f.request,
      op: "verify.list",
    }),
  ).toBe(f.catalog);
}, 1000);

test("explicit operation or host ceilings cannot silently shorten a selected run", () => {
  const f = fixture(120000, 10000);
  for (const text of [
    'blocks.checks.operationTimeouts["check.run"]',
    ".forge/config.yaml",
    "10 s",
    "at least 361 s",
    "blocks.checks.config.timeoutMs",
    "--input",
  ])
    expect(() => withCheckRunBudget(f.catalog, f.blocks, f.request)).toThrow(
      text,
    );
  const host = fixture();
  const capped = new Catalog(
    { ...host.catalog.config, runtime: { timeoutMs: 60000 } },
    host.blocks,
    undefined,
    ASSEMBLY_PROVIDES,
  );
  expect(() => withCheckRunBudget(capped, host.blocks, host.request)).toThrow(
    "runtime.timeoutMs (60 s)",
  );
  expect(() => withCheckRunBudget(capped, host.blocks, host.request)).toThrow(
    "raise it to at least 361 s",
  );
}, 1000);

test("a selected run whose full budget overflows the timer limit is rejected", () => {
  const f = fixture(2147483647);
  for (const text of [
    "timeouts add up to more than",
    "2147483.647 s",
    "blocks.checks.config.timeoutMs",
    "2147483.647 s each",
    "--input",
  ])
    expect(() => withCheckRunBudget(f.catalog, f.blocks, f.request)).toThrow(
      text,
    );
}, 1000);

test("the reusable receipt preflight throws the same typed error as deadline sizing", () => {
  const f = fixture();
  const config = f.catalog.config.blocks.checks!
    .config as unknown as CheckConfig;
  for (const changes of [
    { maxReceiptBytes: 40000 },
    { maxMetadataBytes: 1 },
    { maxOutputBytes: 1 },
    { outputHeadBytes: -1 },
  ])
    expect(() => validateBudgets({ ...config, ...changes })).toThrow(
      ForgeFailure,
    );
}, 1000);

test("an expired check operation names its sized budget and config remedy", async () => {
  const f = fixture();
  let now = 0;
  const runtime = new Runtime(
    withCheckRunBudget(f.catalog, f.blocks, f.request),
    new TrustStore(),
    {
      clock: { now: () => now },
      services: () => Promise.resolve({ ownership: "borrowed", value: {} }),
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: {
                run(options) {
                  now += options.timeoutMs + 1;
                  return options.encode("late");
                },
              },
            },
          }),
      },
    },
  );
  const result = await runtime.invoke(f.request);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVOCATION_TIMEOUT" },
  });
  if (result.ok) throw new Error("Expected expiry");
  for (const text of [
    'blocks.checks.operationTimeouts["check.run"]',
    ".forge/config.yaml",
    "361 s",
    "increase",
  ])
    expect(result.error.message).toContain(text);
}, 1000);
