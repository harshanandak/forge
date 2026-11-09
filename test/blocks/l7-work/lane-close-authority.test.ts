import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { BoundContext } from "../../../src/generated/types.ts";

setDefaultTimeout(30_000);
type Handler = (call: {
  input: Record<string, unknown>;
  services: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Promise<unknown>;
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string) => {
    throw new Error(code);
  };
  operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

const id = "work-1",
  head = "a".repeat(40),
  merge = "b".repeat(40);
const url = "https://github.com/example/repo/pull/1";
const namespace = "forge/work";
async function fixture(seedLink = true) {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  let now = Date.now();
  const owner = new StateOwner(opened.handle.value, { now: () => now });
  owner.initialize();
  const holder = {
    actor: { kind: "agent" as const, id: "worker" },
    session: { id: "lane", device: "device" },
  };
  const context: BoundContext = {
    variant: "leased",
    ...holder,
    project: { id: "project" },
    leaseMode: "held",
    leaseGeneration: 1,
  };
  owner.put(
    namespace,
    `issue:${id}`,
    {
      id,
      title: "Land",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(now).toISOString(),
    },
    holder.actor,
    { expectRevision: 0 },
  );
  if (seedLink)
    owner.put(
      namespace,
      `link:${id}:1`,
      { id, relation: "delivers", url },
      holder.actor,
      { expectRevision: 0 },
    );
  owner.acquire(namespace, `issue:${id}`, holder, 60000, "claim");
  const state = createStateClient({
    owner,
    namespace,
    context,
    write: true,
    requestId: "close",
  });
  const lane = {
    issue: id,
    branch: "feature",
    worktree: "/lane",
    brief: "",
    base: head,
  };
  const files = new Map([["forge-lanes.json", JSON.stringify([lane])]]);
  const flags = {
    present: true,
    branch: true,
    failComment: false,
    failCleanup: false,
    run: 0,
    checkout: "",
    prBranch: "",
    localHead: "",
    ancestor: true,
    prBase: "main",
    mergeBase: "match",
    shallow: false,
    calls: [] as string[][],
    privateRefs: new Set<string>(),
    afterFetch: undefined as (() => void) | undefined,
  };
  const services = {
    state: {
      ...state,
      now: () => now,
      put: (...args: Parameters<typeof state.put>) => {
        if (args[0].startsWith("comment:") && flags.failComment) {
          flags.failComment = false;
          throw new Error("injected landing comment failure");
        }
        return state.put(...args);
      },
    },
    receipts: {
      get: (receipt: string) =>
        receipt === "proof"
          ? { id: receipt, status: "PASS", subject: merge }
          : undefined,
    },
    crypto: {
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++flags.run).padStart(12, "0")}`,
    },
    files: {
      root: "/project",
      read: (path: string) => files.get(path),
      write: (path: string, text: string) => {
        files.set(path, text);
      },
      remove: (path: string) => {
        files.delete(path);
      },
      inspect() {},
      list: () => [...files.keys()],
      lock: () => ({ release() {} }),
    },
    environment: { select: () => ({}) },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: (
        _executable: unknown,
        args: string[],
        options?: { signal?: AbortSignal },
      ) => {
        let stdout = "",
          exitCode = 0;
        // A cancelled invocation cannot start another call that carries its signal.
        if (options?.signal?.aborted)
          return Promise.reject(new Error(`SERVICE_EXPIRED: ${args[0]}`));
        flags.calls.push(args);
        if (
          args[0] === "fetch" &&
          args[2]?.includes(":refs/forge/lane-close/")
        ) {
          flags.privateRefs.add(args[2].split(":")[1]!);
          flags.afterFetch?.();
        }
        if (args[0] === "pr")
          stdout = JSON.stringify({
            state: "MERGED",
            baseRefName: flags.prBase,
            headRefName: flags.prBranch || lane.branch,
            headRefOid: head,
            mergeCommit: { oid: merge },
            url,
          });
        else if (args[0] === "worktree" && args[1] === "list")
          stdout = "worktree /project\0branch refs/heads/main\0\0";
        else if (
          args[0] === "for-each-ref" &&
          args[2]?.startsWith("refs/forge/")
        )
          stdout = [...flags.privateRefs].join("\n");
        else if (args[0] === "for-each-ref")
          stdout = flags.branch ? args[2]! : "";
        else if (
          args[0] === "rev-parse" &&
          args[1] === "--is-shallow-repository"
        )
          stdout = String(flags.shallow);
        else if (args[0] === "rev-parse") stdout = flags.localHead || head;
        else if (args.includes("refs/remotes/origin/HEAD"))
          stdout = "refs/remotes/origin/main";
        else if (args.includes("symbolic-ref"))
          stdout = flags.checkout || lane.branch;
        else if (args[0] === "merge-base" && args[1] !== "--is-ancestor") {
          if (flags.mergeBase === "match") stdout = args[1]!;
          else if (flags.mergeBase === "other") stdout = "c".repeat(40);
          else if (flags.mergeBase === "none") exitCode = 1;
        } else if (args[0] === "merge-base") exitCode = flags.ancestor ? 0 : 1;
        else if (args[0] === "-C") {
          stdout = "true";
          if (!flags.present) exitCode = 1;
        } else if (args[0] === "worktree") {
          if (flags.failCleanup) exitCode = 1;
          else flags.present = false;
        } else if (args[0] === "update-ref") {
          if (args[2]?.startsWith("refs/forge/lane-close/"))
            flags.privateRefs.delete(args[2]);
          else flags.branch = false;
        }
        return Promise.resolve({
          stdout,
          exitCode,
          stderr: "",
          timedOut: false,
          truncated: false,
        });
      },
    },
  };
  const close = (
    extra = {},
    call: { signal?: AbortSignal; deadline?: number } = {},
  ) =>
    operations["lane.close"]!({
      input: { id, pr: 1, receipt: "proof", ...extra },
      services,
      signal: call.signal ?? new AbortController().signal,
      deadline: call.deadline ?? Number.MAX_SAFE_INTEGER,
    });
  const comments = () => owner.list(namespace, `comment:${id}:`);
  return {
    owner,
    state,
    holder,
    context,
    lane,
    files,
    flags,
    close,
    comments,
    expire: () => {
      now = Date.parse(state.lease(`issue:${id}`)!.expiresAt) + 1;
    },
    now: () => now,
    dispose: () => opened.handle.close(),
  };
}

test("a forged close journal without a fenced landing record cannot authorize cleanup", async () => {
  const f = await fixture();
  try {
    f.owner.put(
      namespace,
      `issue:${id}`,
      {
        ...(f.owner.get(namespace, `issue:${id}`)!.value as object),
        status: "closed",
        receipt: "proof",
      },
      f.holder.actor,
      { expectRevision: 1 },
    );
    f.files.set(
      `forge-lane-close-${id}.json`,
      JSON.stringify({
        pr: 1,
        receipt: "proof",
        keepOpen: false,
        dropped: "",
        branch: f.lane.branch,
        worktree: f.lane.worktree,
        head,
        mergeCommit: merge,
        claimed: true,
      }),
    );
    f.state.release(`issue:${id}`);
    f.owner.put(
      namespace,
      `comment:${id}:1`,
      {
        id,
        body: `PR #1 landed: ${url}\nMerge commit: ${merge}\nReceipt: proof`,
      },
      f.holder.actor,
      { expectRevision: 0 },
    );
    await expect(f.close()).rejects.toThrow();
    expect(f.flags.present).toBe(true);
    expect(f.flags.branch).toBe(true);
    expect(f.comments()).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

