import { expect, setDefaultTimeout, test } from "bun:test";
import entry from "../../../src/blocks/check/entry.cts";
import type { ProcessPort } from "../../../src/ports/process.ts";
import { checkCrypto } from "../../../src/blocks/check/support.ts";
import { planSpawn } from "../../../src/adapters/process/plan.ts";

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
  reviewRounds: number;
  nextSteps?: string[];
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
  const commits: {
    sha: string;
    time: string;
    parents: string[];
    message: string;
  }[] = [];
  const reviews: { commit: string; time: string }[] = [];
  const inline: {
    id: string;
    author: string;
    time: string;
    commit?: string;
  }[] = [];
  const summaries: { commits: string[]; time: string }[] = [];
  const baseParents = new Set<string>();
  let corrupt = false,
    partial = false,
    reads = 0;
  let finalChange: Partial<typeof pr> = {};
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve: (path) => ({ kind: "resolved", path }),
    run(_executable, args, options) {
      expect(options.env).toEqual({ PATH: "fixture" });
      expect(args.includes("--slurp") && args.includes("--jq")).toBe(false);
      planSpawn(
        "C:/fixture/gh.cmd",
        args,
        { SystemRoot: "C:/Windows" },
        "win32",
      );
      let value: unknown;
      if (args[0] === "pr" && args[1] === "view") {
        reads++;
        if (args.includes("headRefOid,state")) {
          Object.assign(pr, finalChange);
          value = { headRefOid: pr.headRefOid, state: pr.state };
        } else {
          value = {
            head: pr.headRefOid,
            base: "b".repeat(40),
            baseName: "main",
            state: pr.state,
            mergeable: pr.mergeable,
            merge: pr.mergeStateStatus,
            review: pr.reviewDecision,
            draft: pr.isDraft,
            url: pr.url,
            remarks: remarks.map((remark) => ({
              id: remark.id,
              author: remark.author.login,
              time: remark.createdAt,
            })),
          };
          expect(args).toContain("--jq");
        }
      } else if (args[1] === "checks") {
        value = checks
          .filter((check) => !args.includes("--required") || check.isRequired)
          .map((check) => ({
            name: check.name,
            bucket:
              check.status === "IN_PROGRESS"
                ? "pending"
                : check.conclusion === "FAILURE"
                  ? "fail"
                  : "pass",
          }));
      } else if (args.some((arg) => arg.includes("commits(first:100")))
        value = [{ commits, more: false }];
      else if (args[1]?.includes("/compare/"))
        value = {
          status: baseParents.has(
            args[1].split("/compare/")[1]!.split("...")[0]!,
          )
            ? "ahead"
            : "diverged",
        };
      else if (args[1]?.includes("/reviews?")) value = reviews;
      else if (args[1]?.includes("/issues/")) value = summaries;
      else if (args[1]?.includes("/comments?")) value = inline;
      else if (args.some((arg) => arg.includes("reviewThreads")))
        value = [
          {
            viewer: "self",
            queued: false,
            ids: threads
              .filter((thread) => !thread.isResolved)
              .map((thread) => thread.id),
            more: false,
          },
        ];
      else value = [];
      if (corrupt && Array.isArray(value))
        value = [{ errors: [{ message: "denied" }] }];
      const empty =
        args[1] === "checks" && Array.isArray(value) && !value.length;
      const stream = {
        head: "",
        tail: "",
        encoding: "base64" as const,
        totalBytes: 0,
        digest: "",
        complete: false,
      };
      return Promise.resolve({
        stdout: empty
          ? ""
          : args[0] === "api" && Array.isArray(value)
            ? value.map((item) => JSON.stringify(item)).join("\n")
            : JSON.stringify(value),
        stderr: empty
          ? `no ${args.includes("--required") ? "required " : ""}checks reported on the 'fixture' branch\n`
          : "",
        exitCode: empty ? 1 : 0,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 1,
        ...(partial
          ? { outputEvidence: { stdout: stream, stderr: stream } }
          : {}),
      });
    },
  };
  const read = (since?: string, cap = 2) =>
    (
      entry as unknown as Record<
        string,
        (args: unknown) => Promise<Result | null>
      >
    )["pr.state"]!({
      input: { pr: 7, ...(since ? { since } : {}) },
      config: {
        timeoutMs: 1000,
        environment: ["PATH"],
        review: { rounds: cap },
      },
      signal: new AbortController().signal,
      deadline: Date.now() + 10000,
      services: {
        process,
        files: { root: "/fixture" },
        environment: { select: () => ({ PATH: "fixture" }) },
        crypto: checkCrypto,
      },
    });
  return {
    pr,
    checks,
    threads,
    remarks,
    commits,
    reviews,
    inline,
    summaries,
    baseParents,
    read,
    corrupt: () => {
      corrupt = true;
    },
    views: () => reads,
    changeDuringRead: (change: Partial<typeof pr>) => {
      finalChange = change;
    },
    partial: () => {
      partial = true;
    },
  };
}
test("pr.state declares a callable shared read", () =>
  expect(Object.hasOwn(entry, "pr.state")).toBe(true));

