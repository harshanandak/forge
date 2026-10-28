import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import entry from "../../../src/blocks/check/entry.cts";
import {
  createCheck,
  type CheckConfig,
  type CheckServices,
  type MergeResult as RetainedMergeResult,
} from "../../../src/blocks/check/index.ts";
import { checkCrypto } from "../../../src/blocks/check/support.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import { captured } from "./fakes.ts";
import type {
  ProcessResult,
  SpawnOptions,
} from "../../../src/ports/process.ts";
import type {
  ResultEnvelope,
  StateRecord,
} from "../../../src/generated/types.ts";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { createMergeOutcome } from "../../../src/assembly/merge-outcome.ts";
import { ASSEMBLY_PROVIDES } from "../../../src/assembly/providers.ts";
import { checkResult } from "../../../src/assembly/check-result.ts";
import { exitCode } from "../../../src/surface/result.ts";
import manifest from "../../../src/blocks/check/forge.block.json" with { type: "json" };

setDefaultTimeout(1000);
const head = "a".repeat(40),
  base = "c".repeat(40),
  merged = "d".repeat(40);
const config: CheckConfig = {
  commands: { structure: "tool check" },
  timeoutMs: 1000,
  maxOutputBytes: 8192,
  outputHeadBytes: 1024,
  outputTailBytes: 1024,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 262144,
  report: "exit-code",
  stopOnFailure: true,
  inputs: [],
  maxInputBytes: 1048576,
  environment: ["PATH"],
};
const complete: ProcessResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  durationMs: 1,
};
type MergeResult = {
  outcome: string;
  pr: number;
  head: string;
  receipt?: string;
  mergeCommit?: string;
  detail?: string;
  gate: { reasons: { code: string }[] };
};
const catalog = {
  resolve: () => ({
    block: { manifest: { id: "forge/check" } },
    operation: { declaredOp: "pr.merge" },
  }),
} as unknown as Catalog;
function envelope(result: MergeResult) {
  return checkResult(catalog, "pull.merge", {
    ok: true,
    op: "pull.merge",
    status: "OK",
    result,
    warnings: [],
  });
}
function fixture() {
  const records = new Map<string, StateRecord>(),
    calls: string[][] = [];
  const controller = new AbortController();
  let cancelAfterGate = false,
    finalRead = false,
    finalReadChecked = false;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "aborted" && cancelAfterGate && finalRead) {
        if (finalReadChecked) return true;
        finalReadChecked = true;
        return false;
      }
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });
  let missing = false,
    unresolved = false,
    readback: unknown = {
      state: "MERGED",
      headRefOid: head,
      mergeCommit: { oid: merged },
    };
  let mergeResult: Partial<ProcessResult> = {},
    readResult: Partial<ProcessResult> = {};
  let throwMerge = false,
    throwRead = false,
    afterGate = false;
  let scoped = false;
  let hook:
    ((phase: "merge" | "readback", options: SpawnOptions) => void) | undefined;
  const services: CheckServices = {
    root: "/fixture",
    environment: { PATH: "fixture" },
    clock: { now: () => Date.now() },
    output: createRunnerOutput(),
    snapshot: () =>
      Promise.resolve({ head, filesDigest: "sha256:" + "b".repeat(64) }),
    state: {
      get: (key) => records.get(key),
      list: (prefix = "") =>
        [...records.values()].filter((r) => r.key.startsWith(prefix)),
      events: () => [],
      put(key, value) {
        const record: StateRecord = {
          namespace: "check",
          key,
          value: structuredClone(value),
          revision: 1,
          updatedAt: "2026-10-28T00:00:00Z",
          updatedBy: { kind: "human", id: "test" },
        };
        records.set(key, record);
        return record;
      },
    },
    process: {
      capability: "forge.process/v1",
      resolve: (path) =>
        missing
          ? { kind: "unavailable", reason: "missing", remedy: "install gh" }
          : { kind: "resolved", path },
      run(executable, args, options) {
        return Promise.resolve().then(() => {
          if (executable.path !== "gh")
            return captured({ ...complete, stdout: "checked" }, options);
          calls.push([...args]);
          expect(options.env).toEqual({ PATH: "fixture" });
          if (!scoped) expect(options.signal).toBe(signal);
          let value: unknown;
          if (args[0] === "pr" && args[1] === "merge") {
            expect(args).toEqual([
              "pr",
              "merge",
              "7",
              "--squash",
              "--match-head-commit",
              head,
            ]);
            expect(options.timeoutMs).toBeGreaterThan(0);
            expect(options.timeoutMs).toBeLessThanOrEqual(25000);
            hook?.("merge", options);
            if (throwMerge) throw new Error("merge transport failed");
            return { ...complete, ...mergeResult };
          }
          if (args[0] === "pr" && args[1] === "view") {
            if (args.includes("state,headRefOid,mergeCommit")) {
              expect(options.timeoutMs).toBeLessThanOrEqual(10000);
              hook?.("readback", options);
              if (throwRead) throw new Error("read transport failed");
              return {
                ...complete,
                stdout: JSON.stringify(readback),
                ...readResult,
              };
            }
            value = {
              headRefOid: head,
              headRefName: "feat/x",
              baseRefOid: base,
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              url: "https://github.com/org/repo/pull/7",
              changedFiles: 1,
            };
            if (calls.filter((a) => a[1] === "view").length === 2) {
              finalRead = true;
              if (afterGate) controller.abort();
            }
          } else if (args.some((arg) => arg.includes("statusCheckRollup"))) {
            value = [
              {
                data: {
                  repository: {
                    object: {
                      oid: head,
                      statusCheckRollup: {
                        contexts: {
                          totalCount: 1,
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "CI Gate",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                              isRequired: true,
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  },
                },
              },
            ];
          } else if (args[1]?.includes("/compare/"))
            value = [
              {
                base_commit: { sha: base },
                files: [{ filename: "src/main.ts", status: "modified" }],
              },
            ];
          else
            value = [
              {
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [{ id: "thread", isResolved: !unresolved }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  },
                },
              },
            ];
          return { ...complete, stdout: JSON.stringify(value) };
        });
      },
    },
  };
  const clients = {
    process: services.process,
    state: services.state,
    crypto: checkCrypto,
    files: { root: services.root },
    environment: {
      select(names: string[]) {
        expect(names).toEqual([
          "PATH",
          "GH_TOKEN",
          "GH_HOST",
          "GH_ENTERPRISE_TOKEN",
        ]);
        return services.environment;
      },
    },
  };
  return {
    calls,
    controller,
    records,
    clients,
    receipt: () => createCheck(services).run({}, config),
    alter(options: {
      missing?: boolean;
      unresolved?: boolean;
      readback?: unknown;
      mergeResult?: Partial<ProcessResult>;
      readResult?: Partial<ProcessResult>;
      throwMerge?: boolean;
      throwRead?: boolean;
      afterGate?: boolean;
      cancelAfterGate?: boolean;
      scoped?: boolean;
      hook?: typeof hook;
    }) {
      missing = options.missing ?? missing;
      unresolved = options.unresolved ?? unresolved;
      if (Object.hasOwn(options, "readback")) readback = options.readback;
      mergeResult = options.mergeResult ?? mergeResult;
      readResult = options.readResult ?? readResult;
      throwMerge = options.throwMerge ?? throwMerge;
      throwRead = options.throwRead ?? throwRead;
      afterGate = options.afterGate ?? afterGate;
      cancelAfterGate = options.cancelAfterGate ?? cancelAfterGate;
      scoped = options.scoped ?? scoped;
      hook = options.hook ?? hook;
    },
    async run(gateConfig = config, deadline = Date.now() + 100000) {
      const handler = (
        entry as unknown as Record<
          string,
          (args: unknown) => Promise<MergeResult>
        >
      )["pr.merge"];
      expect(handler).toBeFunction();
      try {
        return await handler!({
          input: { pr: 7 },
          config: gateConfig,
          signal,
          deadline,
          services: clients,
        });
      } finally {
        for (const args of calls.filter((args) => args[1] === "merge"))
          expect(args).toEqual([
            "pr",
            "merge",
            "7",
            "--squash",
            "--match-head-commit",
            head,
          ]);
      }
    },
  };
}

test("pr.merge declares its destructive non-idempotent contract", () => {
  const op = (manifest.operations as Record<string, unknown>)["pr.merge"];
  expect(op).toMatchObject({
    args: ["pr"],
    timeoutMs: 100000,
    idempotent: false,
    destructive: true,
    callers: ["human", "agent"],
    stability: "experimental",
    effects: [
      "external:process",
      "external:network",
      "external:write",
      "files:read",
      "environment:read",
    ],
  });
});
for (const reason of ["receipt", "door", "thread", "missing"])
  test(`gate ${reason} refusal preserves evidence and never merges`, async () => {
    const f = fixture();
    if (reason !== "receipt") await f.receipt();
    f.alter({ unresolved: reason === "thread", missing: reason === "missing" });
    const result = await f.run(
      reason === "door"
        ? { ...config, gate: { doorPaths: ["src/**"] } }
        : config,
    );
    const response = envelope(result);
    expect(result.outcome).toBe("REFUSED");
    expect(result.gate.reasons.length).toBeGreaterThan(0);
    expect(result.gate.reasons.map((item) => item.code)).toContain(
      {
        receipt: "RECEIPT_MISSING",
        door: "DOOR_PATH_TOUCHED",
        thread: "UNRESOLVED_THREADS",
        missing: "GITHUB_EVIDENCE_INVALID",
      }[reason]!,
    );
    expect(response).toMatchObject({
      ok: false,
      status: "FAIL",
      error: { code: "CHECK_GATE_REFUSED", retry: "reconcile_first" },
    });
    expect(exitCode(response)).toBe(1);
    expect(f.calls.filter((a) => a[1] === "merge")).toHaveLength(0);
  });
test("merge outcome envelopes preserve the full result through operation aliases", () => {
  for (const [outcome, code, status, exit] of [
    ["REFUSED", "CHECK_GATE_REFUSED", "FAIL", 1],
    ["HEAD_MOVED", "HEAD_MOVED", "FAIL", 1],
    ["MERGE_REFUSED", "MERGE_REFUSED", "FAIL", 1],
    ["MERGE_UNVERIFIED", "MERGE_UNVERIFIED", "INCOMPLETE", 2],
  ] as const) {
    const result = {
      outcome,
      pr: 7,
      head,
      gate: { reasons: [{ code: "RECEIPT_MISSING" }] },
    };
    const response = envelope(result);
    expect(response).toMatchObject({
      ok: false,
      status,
      error: { code, retry: "reconcile_first" },
    });
    expect(response.result).toBe(result);
    expect(exitCode(response)).toBe(exit);
  }
});
test("success returns gate head, receipt and verified merge commit", async () => {
  const f = fixture(),
    receipt = await f.receipt(),
    result = await f.run();
  expect(result).toMatchObject({
    outcome: "MERGED",
    pr: 7,
    head,
    receipt: receipt.id,
    mergeCommit: merged,
  });
  expect(envelope(result).ok).toBe(true);
  expect(exitCode(envelope(result))).toBe(0);
  expect(f.calls.filter((a) => a[1] === "merge")).toHaveLength(1);
});
for (const state of ["OPEN", "CLOSED"])
  test(`head moves before merge and readback ${state}: no second merge`, async () => {
    const f = fixture();
    await f.receipt();
    f.alter({
      mergeResult: { exitCode: 1 },
      readback: { state, headRefOid: "b".repeat(40), mergeCommit: null },
    });
    const result = await f.run();
    expect(envelope(result)).toMatchObject({
      ok: false,
      status: "FAIL",
      error: { code: "HEAD_MOVED" },
    });
    expect(exitCode(envelope(result))).toBe(1);
    expect(f.calls.filter((a) => a[1] === "merge")).toHaveLength(1);
  });
for (const state of ["OPEN", "CLOSED"])
  for (const changedHead of [false, true])
    test(`successful merge exit with ${state} at ${changedHead ? "another" : "the pinned"} head remains unverified`, async () => {
      const f = fixture();
      const receipt = await f.receipt();
      f.alter({
        readback: {
          state,
          headRefOid: changedHead ? "b".repeat(40) : head,
          mergeCommit: null,
        },
      });
      const result = await f.run();
      expect(result).toMatchObject({
        outcome: "MERGE_UNVERIFIED",
        head,
        receipt: receipt.id,
      });
      expect(exitCode(envelope(result))).toBe(2);
      expect(f.calls.filter((a) => a[1] === "merge")).toHaveLength(1);
    });
for (const scenario of [
  "other head",
  "read failure",
  "read timeout",
  "bad JSON",
  "invalid oid",
  "invalid state",
  "queued",
])
  test(`${scenario} readback is incomplete with exit 2`, async () => {
    const f = fixture();
    await f.receipt();
    if (scenario === "other head")
      f.alter({
        readback: {
          state: "MERGED",
          headRefOid: "b".repeat(40),
          mergeCommit: { oid: merged },
        },
      });
    if (scenario === "read failure") f.alter({ throwRead: true });
    if (scenario === "read timeout")
      f.alter({ readResult: { timedOut: true, exitCode: null } });
    if (scenario === "bad JSON") f.alter({ readResult: { stdout: "{" } });
    if (scenario === "invalid oid")
      f.alter({
        readback: {
          state: "MERGED",
          headRefOid: head,
          mergeCommit: { oid: "invalid" },
        },
      });
    if (scenario === "invalid state")
      f.alter({
        readback: {
          state: ["OPEN"],
          headRefOid: "b".repeat(40),
          mergeCommit: null,
        },
      });
    if (scenario === "queued")
      f.alter({
        readback: { state: "OPEN", headRefOid: head, mergeCommit: null },
      });
    const result = await f.run();
    expect(envelope(result)).toMatchObject({
      ok: false,
      status: "INCOMPLETE",
      error: { code: "MERGE_UNVERIFIED" },
    });
    expect(exitCode(envelope(result))).toBe(2);
    expect(f.calls.filter((a) => a[1] === "merge")).toHaveLength(1);
  });
for (const scenario of ["timeout", "nonzero", "throw"])
  test(`merge ${scenario} still reads back and accepts the pinned merged head`, async () => {
    const f = fixture();
    await f.receipt();
    f.alter(
      scenario === "throw"
        ? { throwMerge: true }
        : {
            mergeResult:
              scenario === "timeout"
                ? { timedOut: true, exitCode: null }
                : { exitCode: 1 },
          },
    );
    expect(await f.run()).toMatchObject({
      outcome: "MERGED",
      head,
      mergeCommit: merged,
    });
  });
test("same-head GitHub refusal keeps bounded detail", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    mergeResult: { exitCode: 1, stderr: "denied".repeat(100) },
    readback: { state: "CLOSED", headRefOid: head, mergeCommit: null },
  });
  const result = await f.run();
  expect(envelope(result)).toMatchObject({
    ok: false,
    status: "FAIL",
    error: { code: "MERGE_REFUSED" },
  });
  expect(result.detail).toHaveLength(300);
});
for (const cancellation of ["before", "during gate", "after gate", "expired"])
  test(`${cancellation} invocation cannot call merge`, async () => {
    const f = fixture();
    await f.receipt();
    if (cancellation === "before") f.controller.abort();
    if (cancellation === "during gate") f.alter({ afterGate: true });
    if (cancellation === "after gate") f.alter({ cancelAfterGate: true });
    await expect(
      f.run(
        config,
        cancellation === "expired" ? Date.now() - 1 : Date.now() + 100000,
      ),
    ).rejects.toMatchObject({
      code:
        cancellation === "expired"
          ? "INVOCATION_TIMEOUT"
          : "INVOCATION_CANCELLED",
    });
    expect(f.calls.filter((a) => a[1] === "merge")).toHaveLength(0);
  });