for (const end of ["release", "expire"] as const) {
  test(`a missing landing comment recovers after claim ${end} exactly once`, async () => {
    const f = await fixture();
    try {
      f.flags.failComment = true;
      await expect(f.close()).rejects.toThrow(
        "injected landing comment failure",
      );
      expect(f.owner.get(namespace, `issue:${id}`)!.value).toMatchObject({
        status: "closed",
      });
      expect(f.comments()).toHaveLength(0);
      if (end === "release") f.state.release(`issue:${id}`);
      else {
        f.expire();
        expect(
          Date.parse(f.state.lease(`issue:${id}`)!.expiresAt),
        ).toBeLessThan(f.now());
      }
      f.flags.failCleanup = true;
      await expect(f.close()).rejects.toThrow();
      expect(f.comments()).toHaveLength(1);
      f.flags.failCleanup = false;
      await f.close();
      expect(f.comments()).toHaveLength(1);
      expect((f.comments()[0]!.value as { body: string }).body).toContain(
        "PR #1 landed:",
      );
      expect(f.flags.present).toBe(false);
      expect(f.flags.branch).toBe(false);
    } finally {
      await f.dispose();
    }
  });
}

test("receipt refusal leaves lease expiry and renewal events unchanged", async () => {
  const f = await fixture();
  try {
    const lease = f.state.lease(`issue:${id}`);
    const events = f.owner.events(namespace);
    await expect(f.close({ receipt: "missing" })).rejects.toThrow(
      "RECEIPT_INVALID",
    );
    expect(f.state.lease(`issue:${id}`)).toEqual(lease);
    expect(
      f.owner
        .events(namespace)
        .filter((event) => event.type.startsWith("lease.")),
    ).toEqual(events.filter((event) => event.type.startsWith("lease.")));
    expect(f.flags.present).toBe(true);
  } finally {
    await f.dispose();
  }
});