function reviewHistory() {
  const f = fixture();
  for (let index = 0; index < 4; index++) {
    const sha = String(index + 1).repeat(40);
    f.commits.push({
      sha,
      time: `2026-10-27T${String(index * 2 + 10).padStart(2, "0")}:00:00Z`,
      parents: index ? [String(index).repeat(40)] : [],
      message: "fix: feedback",
    });
    if (index < 3)
      f.reviews.push({
        commit: sha,
        time: `2026-10-27T${index * 2 + 11}:00:00Z`,
      });
  }
  f.pr.headRefOid = f.commits[3]!.sha;
  return f;
}
test("completed review rounds add a redesign step only beyond the configured cap", async () => {
  const f = reviewHistory();
  const value = (await f.read())!;
  expect(value.reviewRounds).toBe(3);
  expect(value.nextSteps).toEqual([
    "Round 3 exceeds the review cap (2). Write a three-line threat model, then choose ship, simplify or park; do not patch the same design again.",
  ]);
  expect(value.verdict).toBe("ready");
  expect(value.next).toMatch(/^[A-Za-z0-9_-]+$/);
  expect((await f.read(undefined, 3))!.nextSteps).toBeUndefined();
  const changed = (await f.read(value.next, 3))!;
  expect(changed.reviewRounds).toBe(3);
  expect(changed.nextSteps).toBeUndefined();
  expect(await f.read(changed.next, 3)).toBeNull();
});
test("a reviewed current head, duplicate evidence and pre-review commits do not complete a round", async () => {
  const f = reviewHistory();
  f.reviews.splice(0, 3, {
    commit: f.pr.headRefOid,
    time: "2026-10-27T17:00:00Z",
  });
  expect((await f.read())!.reviewRounds).toBe(0);
  f.reviews.push({ commit: f.commits[0]!.sha, time: "2026-10-27T17:00:00Z" });
  expect((await f.read())!.reviewRounds).toBe(0);
  f.reviews.push({ commit: f.commits[0]!.sha, time: "2026-10-27T11:00:00Z" });
  f.inline.push({
    id: "inline",
    author: "other",
    commit: f.commits[0]!.sha,
    time: "2026-10-27T11:00:00Z",
  });
  expect((await f.read())!.reviewRounds).toBe(1);
  f.reviews.push({ ...f.reviews[2]! });
  expect((await f.read())!.reviewRounds).toBe(1);
  f.reviews.splice(0, f.reviews.length, {
    commit: f.commits[0]!.sha,
    time: "2026-10-27T13:00:00Z",
  });
  f.inline.length = 0;
  expect((await f.read())!.reviewRounds).toBe(0);
});
test("base-only merge after review is excluded by second-parent ancestry and update-branch message", async () => {
  for (const update of [false, true]) {
    const f = reviewHistory();
    f.reviews.length = 1;
    f.commits.splice(1, 3, {
      sha: f.pr.headRefOid,
      time: "2026-10-27T16:00:00Z",
      parents: [f.commits[0]!.sha, "b".repeat(40)],
      message: update ? "Merge branch 'main' into feature" : "Merge upstream",
    });
    if (!update) f.baseParents.add("b".repeat(40));
    expect((await f.read())!.reviewRounds).toBe(0);
  }
});
test("inline review findings and bot summaries resolve distinct reviewed heads", async () => {
  const f = reviewHistory();
  f.reviews.length = 0;
  f.inline.push({
    id: "inline",
    author: "other",
    commit: f.commits[0]!.sha,
    time: "2026-10-27T11:00:00Z",
  });
  f.summaries.push({
    commits: [f.commits[1]!.sha.slice(0, 8)],
    time: "2026-10-27T13:00:00Z",
  });
  expect((await f.read())!.reviewRounds).toBe(2);
});

