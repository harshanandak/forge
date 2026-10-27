import { expect, test } from "bun:test";
import {
  createCheck,
  type CheckConfig,
  type CheckServices,
  type GateResult,
} from "../../../src/blocks/check/index.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import type { ProcessResult } from "../../../src/ports/process.ts";
import { captured } from "./fakes.ts";
import entry from "../../../src/blocks/check/entry.cts";
import { checkCrypto } from "../../../src/blocks/check/support.ts";
import type { CatalogServices } from "../../../src/blocks/check/services.ts";
import type { HandlerArgs } from "../../../src/contract/author.ts";
import { checkResult } from "../../../src/assembly/check-result.ts";
import { exitCode } from "../../../src/surface/result.ts";
import type { Catalog } from "../../../src/core/catalog/index.ts";

const head = "a".repeat(40);
const base = "c".repeat(40);

function ciPage(checks: unknown, oid = head, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        object: {
          oid,
          statusCheckRollup: {
            contexts: {
              totalCount: Array.isArray(checks) ? checks.length : 0,
              nodes: Array.isArray(checks)
                ? checks.map((check: { name?: unknown; state?: unknown }) => ({
                    __typename: "CheckRun",
                    name: check.name,
                    status:
                      check.state === "IN_PROGRESS"
                        ? "IN_PROGRESS"
                        : "COMPLETED",
                    conclusion: check.state,
                    isRequired: true,
                  }))
                : checks,
              pageInfo: { hasNextPage: endCursor !== null, endCursor },
            },
          },
        },
      },
    },
  };
}
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
  environment: [],
};
function fixture(headRefName: unknown = "feat/x") {
  const records = new Map<string, StateRecord>();
  let receiptHead = head;
  let receiptExit = 0;
  let now = 1_700_000_000_000;
  let views = 0;
  let laterHead = head;
  let bounce = false;
  const headHistory: string[] = [];
  let pinnedChecks: unknown;
  let pinnedFilePages: unknown;
  let ciPages: unknown;
  let comparePages: unknown;
  let laterBase = base;
  let checks: unknown = [{ name: "CI Gate", state: "SUCCESS", bucket: "pass" }];
  let pages: unknown = [
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: "thread-1", isResolved: true }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ];
  let filePages: unknown = [[{ filename: "src/main.ts", status: "modified" }]];
  let changedFiles = 1;
  let state = "OPEN";
  let mergeStateStatus = "CLEAN";
  let corrupt: Partial<ProcessResult> = {};
  let throwProcess = false;
  const calls: string[][] = [];
  const services: CheckServices = {
    root: "/project",
    environment: { GH_TOKEN: "test-placeholder" },
    clock: { now: () => now },
    output: createRunnerOutput(),
    snapshot: () =>
      Promise.resolve({
        head: receiptHead,
        filesDigest: "sha256:" + "b".repeat(64),
      }),
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
          updatedAt: "2023-11-14T22:13:20.000Z",
          updatedBy: { kind: "human", id: "test" },
        };
        records.set(key, record);
        return record;
      },
    },
    process: {
      capability: "forge.process/v1",
      resolve: (path) => ({ kind: "resolved", path }),
      run(executable, args, options) {
        if (executable.path !== "gh")
          return Promise.resolve(
            captured(
              {
                exitCode: receiptExit,
                signal: null,
                stdout: "checked",
                stderr: "",
                timedOut: false,
                truncated: false,
                durationMs: 1,
              },
              options,
            ),
          );
        calls.push([...args]);
        expect(options.env.GH_TOKEN).toBe("test-placeholder");
        if (throwProcess) throw new Error("process failed");
        let stdout: string;
        if (args[0] === "pr" && args[1] === "view") {
          headHistory.push(views === 0 ? head : laterHead);
          stdout = JSON.stringify({
            headRefOid: ++views === 1 ? head : laterHead,
            headRefName,
            baseRefOid: views === 1 ? base : laterBase,
            state,
            mergeStateStatus,
            url: "https://github.com/org/repo/pull/7",
            changedFiles,
          });
        } else if (args[0] === "pr" && args[1] === "checks")
          stdout = JSON.stringify(checks);
        else if (args[0] === "api") {
          if (args.some((arg) => arg.includes("statusCheckRollup"))) {
            expect(args).toContain(`head=${head}`);
            stdout = JSON.stringify(
              ciPages ?? [ciPage(pinnedChecks ?? checks)],
            );
          } else if (args[1]?.includes("/compare/")) {
            expect(args[1]).toContain(`${base}...${head}`);
            const files = pinnedFilePages ?? filePages;
            stdout = JSON.stringify(
              comparePages ??
                (Array.isArray(files)
                  ? files.map((_page, index) => ({
                      base_commit: { sha: base },
                      ...(index === 0 ? { files: files.flat() } : {}),
                    }))
                  : files),
            );
          } else
            stdout = JSON.stringify(args[1] === "graphql" ? pages : filePages);
        } else throw new Error(`Unexpected gh command: ${args.join(" ")}`);
        if (bounce && headHistory.length === 1)
          headHistory.push("b".repeat(40));
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
          ...corrupt,
        });
      },
    },
  };
  const check = createCheck(services);
  return {
    records,
    calls,
    headHistory,
    services,
    async receipt(options: { head?: string; exit?: number } = {}) {
      receiptHead = options.head ?? head;
      receiptExit = options.exit ?? 0;
      now += 1000;
      return await check.run({}, config);
    },
    gate(
      gateConfig: CheckConfig = config,
      scope?: { signal: AbortSignal; deadline: number },
    ) {
      return check.gate({ pr: 7 }, gateConfig, scope);
    },
    alter(options: {
      laterHead?: string;
      laterBase?: string;
      bounce?: boolean;
      pinnedChecks?: unknown;
      pinnedFilePages?: unknown;
      ciPages?: unknown;
      comparePages?: unknown;
      checks?: unknown;
      pages?: unknown;
      filePages?: unknown;
      changedFiles?: number;
      state?: string;
      mergeStateStatus?: string;
      corrupt?: Partial<ProcessResult>;
      throwProcess?: boolean;
    }) {
      laterHead = options.laterHead ?? laterHead;
      laterBase = options.laterBase ?? laterBase;
      bounce = options.bounce ?? bounce;
      pinnedChecks = options.pinnedChecks ?? pinnedChecks;
      pinnedFilePages = options.pinnedFilePages ?? pinnedFilePages;
      ciPages = options.ciPages ?? ciPages;
      comparePages = options.comparePages ?? comparePages;
      checks = options.checks ?? checks;
      pages = options.pages ?? pages;
      filePages = options.filePages ?? filePages;
      changedFiles = options.changedFiles ?? changedFiles;
      state = options.state ?? state;
      mergeStateStatus = options.mergeStateStatus ?? mergeStateStatus;
      corrupt = options.corrupt ?? corrupt;
      throwProcess = options.throwProcess ?? throwProcess;
    },
  };
}
async function refuses(
  f: ReturnType<typeof fixture>,
  code: string,
  gateConfig?: CheckConfig,
) {
  const result = await f.gate(gateConfig);
  expect(result.verdict).toBe("REFUSED");
  expect(result.reasons.map((reason) => reason.code)).toContain(code);
}