test("landing comment recovery rejects mismatched authority and cannot mutate issue or claim", async () => {
  const f = await fixture();
  try {
    f.flags.failComment = true;
    await expect(f.close()).rejects.toThrow("injected landing comment failure");
    f.state.release(`issue:${id}`);
    const issue = f.state.get(`issue:${id}`),
      lease = f.state.lease(`issue:${id}`);
    const input = { id, pr: 1, receipt: "proof", generation: 1 };
    for (const mismatch of [
      { id: "work-2" },
      { pr: 2 },
      { receipt: "other" },
      { generation: 2 },
    ]) {
      expect(() =>
        f.state.appendLandingComment({ ...input, ...mismatch }),
      ).toThrow();
    }
    expect(f.comments()).toHaveLength(0);
    const written = f.state.appendLandingComment(input);
    const events = f.owner.events(namespace);
    expect(f.state.appendLandingComment(input)).toEqual(written);
    expect(f.owner.events(namespace)).toEqual(events);
    expect(f.comments()).toHaveLength(1);
    expect(f.state.get(`issue:${id}`)).toEqual(issue);
    expect(f.state.lease(`issue:${id}`)).toEqual(lease);
    expect(() =>
      f.state.put(`issue:${id}`, {}, { expectRevision: issue!.revision }),
    ).toThrow();
  } finally {
    await f.dispose();
  }
});