test("R1 optional failure blocks despite required checks passing", async () => {
  const f = fixture();
  f.checks.push({
    __typename: "CheckRun",
    name: "optional",
    status: "COMPLETED",
    conclusion: "FAILURE",
    isRequired: false,
  });
  const value = (await f.read())!;
  expect(value.verdict).toBe("blocked");
  expect(value.reasons.some((reason) => reason.includes("optional"))).toBe(
    true,
  );
});
test("R1 passing announcement stays latched on a head through a failed rerun", async () => {
  const f = fixture(),
    first = (await f.read())!;
  f.checks[0]!.conclusion = "FAILURE";
  const failed = (await f.read(first.next))!;
  f.checks[0]!.conclusion = "SUCCESS";
  const restored = (await f.read(failed.next))!;
  expect(restored.news).not.toContain("required checks passed");
  f.pr.headRefOid = "b".repeat(40);
  expect((await f.read(restored.next))!.news).toContain(
    "required checks passed",
  );
});
test("UNKNOWN mergeability forgets a previous head's conflict", async () => {
  const f = fixture();
  f.pr.mergeable = "CONFLICTING";
  f.pr.mergeStateStatus = "DIRTY";
  const first = (await f.read())!;
  f.pr.headRefOid = "b".repeat(40);
  f.pr.mergeable = f.pr.mergeStateStatus = "UNKNOWN";
  expect((await f.read(first.next))!.reasons).not.toContain("conflicting");
});
test("R1 missing expected checks do not announce passing; empty CI explains waiting", async () => {
  const f = fixture();
  f.pr.mergeStateStatus = "BLOCKED";
  expect((await f.read())!.news).not.toContain("required checks passed");
  f.pr.mergeStateStatus = "CLEAN";
  f.checks.length = 0;
  expect(await f.read()).toMatchObject({
    verdict: "waiting",
    reasons: ["no checks reported"],
  });
});
test("ready is current head with complete green checks; unchanged cursor is quiet", async () => {
  const f = fixture(),
    first = (await f.read())!;
  expect(first).toMatchObject({ pr: 7, head, verdict: "ready", end: true });
  expect(first.news).toContain("required checks passed");
  expect(
    (
      JSON.parse(Buffer.from(first.next, "base64url").toString()) as {
        v: string;
      }
    ).v,
  ).toBe("f0afa7173801d37cdaa18156baa07af87f01b9b361103c65ca6074ee82e5fb61");
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
  expect(next.verdict).toBe("blocked");
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
    news: ["unresolved threads changed"],
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
  expect((await f.read(first.next))!.news).toContain(
    "1 new unresolved threads",
  );
  f.pr.headRefOid = "b".repeat(40);
  const moved = (await f.read(first.next))!;
  expect(moved.news).toContain("head moved");
  expect(moved.reasons).not.toContain("conflicting");
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
test("recheck head and state and reject incomplete reads without advancing a cursor", async () => {
  const first = fixture();
  await first.read();
  expect(first.views()).toBe(2);
  const f = fixture();
  f.corrupt();
  await expect(f.read()).rejects.toThrow();
  await expect(fixture().read("invalid")).rejects.toThrow();
});

test("cursor is safe through Windows command shims and preserves Unicode", async () => {
  const f = fixture();
  f.checks[0]!.name = "日本語😀";
  f.checks[0]!.conclusion = "FAILURE";
  const first = (await f.read())!;
  expect(first.next).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(
    (
      JSON.parse(Buffer.from(first.next, "base64url").toString()) as {
        f: string[];
      }
    ).f,
  ).toEqual(["日本語😀"]);
  expect(await f.read(first.next)).toBeNull();
});
test("one thousand threads use one short set hash and count", async () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++)
    f.threads.push({
      id: `${index}-${"long-thread-id".repeat(20)}`,
      isResolved: false,
    });
  const first = (await f.read())!;
  expect(first.next.length).toBeLessThan(1000);
  expect(await f.read(first.next)).toBeNull();
  f.threads.push({ id: "new-thread", isResolved: false });
  expect((await f.read(first.next))!.news).toEqual([
    "1 new unresolved threads",
  ]);
  f.threads[0]!.id = "replacement";
  expect((await f.read(first.next))!.news).toEqual([
    "1 new unresolved threads",
  ]);
  const increased = (await f.read(first.next))!;
  f.threads[1]!.id = "another-replacement";
  expect((await f.read(increased.next))!.news).toEqual([
    "unresolved threads changed",
  ]);
});

for (const change of [{ headRefOid: "b".repeat(40) }, { state: "CLOSED" }])
  test(`racing ${Object.keys(change)[0]} never ends or latches stale evidence`, async () => {
    const f = fixture();
    f.changeDuringRead(change);
    const raced = (await f.read())!;
    expect(raced).toMatchObject({
      verdict: "waiting",
      end: false,
      news: [change.state ? "state changed" : "head moved"],
    });
    const stable = (await f.read(raced.next))!;
    expect(stable.news).toContain("required checks passed");
    expect(stable.verdict).toBe(change.state ? "gone" : "ready");
    expect(await f.read(stable.next)).toBeNull();
  });
test("no required checks reported falls back to the all-check green set", async () => {
  const f = fixture();
  f.checks[0]!.isRequired = false;
  expect(await f.read()).toMatchObject({ verdict: "ready" });
});
test("metadata projections use compatible paginated GitHub CLI flags", async () => {
  expect(await fixture().read()).toMatchObject({ verdict: "ready" });
});
test("incomplete process evidence is never accepted as a complete read", async () => {
  const f = fixture();
  f.partial();
  await expect(f.read()).rejects.toThrow();
});

test("racing reads preserve verified news but never advance same-time remark IDs", async () => {
  const f = fixture();
  const time = "2026-10-27T10:00:00Z";
  f.remarks.push({ id: "1", author: { login: "other" }, createdAt: time });
  const first = (await f.read())!;
  f.remarks.push({ id: "2", author: { login: "other" }, createdAt: time });
  f.changeDuringRead({ state: "CLOSED" });
  const raced = (await f.read(first.next))!;
  expect(raced.news).toEqual(["state changed"]);
  const stable = (await f.read(raced.next))!;
  expect(stable.news).toEqual(["1 new remarks: other"]);
  expect(stable.verdict).toBe("gone");
  expect(await f.read(stable.next)).toBeNull();
});