test("gate passes only with a verified current-head receipt and complete GitHub evidence", async () => {
  const f = fixture();
  const receipt = await f.receipt();
  const result = await f.gate();
  expect(result).toMatchObject({
    verdict: "PASS",
    head,
    receipt: receipt.id,
    checks: [{ name: "CI Gate", state: "SUCCESS" }],
    unresolvedThreads: 0,
    doorPaths: [],
    reasons: [],
  });
  expect(f.calls.filter((args) => args[1] === "view")).toHaveLength(2);
  expect(
    f.calls.some((args) =>
      args.some((arg) => arg.includes("isRequired(pullRequestNumber:$n)")),
    ),
  ).toBe(true);
  expect(f.calls.some((args) => args[1] === "checks")).toBe(false);
  expect(f.calls.find((args) => args[0] === "api")).toContain("--paginate");
  expect(f.calls.find((args) => args[0] === "api")).toContain("--slurp");
}, 1000);

test("gate refuses prototype branches with a direction to port the decision into a slice", async () => {
  const f = fixture("prototype/x");
  await f.receipt();
  const result = await f.gate();
  expect(result.verdict).toBe("REFUSED");
  expect(result.reasons).toContainEqual({
    code: "PROTOTYPE_BRANCH",
    detail:
      "prototype/x: prototype branches never merge; port the decision into a slice",
  });
}, 1000);