test("two no-PR drops with the same reason append two distinct landing notes", async () => {
  const f = await fixture();
  try {
    const input = {
      pr: undefined,
      receipt: undefined,
      noPr: true,
      dropped: "Replaced",
    };
    await f.close(input);
    f.flags.present = true;
    f.flags.branch = true;
    f.files.set("forge-lanes.json", JSON.stringify([f.lane]));
    await f.close(input);
    expect(f.comments()).toHaveLength(2);
    const bodies = f
      .comments()
      .map((row) => (row.value as { body: string }).body);
    expect(new Set(bodies).size).toBe(2);
    expect(
      [...f.files.keys()].filter((path) => path.includes("close-no-pr-")),
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("a lane that switched its checkout to a new branch closes with the PR from that branch", async () => {
  const f = await fixture(false);
  try {
    f.flags.checkout = "feature-b";
    f.flags.prBranch = "feature-b";
    const closed = (await f.close()) as { removed: boolean; status: string };
    expect(closed.removed).toBe(true);
    expect(closed.status).toBe("closed");
    expect(f.flags.present).toBe(false);
    expect(f.files.get("forge-lanes.json")).not.toContain(id);
    const links = f.owner
      .list(namespace, `link:${id}:`)
      .map((row) => row.value as { relation: string; url: string });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ relation: "delivers", url });
    expect(
      (f.owner.get(namespace, `issue:${id}`)?.value as { status: string })
        .status,
    ).toBe("closed");
  } finally {
    await f.dispose();
  }
});

test("a switched lane still refuses a PR whose branch matches neither recorded nor checkout branch", async () => {
  const f = await fixture();
  try {
    f.flags.checkout = "feature-b";
    f.flags.prBranch = "feature-c";
    await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
    expect(f.flags.present).toBe(true);
  } finally {
    await f.dispose();
  }
});

test("a switched lane still refuses a checkout with unpushed commits", async () => {
  const f = await fixture();
  try {
    f.flags.checkout = "feature-b";
    f.flags.prBranch = "feature-b";
    f.flags.localHead = "c".repeat(40);
    f.flags.ancestor = false;
    await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
    expect(f.flags.present).toBe(true);
  } finally {
    await f.dispose();
  }
});

const snapshot = (f: Awaited<ReturnType<typeof fixture>>) =>
  JSON.stringify({
    files: [...f.files.entries()],
    present: f.flags.present,
    branch: f.flags.branch,
    issue: f.owner.get(namespace, `issue:${id}`),
    links: f.owner.list(namespace, `link:${id}:`),
    comments: f.comments(),
  });

type Fixture = Awaited<ReturnType<typeof fixture>>;
const refusals: [string, string, (f: Fixture) => void][] = [
  [
    "a PR merged into a branch other than main",
    "PR_NOT_MERGED",
    (f) => {
      f.flags.prBase = "release";
    },
  ],
  [
    "a merge commit with no common ancestor with fetched main",
    "PR_NOT_MERGED",
    (f) => {
      f.flags.mergeBase = "none";
    },
  ],
  [
    "a merge commit whose merge base with fetched main is another commit",
    "PR_NOT_MERGED",
    (f) => {
      f.flags.mergeBase = "other";
    },
  ],
  [
    "a merge commit that cannot be found on fetched main",
    "PR_NOT_MERGED",
    (f) => {
      f.flags.mergeBase = "empty";
    },
  ],
  [
    "a failed ancestry check in a shallow clone",
    "MERGE_UNVERIFIABLE",
    (f) => {
      f.flags.mergeBase = "none";
      f.flags.shallow = true;
    },
  ],
];

for (const [name, code, setup] of refusals) {
  test(`${name} is refused with ${code} and nothing is written or removed`, async () => {
    const f = await fixture();
    try {
      setup(f);
      const before = snapshot(f);
      await expect(f.close()).rejects.toThrow(code);
      expect(snapshot(f)).toBe(before);
      expect(f.flags.present).toBe(true);
      expect(f.flags.branch).toBe(true);
      expect(f.flags.privateRefs.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);
}

test("a failed ancestry check outside a shallow clone is not reported as shallow", async () => {
  const f = await fixture();
  try {
    f.flags.mergeBase = "none";
    await expect(f.close()).rejects.toThrow("PR_NOT_MERGED");
    expect(f.flags.calls).toContainEqual([
      "rev-parse",
      "--is-shallow-repository",
    ]);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a PR merged into main with its merge commit on fetched main still closes", async () => {
  const f = await fixture();
  try {
    const closed = (await f.close()) as { removed: boolean; status: string };
    expect(closed).toMatchObject({ removed: true, status: "closed" });
    const fetch = f.flags.calls.find(
      (args) => args[0] === "fetch" && args[2]?.startsWith("+refs/heads/main:"),
    );
    expect(fetch).toBeDefined();
    const mainRef = fetch![2]!.split(":")[1]!;
    expect(mainRef).toMatch(/^refs\/forge\/lane-close\//);
    expect(f.flags.calls).toContainEqual(["merge-base", merge, mainRef]);
    expect(f.flags.privateRefs.size).toBe(0);
    const view = f.flags.calls.find((args) => args[0] === "pr");
    expect(view?.[view.indexOf("--json") + 1]?.split(",").sort()).toEqual(
      [
        "state",
        "headRefName",
        "baseRefName",
        "headRefOid",
        "mergeCommit",
        "url",
      ].sort(),
    );
  } finally {
    await f.dispose();
  }
}, 30_000);

test("the private fetch writes only its own ref", async () => {
  const f = await fixture();
  try {
    await f.close();
    const fetch = f.flags.calls.find((args) => args[0] === "fetch");
    expect(fetch?.slice(3)).toEqual(["--refmap=", "--no-tags", "--no-prune"]);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a signal aborted right after the fetch still deletes the private ref and keeps the original error", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    f.flags.afterFetch = () => controller.abort();
    await expect(f.close({}, { signal: controller.signal })).rejects.toThrow(
      "SERVICE_EXPIRED: merge-base",
    );
    expect(f.flags.privateRefs.size).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a deadline that expires right after the fetch still deletes the private ref", async () => {
  const f = await fixture(),
    realNow = Date.now,
    deadline = Date.now() + 60_000;
  try {
    f.flags.afterFetch = () => {
      Date.now = () => deadline + 1;
    };
    await expect(f.close({}, { deadline })).rejects.toThrow(
      "INVOCATION_TIMEOUT",
    );
    expect(f.flags.privateRefs.size).toBe(0);
  } finally {
    Date.now = realNow;
    await f.dispose();
  }
}, 30_000);

test("the next close removes a stale private ref and keeps a fresh one", async () => {
  const f = await fixture(),
    fresh = `refs/forge/lane-close/${Date.now()}-fresh`;
  try {
    f.flags.privateRefs.add("refs/forge/lane-close/1-stale");
    f.flags.privateRefs.add(fresh);
    await f.close();
    expect([...f.flags.privateRefs]).toEqual([fresh]);
  } finally {
    await f.dispose();
  }
}, 30_000);