async function interruptedRuntime(
  phase: "merge" | "readback",
  interruption: "deadline" | "cancel",
  recover = true,
) {
  const f = fixture();
  const receipt = await f.receipt();
  const source = new URL("../../../src/blocks/check/", import.meta.url);
  const block = captureBlock(
    "check",
    {
      open: () => ({
        ownership: "borrowed",
        value: {
          read: (name) =>
            name === "block.json"
              ? new TextEncoder().encode(JSON.stringify(manifest))
              : name === "entry.cjs"
                ? new TextEncoder().encode("module.exports={};")
                : readFileSync(new URL(name, source)),
        },
      }),
    },
    undefined,
    true,
  );
  const runtimeCatalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: {
        check: { source: { builtin: "forge/check" }, config: { ...config } },
      },
    },
    new Map([["check", block]]),
    undefined,
    ASSEMBLY_PROVIDES,
  );
  const outcome = createMergeOutcome(
    runtimeCatalog,
    "pr.merge",
    { pr: 7 },
    10250,
  );
  let now = Date.now();
  const deadline = now + 100000;
  const time = spyOn(Date, "now").mockImplementation(() => now);
  f.alter({
    scoped: true,
    readResult: { stdout: "partial readback".repeat(300), timedOut: true },
    hook(current, options) {
      if (current === "merge")
        expect(
          options.timeoutMs + 2 * 10250 + 10000 + 1000,
        ).toBeLessThanOrEqual(deadline - now);
      if (current !== phase) return;
      // A host pause during process cleanup can consume the reserved margin too.
      if (interruption === "deadline") now = deadline + 1;
      else f.controller.abort();
    },
  });
  try {
    const runtime = new Runtime(runtimeCatalog, new TrustStore(), {
      clock: { now: () => now },
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: { ...f.clients, process: outcome.process(f.clients.process) },
        }),
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: {
                async run(options) {
                  const handler = (
                    entry as unknown as Record<
                      string,
                      (args: unknown) => Promise<MergeResult>
                    >
                  )["pr.merge"]!;
                  return options.encode(await handler(options.args));
                },
              },
            },
          }),
      },
    });
    const envelope = await runtime.invoke(
      {
        schemaVersion: "forge.invocation/1",
        requestId: "interrupted-merge",
        op: "pr.merge",
        caller: "agent",
        input: { pr: 7 },
        context: {
          project: { id: "/fixture" },
          actor: { kind: "agent", id: "test" },
        },
      },
      { signal: f.controller.signal },
    );
    return {
      response: checkResult(
        runtimeCatalog,
        "pr.merge",
        envelope,
        recover ? outcome.result() : undefined,
      ),
      receipt,
      calls: f.calls,
      outcome,
      catalog: runtimeCatalog,
    };
  } finally {
    time.mockRestore();
  }
}