test("gate preserves normal branch evidence collection without another gh call", async () => {
  const f = fixture("feat/x");
  await f.receipt();
  expect((await f.gate()).verdict).toBe("PASS");
  const views = f.calls.filter(
    (args) => args[0] === "pr" && args[1] === "view",
  );
  expect(views).toHaveLength(2);
  for (const args of views)
    expect(args[args.indexOf("--json") + 1]?.split(",")).toContain(
      "headRefName",
    );
  expect(f.calls).toHaveLength(5);
}, 1000);

test("gate refuses empty or malformed head branch evidence", async () => {
  for (const headRefName of ["", " ", null, 7]) {
    const f = fixture(headRefName);
    await f.receipt();
    await refuses(f, "GITHUB_EVIDENCE_INVALID");
  }
}, 1000);

for (const [name, options, code] of [
  ["no receipt", null, "RECEIPT_MISSING"],
  ["older head", { head: "b".repeat(40) }, "RECEIPT_HEAD_MISMATCH"],
  ["failed receipt", { exit: 1 }, "RECEIPT_NOT_PASS"],
] as const)
  test(`gate refuses ${name}`, async () => {
    const f = fixture();
    if (options) await f.receipt(options);
    await refuses(f, code);
  }, 1000);

test("gate refuses tampered receipts", async () => {
  const f = fixture();
  const receipt = await f.receipt();
  const record = f.records.get(`runs/${receipt.id}`)!;
  f.records.set(record.key, {
    ...record,
    value: { ...receipt, subject: "bad" },
  });
  await refuses(f, "RECEIPT_INVALID");
}, 1000);

test("gate requires every configured receipt check", async () => {
  const f = fixture();
  await f.receipt();
  await refuses(f, "RECEIPT_CHECK_MISSING", {
    ...config,
    gate: { receiptChecks: ["structure", "typecheck"] },
  });
}, 1000);

for (const [name, checks, code] of [
  [
    "failing check",
    [{ name: "CI Gate", state: "FAILURE", bucket: "fail" }],
    "REQUIRED_CHECK_FAILED",
  ],
  [
    "pending check",
    [{ name: "CI Gate", state: "IN_PROGRESS", bucket: "pending" }],
    "REQUIRED_CHECK_FAILED",
  ],
  ["empty protection", [], "REQUIRED_CHECKS_EMPTY"],
  [
    "malformed checks",
    [{ name: "CI Gate", bucket: "pass" }],
    "GITHUB_EVIDENCE_INVALID",
  ],
] as const)
  test(`gate refuses ${name}`, async () => {
    const f = fixture();
    await f.receipt();
    f.alter({
      checks,
    });
    await refuses(f, code);
  }, 1000);

test("named required checks must be present; unrelated failure is not required", async () => {
  const f = fixture();
  await f.receipt();
  await refuses(f, "REQUIRED_CHECK_MISSING", {
    ...config,
    gate: { requiredChecks: ["absent"] },
  });
  const g = fixture();
  await g.receipt();
  g.alter({
    checks: [
      { name: "CI Gate", state: "SUCCESS", bucket: "pass" },
      { name: "optional", state: "FAILURE", bucket: "fail" },
    ],
  });
  expect(
    (await g.gate({ ...config, gate: { requiredChecks: ["CI Gate"] } }))
      .verdict,
  ).toBe("PASS");
}, 1000);

