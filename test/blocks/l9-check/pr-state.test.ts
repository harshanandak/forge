import { expect, setDefaultTimeout, test } from "bun:test";
import entry from "../../../src/blocks/check/entry.cts";
import type { ProcessPort } from "../../../src/ports/process.ts";

setDefaultTimeout(1000);
const head = "a".repeat(40);
type Result = {
  pr: number;
  head: string;
  verdict: string;
  reasons: string[];
  news: string[];
  end: boolean;
  next: string;
};
function fixture() {
  const pr = {
    headRefOid: head,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isDraft: false,
    url: "https://github.com/org/repo/pull/7",
  };
  const checks = [
    {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      isRequired: true,
    },
  ];
  const threads: { id: string; isResolved: boolean }[] = [];
  const remarks: {
    id: string;
    author: { login: string };
    createdAt: string;
  }[] = [];
  let corrupt = false,
    move = false,
    changeMetadata = false,
    reads = 0;
  const connection = (nodes: unknown[]) => ({
    nodes,
    totalCount: nodes.length,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve: (path) => ({ kind: "resolved", path }),
    async run(_executable, args, options) {
      expect(options.env).toEqual({ PATH: "fixture" });
      let value: unknown;
      if (args[0] === "pr") {
        reads++;
        value = {
          ...pr,
          headRefOid: move && reads > 1 ? "b".repeat(40) : pr.headRefOid,
          mergeStateStatus:
            changeMetadata && reads > 1 ? "BLOCKED" : pr.mergeStateStatus,
        };
      } else if (args.some((arg) => arg.includes("statusCheckRollup"))) {
        expect(args).toContain(`head=${pr.headRefOid}`);
        value = [
          {
            data: {
              repository: {
                object: {
                  oid: pr.headRefOid,
                  statusCheckRollup: { contexts: connection(checks) },
                },
              },
            },
          },
        ];
      } else if (args.some((arg) => arg.includes("reviewThreads")))
        value = [
          {
            data: {
              viewer: { login: "self" },
              repository: {
                pullRequest: {
                  mergeQueueEntry: null,
                  reviewThreads: connection(threads),
                },
              },
            },
          },
        ];
      else
        value = [
          args[1]?.includes("/issues/")
            ? remarks.map((remark) => ({
                id: remark.id,
                user: remark.author,
                created_at: remark.createdAt,
              }))
            : [],
        ];
      if (corrupt && Array.isArray(value))
        value = [{ errors: [{ message: "denied" }] }];
      return {
        stdout: JSON.stringify(value),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 1,
      };
    },
  };
  const read = (since?: string) =>
    (
      entry as unknown as Record<
        string,
        (args: unknown) => Promise<Result | null>
      >
    )["pr.state"]!({
      input: { pr: 7, ...(since ? { since } : {}) },
      config: { timeoutMs: 1000, environment: ["PATH"] },
      signal: new AbortController().signal,
      deadline: Date.now() + 10000,
      services: {
        process,
        files: { root: "/fixture" },
        environment: { select: () => ({ PATH: "fixture" }) },
      },
    });
  return {
    pr,
    checks,
    threads,
    remarks,
    read,
    corrupt: () => {
      corrupt = true;
    },
    move: () => {
      move = true;
    },
    changeMetadata: () => {
      changeMetadata = true;
    },
  };
}
test("pr.state declares a callable shared read", () =>
  expect(Object.hasOwn(entry, "pr.state")).toBe(true));
test("ready is current head with complete green checks; unchanged cursor is quiet", async () => {
  const f = fixture(),
    first = (await f.read())!;
  expect(first).toMatchObject({ pr: 7, head, verdict: "ready", end: true });
  expect(first.news).toContain("required checks passed");
  expect(await f.read(first.next)).toBeNull();
});
test("failed checks arrive while another is pending; optional failures are news too", async () => {
  const f = fixture();
  f.checks[0]!.status = "IN_PROGRESS";
  f.checks[0]!.conclusion = "";
  const first = (await f.read())!;
  f.checks.push({
    __typename: "CheckRun",
    name: "optional",
    status: "COMPLETED",
    conclusion: "FAILURE",
    isRequired: false,
  });
  const next = (await f.read(first.next))!;
  expect(next.verdict).toBe("waiting");
  expect(next.news).toContain("check failed: optional");
  expect(await f.read(next.next)).toBeNull();
});
test("BLOCKED green and absent check evidence never become ready", async () => {
  const f = fixture();
  f.pr.mergeStateStatus = "BLOCKED";
  expect((await f.read())!.verdict).toBe("blocked");
  f.pr.mergeStateStatus = "CLEAN";
  f.checks.length = 0;
  expect((await f.read())!.verdict).toBe("waiting");
});
test("required failures and threads block while other checks are pending; resolution wakes ready", async () => {
  const f = fixture();
  f.checks.push({
    __typename: "CheckRun",
    name: "pending",
    status: "IN_PROGRESS",
    conclusion: "",
    isRequired: true,
  });
  f.checks[0]!.conclusion = "FAILURE";
  expect((await f.read())!.verdict).toBe("blocked");
  f.checks[0]!.conclusion = "SUCCESS";
  f.threads.push({ id: "thread", isResolved: false });
  expect((await f.read())!.verdict).toBe("blocked");
  f.checks.pop();
  const blocked = (await f.read())!;
  f.threads[0]!.isResolved = true;
  expect(await f.read(blocked.next)).toMatchObject({
    verdict: "ready",
    end: true,
    news: ["state changed"],
  });
});
test("conflict UNKNOWN retains memory; threads, head and state changes wake", async () => {
  const f = fixture();
  f.pr.mergeable = "CONFLICTING";
  f.pr.mergeStateStatus = "DIRTY";
  const first = (await f.read())!;
  expect(first.news).toContain("conflicting");
  f.pr.mergeable = "UNKNOWN";
  f.pr.mergeStateStatus = "UNKNOWN";
  expect(await f.read(first.next)).toBeNull();
  f.threads.push({ id: "new", isResolved: false });
  expect((await f.read(first.next))!.news).toContain("unresolved thread: new");
  f.pr.headRefOid = "b".repeat(40);
  expect((await f.read(first.next))!.news).toContain("head moved");
  f.pr.state = "MERGED";
  expect(await f.read()).toMatchObject({ verdict: "gone", end: true });
});
test("remarks ignore viewer and preserve ids sharing one timestamp", async () => {
  const f = fixture(),
    time = "2026-10-27T10:00:00Z";
  f.remarks.push({ id: "1", author: { login: "other" }, createdAt: time });
  const first = (await f.read())!;
  f.remarks.push({ id: "2", author: { login: "self" }, createdAt: time });
  expect(await f.read(first.next)).toBeNull();
  f.remarks.push({ id: "3", author: { login: "other" }, createdAt: time });
  expect((await f.read(first.next))!.news).toContain("1 new remarks: other");
});
test("incomplete reads and moving head fail without advancing a cursor", async () => {
  for (const mode of ["corrupt", "move", "changeMetadata"] as const) {
    const f = fixture();
    f[mode]();
    await expect(f.read()).rejects.toThrow();
  }
  await expect(fixture().read("invalid")).rejects.toThrow();
});

test("malformed CheckRun status cannot masquerade as a successful conclusion", async () => {
  const f = fixture();
  f.checks[0]!.status = "SUCCESS";
  await expect(f.read()).rejects.toThrow();
});
test("cursor is safe through Windows command shims and preserves Unicode", async () => {
  const f = fixture();
  f.checks[0]!.name = "日本語😀";
  f.checks[0]!.conclusion = "FAILURE";
  const first = (await f.read())!;
  expect(first.next).toMatch(/^[0-9a-f]+$/);
  expect(await f.read(first.next)).toBeNull();
});