for (const phase of ["merge", "readback"] as const)
  for (const interruption of ["deadline", "cancel"] as const)
    test(`${interruption} during ${phase} cleanup retains evidence after the runtime discards handler output`, async () => {
      const { response, receipt, calls } = await interruptedRuntime(
        phase,
        interruption,
      );
      expect(response).toMatchObject({
        ok: false,
        status: "INCOMPLETE",
        error: { code: "MERGE_UNVERIFIED" },
        result: {
          outcome: "MERGE_UNVERIFIED",
          head,
          receipt: receipt.id,
          gate: { verdict: "PASS" },
        },
      });
      expect(exitCode(response)).toBe(2);
      expect(calls.filter((args) => args[1] === "merge")).toHaveLength(1);
      if (phase === "readback") {
        expect(response.result).toMatchObject({
          readbackProcess: {
            exitCode: 0,
            timedOut: true,
            truncated: true,
            stdout: "partial readback".repeat(300).slice(0, 2048),
          },
        });
      }
    });

test("removing assembly recovery reproduces the lost post-write deadline result", async () => {
  const { response } = await interruptedRuntime("readback", "deadline", false);
  expect(response).toMatchObject({
    ok: false,
    status: "FAIL",
    error: { code: "INVOCATION_TIMEOUT" },
  });
  expect(response.result).toBeUndefined();
});