test("gate counts unresolved review threads on later pages", async () => {
  const f = fixture();
  await f.receipt();
  const page = (isResolved: boolean, hasNextPage: boolean) => ({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: isResolved ? "one" : "two", isResolved }],
            pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
          },
        },
      },
    },
  });
  f.alter({ pages: [page(true, true), page(false, false)] });
  await refuses(f, "UNRESOLVED_THREADS");
}, 1000);

test("gate refuses incomplete review pagination and GraphQL errors", async () => {
  for (const pages of [
    [],
    [{ errors: [{ message: "not authorized" }] }],
    [
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "cursor" },
              },
            },
          },
        },
      },
    ],
  ]) {
    const f = fixture();
    await f.receipt();
    f.alter({ pages });
    await refuses(f, "GITHUB_EVIDENCE_INVALID");
  }
}, 1000);

test("gate refuses configured door globs including a root match for double-star", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    changedFiles: 3,
    filePages: [
      [
        { filename: "src/main.ts", status: "modified" },
        { filename: "migrations/new.sql", status: "added" },
        { filename: "release.yml", status: "modified" },
      ],
    ],
  });
  const gateConfig = {
    ...config,
    gate: { doorPaths: ["migrations/**", "**/release.yml"] },
  };
  await refuses(f, "DOOR_PATH_TOUCHED", gateConfig);
}, 1000);

test("gate refuses renaming a protected source outside its door glob", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    filePages: [
      [
        {
          filename: "archive/critical.sql",
          previous_filename: "migrations/critical.sql",
          status: "renamed",
        },
      ],
    ],
  });
  await refuses(f, "DOOR_PATH_TOUCHED", {
    ...config,
    gate: { doorPaths: ["migrations/**"] },
  });
}, 1000);

test("gate checks renamed destinations in paginated comparisons", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    changedFiles: 2,
    filePages: [
      [{ filename: "src/main.ts", status: "modified" }],
      [
        {
          filename: "migrations/critical.sql",
          previous_filename: "archive/critical.sql",
          status: "renamed",
        },
      ],
    ],
  });
  const result = await f.gate({
    ...config,
    gate: { doorPaths: ["migrations/**"] },
  });
  expect(result.verdict).toBe("REFUSED");
  expect(result.doorPaths).toEqual(["migrations/critical.sql"]);
  const requests = f.calls.filter((args) => args[0] === "api");
  expect(requests).toHaveLength(3);
  for (const args of requests)
    expect(
      args.slice(
        args.indexOf("--hostname") + 1,
        args.indexOf("--hostname") + 2,
      ),
    ).toEqual(["github.com"]);
}, 1000);

test("gate refuses incomplete, capped or malformed file evidence", async () => {
  for (const options of [
    { filePages: [] },
    { filePages: [[{ filename: "new.sql", status: "renamed" }]] },
    {
      filePages: [
        [{ filename: "new.sql", previous_filename: " ", status: "renamed" }],
      ],
    },
    { filePages: [[{ filename: "new.sql", status: "unknown" }]] },
    { changedFiles: 2 },
    { changedFiles: 301 },
    {
      changedFiles: 2,
      filePages: [
        [
          { filename: "same.sql", status: "modified" },
          { filename: "same.sql", status: "modified" },
        ],
      ],
    },
  ]) {
    const f = fixture();
    await f.receipt();
    f.alter(options);
    await refuses(f, "GITHUB_EVIDENCE_INVALID");
  }
}, 1000);

test("gate refuses a head that moves during evidence collection", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({ laterHead: "b".repeat(40) });
  await refuses(f, "HEAD_MOVED");
}, 1000);

