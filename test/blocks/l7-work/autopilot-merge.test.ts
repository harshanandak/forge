import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import {
  createCheck,
  type CheckConfig,
  type CheckServices,
} from "../../../src/blocks/check/index.ts";
import { createRunnerOutput } from "../../../src/adapters/runner-output/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import { captured } from "../l9-check/fakes.ts";

setDefaultTimeout(30_000);
const head = "a".repeat(40),
  older = "b".repeat(40),
  moved = "c".repeat(40),
  base = "d".repeat(40);
const codex = "chatgpt-codex-connector[bot]";
const url = "https://github.com/example/repo/pull/7";

const complete = {
  stderr: "",
  signal: null,
  timedOut: false,
  truncated: false,
  durationMs: 1,
};
const codexLine = (sha: string, status = "completed") =>
  `<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: sha, status },
    security_review: { commit_sha: null, status: null },
  })} -->`;

/* ---------- check.gate: base ancestor and the head reviewer ---------- */

const gateConfig: CheckConfig = {
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
  gate: { headReviewers: [codex] },
};

function gateFixture(options: { reviewed: string; compare?: string }) {
  const records = new Map<string, StateRecord>();
  const calls: string[][] = [];
  const services: CheckServices = {
    root: "/project",
    environment: { GH_TOKEN: "test-placeholder" },
    clock: { now: () => 1_700_000_000_000 },
    output: createRunnerOutput(),
    snapshot: () =>
      Promise.resolve({ head, filesDigest: "sha256:" + "b".repeat(64) }),
    state: {
      get: (key) => records.get(key),
      list: (prefix = "") =>
        [...records.values()].filter((row) => row.key.startsWith(prefix)),
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
      run(executable, args, spawn) {
        if (executable.path !== "gh")
          return Promise.resolve(
            captured({ ...complete, exitCode: 0, stdout: "checked" }, spawn),
          );
        calls.push([...args]);
        let stdout: string;
        if (args[0] === "pr" && args[1] === "view")
          stdout = JSON.stringify({
            headRefOid: head,
            headRefName: "feat/x",
            baseRefOid: base,
            state: "OPEN",
            mergeStateStatus: "CLEAN",
            url,
            changedFiles: 1,
          });
        else if (args.some((arg) => arg.includes("statusCheckRollup")))
          stdout = JSON.stringify([
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
          ]);
        else if (args[1]?.includes("/compare/"))
          stdout = JSON.stringify([
            {
              status: options.compare ?? "ahead",
              base_commit: { sha: base },
              files: [{ filename: "src/main.ts", status: "modified" }],
            },
          ]);
        else if (args[1]?.includes("/issues/7/comments"))
          // The real call filters with --jq; the fake returns what that filter prints.
          stdout = options.reviewed ? codexLine(options.reviewed) : "";
        else
          stdout = JSON.stringify([
            {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [{ id: "thread", isResolved: true }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            },
          ]);
        return Promise.resolve({ ...complete, exitCode: 0, stdout });
      },
    },
  };
  const check = createCheck(services);
  return {
    calls,
    async gate() {
      await check.run({}, gateConfig);
      return await check.gate({ pr: 7 }, gateConfig);
    },
  };
}

test("a Codex review on an older head is refused with the reviewer named", async () => {
  const f = gateFixture({ reviewed: older });
  const result = await f.gate();
  expect(result.verdict).toBe("REFUSED");
  expect(result.reasons).toContainEqual({
    code: "HEAD_REVIEW_MISSING",
    detail: `head review missing: ${codex}`,
  });
  const call = f.calls.find((args) => args[1]?.includes("/issues/7/comments"))!;
  expect(call.join(" ")).toContain(codex);
  expect(call).toContain("--paginate");
});

test("the same fixture with the review on the head passes", async () => {
  const f = gateFixture({ reviewed: head });
  const result = await f.gate();
  expect(result.reasons).toEqual([]);
  expect(result.verdict).toBe("PASS");
});

test("no review comment, or a review that is not completed, is refused", async () => {
  const none = await gateFixture({ reviewed: "" }).gate();
  expect(none.reasons.map((row) => row.code)).toContain("HEAD_REVIEW_MISSING");
});

test("a branch that does not contain current main is refused", async () => {
  for (const compare of ["diverged", "behind"]) {
    const result = await gateFixture({ reviewed: head, compare }).gate();
    expect(result.verdict).toBe("REFUSED");
    expect(result.reasons.map((row) => row.code)).toContain("BASE_NOT_UPDATED");
  }
});

/* ---------- lane.next: the merge step ---------- */

type Action = {
  lane: string;
  step: string;
  n: number;
  kind: string;
  why: string;
  expect: string;
  argv?: string[];
  ask?: string;
  raw?: string;
};
type Handler<Output> = (call: {
  input: Record<string, unknown>;
  services: unknown;
  config?: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Output | Promise<Output>;
type Operations = {
  "lane.next": Handler<Action>;
  "lane.record": Handler<{ step: string; n: number; recorded: boolean }>;
};
type Row = {
  key: string;
  revision: number;
  updatedAt: string;
  value: Record<string, unknown>;
};

const entry = resolve(
  import.meta.dirname,
  "../../../src/blocks/work/entry.cts",
);
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
let operations: Operations;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  delete require.cache[entry];
  operations = require(entry) as Operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

function fixture() {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const records = new Map<string, Row>();
  const put = (
    key: string,
    value: Record<string, unknown>,
    options: { expectRevision: number },
  ) => {
    if ((records.get(key)?.revision ?? 0) !== options.expectRevision)
      throw new Error("REVISION_CONFLICT");
    const row = {
      key,
      value,
      revision: options.expectRevision + 1,
      updatedAt: new Date(now).toISOString(),
    };
    records.set(key, row);
    return row;
  };
  put(
    "issue:work-1",
    {
      id: "work-1",
      title: "work-1",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(now).toISOString(),
    },
    { expectRevision: 0 },
  );
  const state = {
    count: (prefix: string) =>
      [...records.keys()].filter((key) => key.startsWith(prefix)).length,
    maxNumber: () => 0,
    now: () => now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((row) => row.key.startsWith(prefix)),
    put,
    lease: () => undefined,
    acquire: () => undefined,
  };
  const world = {
    head,
    laterHead: undefined as string | undefined,
    state: "OPEN",
    mergeState: "CLEAN",
    labels: [] as string[],
    paths: ["src/main.ts"],
    compare: "ahead",
    threads: [true],
    checkState: "SUCCESS",
    reviewed: head,
    garble: false,
    calls: [] as string[][],
  };
  const reply = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "view") {
      const fields = args[4]!;
      if (fields.includes("mergeCommit"))
        return JSON.stringify({
          state: world.state,
          headRefName: "feat/x",
          headRefOid: world.head,
          mergeCommit: null,
          url,
        });
      if (fields === "headRefOid")
        return JSON.stringify({ headRefOid: world.laterHead ?? world.head });
      return JSON.stringify({
        headRefOid: world.head,
        baseRefOid: base,
        state: world.state,
        mergeStateStatus: world.mergeState,
        labels: world.labels.map((name) => ({ name })),
        files: world.paths.map((path) => ({ path })),
        changedFiles: world.paths.length,
      });
    }
    if (args[1] === "graphql")
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "CI Gate",
                      status: "COMPLETED",
                      conclusion: world.checkState,
                      isRequired: true,
                    },
                    {
                      __typename: "CheckRun",
                      name: "optional",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      isRequired: false,
                    },
                  ],
                },
              },
            },
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: world.threads.map((isResolved) => ({ isResolved })),
              },
            },
          },
        },
      });
    if (args[1]?.includes("/compare/")) return `${world.compare}\n`;
    if (args[1]?.includes("/issues/7/comments"))
      return world.reviewed ? codexLine(world.reviewed) : "";
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };
  const services = {
    state,
    files: {
      root: "/project",
      read: () => undefined,
    },
    environment: { select: () => ({}) },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: (_executable: unknown, args: string[]) => {
        world.calls.push(args);
        return Promise.resolve({
          stdout: world.garble ? "not json" : reply(args),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        });
      },
    },
  };
  const bound = (input: Record<string, unknown>) => ({
    input,
    services,
    config: {},
    signal: new AbortController().signal,
    deadline: Number.MAX_SAFE_INTEGER,
  });
  return {
    world,
    records,
    next: async (input: Record<string, unknown> = {}) =>
      await operations["lane.next"](bound({ id: "work-1", pr: 7, ...input })),
    verdict: async (sha: string, verdict: string, reviewer = "sol") =>
      await operations["lane.record"](
        bound({ id: "work-1", mergeGate: { head: sha, verdict, reviewer } }),
      ),
  };
}

