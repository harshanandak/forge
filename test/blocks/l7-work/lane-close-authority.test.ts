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
async function fixture(seedLink = true, generation = 1) {
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
    leaseGeneration: generation,
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
    dirty: false,
    prState: "MERGED",
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
          : receipt === "elsewhere"
            ? { id: receipt, status: "PASS", subject: "d".repeat(40) }
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
      run: (_executable: unknown, args: string[]) => {
        let stdout = "",
          exitCode = 0;
        if (args[0] === "pr")
          stdout = JSON.stringify({
            state: flags.prState,
            headRefName: flags.prBranch || lane.branch,
            headRefOid: head,
            mergeCommit: flags.prState === "MERGED" ? { oid: merge } : null,
            url,
          });
        else if (args[0] === "status" && !args.includes("--ignored")) {
          if (flags.dirty) stdout = " M file";
        } else if (args[0] === "worktree" && args[1] === "list")
          stdout = "worktree /project\0branch refs/heads/main\0\0";
        else if (args[0] === "for-each-ref")
          stdout = flags.branch ? args[2]! : "";
        else if (args[0] === "rev-parse") stdout = flags.localHead || head;
        else if (args.includes("symbolic-ref"))
          stdout = flags.checkout || lane.branch;
        else if (args[0] === "merge-base") exitCode = flags.ancestor ? 0 : 1;
        else if (args[0] === "-C") {
          stdout = "true";
          if (!flags.present) exitCode = 1;
        } else if (args[0] === "worktree") {
          if (flags.failCleanup) exitCode = 1;
          else flags.present = false;
        } else if (args[0] === "update-ref") flags.branch = false;
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
  const close = (extra = {}) =>
    operations["lane.close"]!({
      input: { id, pr: 1, receipt: "proof", ...extra },
      services,
      signal: new AbortController().signal,
      deadline: Number.MAX_SAFE_INTEGER,
    });
  const comments = () => owner.list(namespace, `comment:${id}:`);
  return {
    services,
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

/** The issue was closed by hand with an exemption and its claim is gone: the state forge-980 was left in. */
function closeByHand(f: Awaited<ReturnType<typeof fixture>>) {
  const issue = f.owner.get(namespace, `issue:${id}`)!;
  f.owner.release(namespace, {
    subject: `issue:${id}`,
    holder: f.holder,
    generation: 1,
  });
  f.owner.put(
    namespace,
    `issue:${id}`,
    {
      ...(issue.value as object),
      status: "closed",
      withoutReceipt: "closed by hand",
    },
    f.holder.actor,
    { expectRevision: issue.revision },
  );
  return f.owner.get(namespace, `issue:${id}`)!;
}
const laneLeft = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.files.get("forge-lanes.json")!.includes(id);

for (const linked of [true, false])
  test(`a lane whose issue was closed by hand is released with no lease (PR ${linked ? "linked" : "not linked"})`, async () => {
    const f = await fixture(linked, 0);
    try {
      const before = closeByHand(f);
      const links = f.owner.list(namespace, `link:${id}:`).length;
      const released = (await f.close()) as {
        removed: boolean;
        status: string;
      };
      expect(released).toMatchObject({ removed: true, status: "closed" });
      expect(f.flags.present).toBe(false);
      expect(f.flags.branch).toBe(false);
      expect(laneLeft(f)).toBe(false);
      expect(f.owner.get(namespace, `issue:${id}`)).toEqual(before);
      expect(f.owner.list(namespace, `link:${id}:`)).toHaveLength(links);
      expect(f.comments()).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

for (const [name, setup, code] of [
  [
    "a dirty worktree",
    (f: Awaited<ReturnType<typeof fixture>>) => (f.flags.dirty = true),
    "INPUT_CONFLICT",
  ],
  [
    "unpushed commits",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.flags.localHead = "c".repeat(40);
      f.flags.ancestor = false;
    },
    "INPUT_CONFLICT",
  ],
  [
    "a PR that is not merged",
    (f: Awaited<ReturnType<typeof fixture>>) => (f.flags.prState = "OPEN"),
    "PR_NOT_MERGED",
  ],
] as const)
  test(`a closed-by-hand lane is still refused for ${name}`, async () => {
    const f = await fixture(true, 0);
    try {
      const before = closeByHand(f);
      setup(f);
      await expect(f.close()).rejects.toThrow(code);
      expect(f.flags.present).toBe(true);
      expect(f.flags.branch).toBe(true);
      expect(laneLeft(f)).toBe(true);
      expect(f.owner.get(namespace, `issue:${id}`)).toEqual(before);
    } finally {
      await f.dispose();
    }
  }, 30_000);

for (const [receipt, code] of [
  ["missing", "RECEIPT_INVALID"],
  ["elsewhere", "RECEIPT_HEAD_MISMATCH"],
] as const)
  test(`a closed-by-hand lane is refused when its receipt is ${receipt}`, async () => {
    const f = await fixture(true, 0);
    try {
      closeByHand(f);
      await expect(f.close({ receipt })).rejects.toThrow(code);
      expect(f.flags.present).toBe(true);
      expect(laneLeft(f)).toBe(true);
    } finally {
      await f.dispose();
    }
  }, 30_000);

test("a lane whose issue was closed with another receipt is still refused without a lease", async () => {
  const f = await fixture(true, 0);
  try {
    const issue = f.owner.get(namespace, `issue:${id}`)!;
    f.owner.put(
      namespace,
      `issue:${id}`,
      { ...(issue.value as object), status: "closed", receipt: "elsewhere" },
      f.holder.actor,
      { expectRevision: issue.revision },
    );
    await expect(f.close()).rejects.toThrow();
    expect(f.flags.present).toBe(true);
    expect(laneLeft(f)).toBe(true);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a lane whose issue is open still needs its lease", async () => {
  const f = await fixture(true, 0);
  try {
    await expect(f.close()).rejects.toThrow();
    expect(f.flags.present).toBe(true);
    expect(f.flags.branch).toBe(true);
    expect(laneLeft(f)).toBe(true);
    expect(
      (f.owner.get(namespace, `issue:${id}`)!.value as { status: string })
        .status,
    ).toBe("open");
  } finally {
    await f.dispose();
  }
}, 30_000);

for (const [name, extra] of [
  ["a drop", { dropped: "replaced" }],
  ["a close that keeps the issue open", { keepOpen: true }],
] as const)
  test(`a closed-by-hand lane is still refused for ${name} without a lease`, async () => {
    const f = await fixture(true, 0);
    try {
      const before = closeByHand(f);
      f.flags.prState = "CLOSED";
      await expect(f.close(extra)).rejects.toThrow();
      expect(f.flags.present).toBe(true);
      expect(f.flags.branch).toBe(true);
      expect(laneLeft(f)).toBe(true);
      expect(f.owner.get(namespace, `issue:${id}`)).toEqual(before);
    } finally {
      await f.dispose();
    }
  }, 30_000);

const shown = (f: Awaited<ReturnType<typeof fixture>>) =>
  operations["lane.show"]!({
    input: { id },
    services: f.services,
    signal: new AbortController().signal,
    deadline: Number.MAX_SAFE_INTEGER,
  }) as Promise<{ leaseWaiver?: { reason: string }; lease?: unknown }>;

test("lane show waives the lease only for an issue closed without a receipt that holds none", async () => {
  const f = await fixture(true, 0);
  try {
    expect((await shown(f)).leaseWaiver).toBeUndefined();
    const issue = f.owner.get(namespace, `issue:${id}`)!;
    f.owner.release(namespace, {
      subject: `issue:${id}`,
      holder: f.holder,
      generation: 1,
    });
    f.owner.put(
      namespace,
      `issue:${id}`,
      { ...(issue.value as object), status: "closed", receipt: "proof" },
      f.holder.actor,
      { expectRevision: issue.revision },
    );
    expect((await shown(f)).leaseWaiver).toBeUndefined();
  } finally {
    await f.dispose();
  }
}, 30_000);

test("lane show waives the lease for a lane whose issue was closed by hand", async () => {
  const f = await fixture(true, 0);
  try {
    closeByHand(f);
    const result = await shown(f);
    expect(result.leaseWaiver?.reason).toContain("closed without a receipt");
    expect(result.lease).toBeUndefined();
  } finally {
    await f.dispose();
  }
}, 30_000);