test("gate cannot use B's clean files when the head moves A -> B -> A", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    bounce: true,
    pinnedFilePages: [
      [{ filename: "migrations/critical.sql", status: "modified" }],
    ],
  });
  const result = await f.gate({
    ...config,
    gate: { doorPaths: ["migrations/**"] },
  });
  expect(f.headHistory).toEqual([head, "b".repeat(40), head]);
  expect(result.verdict).toBe("REFUSED");
  expect(result.doorPaths).toEqual(["migrations/critical.sql"]);
}, 1000);

test("gate cannot use B's green CI when the head moves A -> B -> A", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    bounce: true,
    pinnedChecks: [{ name: "CI Gate", state: "FAILURE", bucket: "fail" }],
  });
  await refuses(f, "REQUIRED_CHECK_FAILED");
  expect(f.headHistory).toEqual([head, "b".repeat(40), head]);
}, 1000);

test("gate refuses unbound or incomplete commit CI evidence", async () => {
  const wrongHead = ciPage([], "b".repeat(40));
  const missingPage = ciPage([]);
  missingPage.data.repository.object.statusCheckRollup.contexts.pageInfo = {
    hasNextPage: true,
    endCursor: "more",
  };
  const missingContext = ciPage([]);
  missingContext.data.repository.object.statusCheckRollup.contexts.totalCount = 1;
  for (const ciPages of [
    [],
    [wrongHead],
    [missingPage],
    [missingContext],
    [{ errors: [{ message: "denied" }] }],
  ]) {
    const f = fixture();
    await f.receipt();
    f.alter({ ciPages });
    await refuses(f, "GITHUB_EVIDENCE_INVALID");
  }
}, 1000);

test("gate reads required CI on later pages and supports commit statuses", async () => {
  const first = ciPage([]);
  first.data.repository.object.statusCheckRollup.contexts.totalCount = 1;
  first.data.repository.object.statusCheckRollup.contexts.pageInfo = {
    hasNextPage: true,
    endCursor: "more",
  };
  const last = ciPage([]);
  last.data.repository.object.statusCheckRollup.contexts.totalCount = 1;
  last.data.repository.object.statusCheckRollup.contexts.nodes = [
    {
      __typename: "StatusContext",
      context: "CI Gate",
      state: "SUCCESS",
      isRequired: true,
    },
  ];
  const f = fixture();
  await f.receipt();
  f.alter({ ciPages: [first, last] });
  expect((await f.gate()).checks).toEqual([
    { name: "CI Gate", state: "SUCCESS" },
  ]);
  expect((await f.gate()).verdict).toBe("PASS");
}, 1000);

test("gate refuses a changed base and unbound compare evidence", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({ laterBase: "d".repeat(40) });
  await refuses(f, "BASE_MOVED");
  const g = fixture();
  await g.receipt();
  g.alter({
    comparePages: [
      {
        base_commit: { sha: "d".repeat(40) },
        files: [{ filename: "src/main.ts", status: "modified" }],
      },
    ],
  });
  await refuses(g, "GITHUB_EVIDENCE_INVALID");
}, 1000);

for (const [state, mergeStateStatus] of [
  ["CLOSED", "CLEAN"],
  ["OPEN", "BLOCKED"],
  ["OPEN", "UNKNOWN"],
])
  test(`gate refuses ${state}/${mergeStateStatus}`, async () => {
    const f = fixture();
    await f.receipt();
    f.alter({ state: state!, mergeStateStatus: mergeStateStatus! });
    await refuses(f, "PR_NOT_MERGEABLE");
  }, 1000);

for (const corrupt of [
  { exitCode: 1 },
  { timedOut: true },
  { truncated: true },
  { signal: "SIGTERM" },
  { stdout: "not-json" },
])
  test(`gate fails closed on ${JSON.stringify(corrupt)}`, async () => {
    const f = fixture();
    await f.receipt();
    f.alter({ corrupt });
    expect((await f.gate()).verdict).toBe("REFUSED");
  }, 1000);