const returned: Action[] = [];
async function seen(f: ReturnType<typeof fixture>, input = {}) {
  const action = await f.next(input);
  returned.push(action);
  return action;
}

test("lane.next returns the merge action only on a passing gate and a MERGE verdict for the head", async () => {
  const f = fixture();
  expect(await f.verdict(head, "MERGE")).toMatchObject({
    step: "merge",
    recorded: true,
  });
  const action = await seen(f);
  expect(action).toMatchObject({
    kind: "forge",
    step: "merge",
    argv: ["forge", "pr", "merge", "7", "--head", head],
  });
  expect(action.why).toContain(`--match-head-commit ${head}`);
  expect(action.why).toContain("squash");
  // Forge itself never merges; it only reads.
  expect(f.world.calls.some((args) => args.includes("merge"))).toBe(false);
});

test("a FIX verdict, a MERGE verdict for an older head, or none never returns the merge action", async () => {
  const fix = fixture();
  await fix.verdict(head, "FIX");
  expect(await seen(fix)).toMatchObject({ kind: "pause" });
  const stale = fixture();
  await stale.verdict(older, "MERGE");
  const action = await seen(stale);
  expect(action.kind).toBe("pause");
  expect(action.why).toContain(older);
  const none = fixture();
  expect(await seen(none)).toMatchObject({ kind: "wait" });
});