test("post-write recovery preserves cleanup and authority failures", async () => {
  const { outcome, catalog } = await interruptedRuntime("merge", "deadline");
  for (const code of [
    "PROCESS_CLEANUP_FAILED",
    "GRANT_REQUIRED",
    "ADMISSION_REQUIRED",
    "SERVICE_EXPIRED",
    "OUTPUT_INVALID",
  ]) {
    const failure: ResultEnvelope = {
      ok: false,
      op: "pr.merge",
      status: "INCOMPLETE",
      error: { code, message: "failure", retry: "reconcile_first" },
      warnings: [],
    };
    expect(checkResult(catalog, "pr.merge", failure, outcome.result())).toBe(
      failure,
    );
  }
});

test("recovery rejects invalid checkpoints and requires the exact merge invocation", async () => {
  const { response, catalog, outcome } = await interruptedRuntime(
    "readback",
    "deadline",
  );
  const retained = response.result as RetainedMergeResult;
  const failure: ResultEnvelope = {
    ok: false,
    op: "pr.merge",
    status: "FAIL",
    error: {
      code: "INVOCATION_CANCELLED",
      message: "cancelled",
      retry: "reconcile_first",
    },
    warnings: [],
  };
  const argv = ["pr", "merge", "7", "--squash", "--match-head-commit", head];
  const port = {
    capability: "forge.process/v1" as const,
    resolve: (path: string) => ({ kind: "resolved" as const, path }),
    run: () => Promise.resolve(complete),
  };
  const options = {
    cwd: "/fixture",
    env: {},
    timeoutMs: 1,
    maxOutputBytes: 8192,
  };
  for (const invalid of [
    { ...retained, pr: 8 },
    { ...retained, unexpected: true },
    { ...retained, head: "b".repeat(40) },
    { ...retained, gate: { ...retained.gate, verdict: "REFUSED" } },
    { ...retained, receipt: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    {
      ...retained,
      readbackProcess: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: "x".repeat(2049),
        stderr: "",
      },
    },
    {
      ...retained,
      gate: {
        ...retained.gate,
        checks: [{ name: "x".repeat(1048577), state: "SUCCESS" }],
      },
    },
  ]) {
    const recovery = createMergeOutcome(catalog, "pr.merge", { pr: 7 }, 10250);
    const process = recovery.process(port);
    process.retainMergeOutcome!(invalid as RetainedMergeResult);
    await process.run({ kind: "resolved", path: "gh" }, argv, options);
    expect(checkResult(catalog, "pr.merge", failure, recovery.result())).toBe(
      failure,
    );
  }
  for (const actual of [
    undefined,
    ["pr", "merge", "7", "--merge", "--match-head-commit", head],
  ]) {
    const recovery = createMergeOutcome(catalog, "pr.merge", { pr: 7 }, 10250);
    const process = recovery.process(port);
    process.retainMergeOutcome!(retained);
    if (actual)
      await process.run({ kind: "resolved", path: "gh" }, actual, options);
    expect(checkResult(catalog, "pr.merge", failure, recovery.result())).toBe(
      failure,
    );
  }
  const { readbackProcess: _raw, ...initialDraft } = retained;
  outcome.process(port).retainMergeOutcome!(initialDraft);
  expect(
    checkResult(catalog, "pr.merge", failure, outcome.result()).result,
  ).toMatchObject({
    readbackProcess: retained.readbackProcess,
  });
});