test("gate fails closed when process service throws", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({ throwProcess: true });
  expect((await f.gate()).verdict).toBe("REFUSED");
}, 1000);

test("gate chooses the newest eligible verified receipt", async () => {
  const f = fixture();
  await f.receipt();
  const latest = await f.receipt();
  await f.receipt({ exit: 1 });
  expect((await f.gate()).receipt).toBe(latest.id);
}, 1000);

test("an explicit empty required list refuses", async () => {
  const f = fixture();
  await f.receipt();
  await refuses(f, "REQUIRED_CHECKS_EMPTY", {
    ...config,
    gate: { requiredChecks: [] },
  });
}, 1000);

test("invalid file paths refuse instead of bypassing door globs", async () => {
  const f = fixture();
  await f.receipt();
  f.alter({
    filePages: [
      [{ filename: "migrations/escaped\tname.sql", status: "added" }],
    ],
  });
  await refuses(f, "GITHUB_EVIDENCE_INVALID", {
    ...config,
    gate: { doorPaths: ["migrations/**"] },
  });
}, 1000);

test("cancelled and expired gates refuse before launching gh", async () => {
  for (const aborted of [true, false]) {
    const f = fixture();
    await f.receipt();
    const controller = new AbortController();
    if (aborted) controller.abort();
    const result = await f.gate(config, {
      signal: controller.signal,
      deadline: aborted ? 1_800_000_000_000 : 1,
    });
    expect(result.verdict).toBe("REFUSED");
    expect(f.calls).toHaveLength(0);
  }
}, 1000);

test("captured gate handler selects gh credentials and returns configured receipt checks", async () => {
  const f = fixture();
  await f.receipt();
  const handlers = entry as unknown as {
    "check.gate"(
      args: HandlerArgs<{ pr: number }, CheckConfig, CatalogServices>,
    ): Promise<GateResult>;
    "check.list"(
      args: HandlerArgs<Record<string, never>, CheckConfig, CatalogServices>,
    ): { commands: readonly string[]; receiptChecks: readonly string[] };
  };
  const services: CatalogServices = {
    process: f.services.process,
    state: f.services.state,
    output: f.services.output,
    crypto: checkCrypto,
    files: {
      root: f.services.root,
      read: () => undefined,
      snapshot: f.services.snapshot,
    },
    environment: {
      select(names) {
        expect(names).toContain("GH_TOKEN");
        return f.services.environment;
      },
    },
  };
  const args = {
    services,
    config: { ...config, gate: { receiptChecks: ["structure"] } },
    signal: new AbortController().signal,
    deadline: Date.now() + 1000,
  };
  expect(handlers["check.list"]({ ...args, input: {} })).toEqual({
    commands: ["structure"],
    receiptChecks: ["structure"],
  });
  expect(
    (await handlers["check.gate"]({ ...args, input: { pr: 7 } })).verdict,
  ).toBe("PASS");
}, 1000);

test("gate envelope preserves refusals with exit 1 and passes with exit 0 through aliases", () => {
  const catalog = {
    resolve: () => ({
      block: { manifest: { id: "forge/check" } },
      operation: { declaredOp: "check.gate" },
    }),
  } as unknown as Catalog;
  for (const verdict of ["PASS", "REFUSED"] as const) {
    const result = {
      verdict,
      head,
      checks: [],
      unresolvedThreads: 0,
      doorPaths: [],
      reasons: [],
    };
    const envelope = checkResult(catalog, "verify.gate", {
      ok: true,
      op: "verify.gate",
      status: "OK",
      result,
      warnings: [],
    });
    expect(envelope.ok).toBe(verdict === "PASS");
    expect(exitCode(envelope)).toBe(verdict === "PASS" ? 0 : 1);
    expect(envelope.result).toBe(result);
  }
}, 1000);