test("a refused gate waits with the plain reason, even with a MERGE verdict", async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [`head review missing: ${codex}`, (f) => (f.world.reviewed = older)],
    ["unresolved review thread", (f) => (f.world.threads = [true, false])],
    [
      "required check CI Gate is FAILURE",
      (f) => (f.world.checkState = "FAILURE"),
    ],
    ["does not contain current main", (f) => (f.world.compare = "diverged")],
    ["BLOCKED", (f) => (f.world.mergeState = "BLOCKED")],
  ];
  for (const [reason, change] of cases) {
    const f = fixture();
    await f.verdict(head, "MERGE");
    change(f);
    const action = await seen(f);
    expect(action.kind).toBe("wait");
    expect(action.why).toContain(reason);
  }
});

test("a head that moves between the gate and the merge pauses with HEAD_MOVED", async () => {
  const f = fixture();
  await f.verdict(head, "MERGE");
  f.world.laterHead = moved;
  const action = await seen(f);
  expect(action.kind).toBe("pause");
  expect(action.why).toContain("HEAD_MOVED");
  const pinned = fixture();
  await pinned.verdict(head, "MERGE");
  const other = await seen(pinned, { head: moved });
  expect(other.kind).toBe("pause");
  expect(other.why).toContain("HEAD_MOVED");
});

test("a security-labeled or security-path PR gets a gated ask, never a merge action", async () => {
  const labeled = fixture();
  await labeled.verdict(head, "MERGE");
  labeled.world.labels = ["Security"];
  const byLabel = await seen(labeled);
  expect(byLabel.kind).toBe("pause");
  expect(byLabel.ask).toContain("owner");
  expect(byLabel.argv).toBeUndefined();
  for (const path of [
    ".github/workflows/ci.yml",
    "package.json",
    "src/core/trust/store.ts",
    "src/assembly/providers.ts",
    "templates/delivery/skills/x.md",
  ]) {
    const f = fixture();
    await f.verdict(head, "MERGE");
    f.world.paths = ["src/main.ts", path];
    const action = await seen(f);
    expect(action.kind).toBe("pause");
    expect(action.argv).toBeUndefined();
  }
});

test("unreadable GitHub data pauses and quotes it", async () => {
  const f = fixture();
  await f.verdict(head, "MERGE");
  f.world.garble = true;
  const action = await seen(f);
  expect(action).toMatchObject({ kind: "pause", raw: "not json" });
});

test("a malformed verdict record is refused", async () => {
  const f = fixture();
  await expect(f.verdict("short", "MERGE")).rejects.toThrow(/INPUT_INVALID/);
  await expect(f.verdict(head, "SHIP")).rejects.toThrow(/INPUT_INVALID/);
});

test("no action Forge returns carries a forbidden merge, push or hook flag", () => {
  expect(returned.length).toBeGreaterThan(5);
  const forbidden = [
    "--admin",
    "--auto",
    "--force",
    "--force-with-lease",
    "--no-verify",
    "--no-gpg-sign",
    "HOOK=0",
    "reset --hard",
  ];
  for (const action of returned) {
    const argv = action.argv ?? [];
    const line = `${argv.join(" ")} ${action.why} ${action.expect}`;
    for (const flag of forbidden) expect(line).not.toContain(flag);
    expect(argv[0] === "gh" && argv.includes("merge")).toBe(false);
    if (argv.includes("merge")) {
      // Every merge action pins the full head and says it is a squash with match-head-commit.
      const pinned = argv[argv.indexOf("--head") + 1] ?? "";
      expect(pinned).toMatch(/^[a-f0-9]{40}$/);
      expect(action.why).toContain(`--match-head-commit ${pinned}`);
    }
  }
});
