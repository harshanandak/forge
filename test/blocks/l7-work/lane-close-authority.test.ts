import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { SchemaRegistry } from "../../../src/contract/schema.ts";
import type { BoundContext } from "../../../src/generated/types.ts";
import tracker from "../../../schemas/tracker.json" with { type: "json" };
import { validateWorkRecord } from "../../../src/blocks/work/validation.ts";
import laneCloseInput from "../../../src/blocks/work/schemas/lane-close.input.json" with { type: "json" };

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
async function fixture(seedLink = true, pullUrl = url) {
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
      { id, relation: "delivers", url: pullUrl },
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
    partialRemove: false,
    deniedRemove: false,
    denied: false,
    failBranchDelete: false,
    root: "/project",
    leftover: false,
    listed: false,
    held: "",
    vanishRemove: false,
    emptyFails: false,
    lanes: "",
    holder: false,
    run: 0,
    checkout: "",
    prBranch: "",
    localHead: "",
    retained: "",
    ancestor: true,
    prBase: "main",
    prState: "MERGED",
    checkPages: [] as unknown[],
    mergeBase: "match",
    shallow: false,
    calls: [] as string[][],
    privateRefs: new Set<string>(),
    afterFetch: undefined as (() => void) | undefined,
    beforeLandingComment: undefined as (() => void) | undefined,
    duringReceiptCheck: undefined as (() => void) | undefined,
    refuse: false,
  };
  // The handler reads time from this clock; tests never touch the global Date.
  // It is separate from the state clock, so moving it does not expire the lease.
  const time = { value: Date.now() };
  const services = {
    clock: { now: () => time.value },
    state: {
      ...state,
      now: () => now,
      appendLandingComment: (
        ...args: Parameters<typeof state.appendLandingComment>
      ) => {
        flags.beforeLandingComment?.();
        return state.appendLandingComment(...args);
      },
      // The landing note is a numbered write, so the injected failure fires at the numbered-write seam.
      putNext: (...args: Parameters<typeof state.putNext>) => {
        if (args[0].startsWith("comment:")) {
          if (flags.failComment) {
            flags.failComment = false;
            throw new Error("injected landing comment failure");
          }
          flags.beforeLandingComment?.();
        }
        return state.putNext(...args);
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
      get root() {
        return flags.root;
      },
      lane: (path: string, lanes: string) => {
        flags.lanes = lanes;
        if (flags.denied || path !== lane.worktree)
          throw new Error("EACCES: permission denied");
        if (!flags.present) return "missing" as const;
        if (!flags.leftover) return "worktree" as const;
        return flags.held === "" && !flags.emptyFails
          ? ("empty" as const)
          : ("leftover" as const);
      },
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
          stderr = "",
          exitCode = 0;
        // A cancelled or expired invocation refuses every further process call.
        if (flags.refuse || options?.signal?.aborted)
          return Promise.reject(new Error(`SERVICE_EXPIRED: ${args[0]}`));
        flags.calls.push(args);
        if (
          args[0] === "fetch" &&
          args[2]?.includes(":refs/forge/lane-close/")
        ) {
          flags.privateRefs.add(args[2].split(":")[1]!);
          flags.afterFetch?.();
        }
        if (args[0] === "pr") {
          if (args[2] === pullUrl) flags.duringReceiptCheck?.();
          stdout = JSON.stringify({
            state: flags.prState,
            baseRefName: flags.prBase,
            baseRefOid: merge,
            changedFiles: 1,
            mergeStateStatus: "UNKNOWN",
            headRefName: flags.prBranch || lane.branch,
            headRefOid: head,
            mergeCommit: { oid: merge },
            url: pullUrl,
          });
        } else if (args[0] === "api") stdout = JSON.stringify(flags.checkPages);
        else if (args[0] === "log") stdout = flags.retained;
        else if (args[0] === "worktree" && args[1] === "list")
          stdout =
            "worktree /project\0branch refs/heads/main\0\0" +
            (flags.listed
              ? "worktree /lane\0prunable gitdir file points to non-existent location\0\0"
              : "") +
            (flags.holder
              ? `worktree /elsewhere\0HEAD ${head}\0branch refs/heads/feature\0\0`
              : "");
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
        else if (args[0] === "-C" && flags.denied) {
          exitCode = 128;
          stderr = "fatal: cannot change to '/lane': Permission denied";
        } else if (args[0] === "-C") {
          stdout = flags.leftover ? "true\n.worktrees/lane/\n" : "true\n\n";
          if (!flags.present) exitCode = 1;
        } else if (args[0] === "worktree") {
          if (flags.deniedRemove) {
            flags.denied = true;
            exitCode = 128;
            stderr = "fatal: '/lane' is locked";
          } else if (flags.vanishRemove) {
            flags.present = false;
            exitCode = 255;
            stderr = "error: failed to delete '/lane/.git': Permission denied";
          } else if (flags.partialRemove) {
            flags.leftover = true;
            exitCode = 255;
            stderr = "error: failed to delete '/lane': Permission denied";
          } else if (flags.failCleanup) exitCode = 1;
          else flags.present = false;
        } else if (args[0] === "update-ref") {
          if (args[2]?.startsWith("refs/forge/lane-close/"))
            flags.privateRefs.delete(args[2]);
          else if (flags.failBranchDelete) exitCode = 1;
          else flags.branch = false;
        }
        return Promise.resolve({
          stdout,
          exitCode,
          stderr,
          signal: null,
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
    time,
    close,
    comments,
    expire: () => {
      now = Date.parse(state.lease(`issue:${id}`)!.expiresAt) + 1;
    },
    now: () => now,
    dispose: () => opened.handle.close(),
  };
}

test("lane close refuses an oversized close before writing a delivery link or landing", async () => {
  const f = await fixture(false);
  try {
    const key = `issue:${id}`;
    const row = f.state.get(key)!;
    const value = {
      ...(row.value as object),
      body: "",
      actualFiles: Array(1024).fill(`src/${"x".repeat(753)}`),
    };
    const show = () =>
      operations["issue.show"]!({
        input: { id },
        services: { state: f.state },
        signal: new AbortController().signal,
        deadline: Number.MAX_SAFE_INTEGER,
      });
    f.state.put(key, value, { expectRevision: row.revision });
    value.body = "x".repeat(
      786_425 - Buffer.byteLength(JSON.stringify(await show())),
    );
    f.state.put(key, value, { expectRevision: row.revision + 1 });
    const before = f.owner.export();
    const files = [...f.files];
    expect(Buffer.byteLength(JSON.stringify(await show()))).toBe(786_425);
    await expect(f.close()).rejects.toThrow("LIMIT_EXCEEDED");
    expect([f.owner.export(), [...f.files]]).toEqual([before, files]);
  } finally {
    await f.dispose();
  }
});

function freeze(f: Awaited<ReturnType<typeof fixture>>) {
  f.owner.put(
    namespace,
    "autopilot:global",
    { stopped: {}, frozen: new Date(f.now()).toISOString() },
    f.holder.actor,
    { expectRevision: 0 },
  );
  return f.owner.events(namespace);
}

for (const recovery of [false, true]) {
  test(`freeze wins before ${recovery ? "recovering" : "appending"} a lane close comment`, async () => {
    const f = await fixture();
    try {
      if (recovery) {
        f.flags.failComment = true;
        await expect(f.close()).rejects.toThrow(
          "injected landing comment failure",
        );
        f.state.release(`issue:${id}`);
      }
      let events: ReturnType<typeof freeze> = [];
      f.flags.beforeLandingComment = () => {
        events = freeze(f);
      };
      await expect(f.close()).rejects.toMatchObject({
        error: { code: "REVISION_CONFLICT" },
      });
      expect(f.comments()).toHaveLength(0);
      expect(
        f.owner.get(namespace, `allocation:comment:${id}:`),
      ).toBeUndefined();
      expect(f.owner.events(namespace)).toEqual(events);
    } finally {
      await f.dispose();
    }
  });
}

test("freeze during receipt validation leaves no landing record", async () => {
  const f = await fixture();
  try {
    let events: ReturnType<typeof freeze> = [];
    f.flags.duringReceiptCheck = () => {
      events = freeze(f);
    };
    await expect(f.close()).rejects.toMatchObject({
      error: { code: "REVISION_CONFLICT" },
    });
    expect(f.owner.get(namespace, `landing:${id}:1`)).toBeUndefined();
    expect(f.owner.events(namespace)).toEqual(events);
  } finally {
    await f.dispose();
  }
});

test("competing keep-open validates without selection while a real lane close refuses", async () => {
  for (const keepOpen of [false, true]) {
    const f = await fixture();
    try {
      f.owner.put(
        namespace,
        `slots:${id}`,
        { count: 2, next: 0 },
        f.holder.actor,
        { expectRevision: 0 },
      );
      if (keepOpen) await f.close({ keepOpen });
      else await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
      expect(f.owner.get(namespace, `issue:${id}`)?.value).toMatchObject({
        status: "open",
      });
      expect(f.owner.get(namespace, `selection:${id}`)).toBeUndefined();
      if (!keepOpen) {
        expect(f.flags.present).toBe(true);
        expect(f.flags.branch).toBe(true);
        expect(JSON.parse(f.files.get("forge-lanes.json")!)).toEqual([f.lane]);
      }
    } finally {
      await f.dispose();
    }
  }
}, 10000);

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

test("a worktree remove that git still lists refuses before the branch delete, and the retry names the files left", async () => {
  const f = await fixture();
  try {
    f.flags.partialRemove = true;
    f.flags.listed = true;
    await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
    expect(
      (f.owner.get(namespace, `issue:${id}`)?.value as { status: string })
        .status,
    ).toBe("closed");
    expect(f.flags.branch).toBe(true);
    expect(
      f.flags.calls.some(
        (args) => args[0] === "update-ref" && args[2] === "refs/heads/feature",
      ),
    ).toBe(false);
    expect(f.files.get("forge-lanes.json")).toContain('"/lane"');
    f.flags.partialRemove = false;
    f.flags.listed = false;
    f.flags.held = "!! .worktrees/lane/held.txt\0";
    expect(await f.close()).toMatchObject({
      issue: id,
      status: "closed",
      removed: true,
      leftover: { path: "/lane", empty: false, next: [] },
    });
    expect(f.flags.branch).toBe(false);
    expect(f.files.get("forge-lanes.json")).not.toContain('"/lane"');
    expect(f.comments()).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test("a lane directory git cannot read after a refused remove keeps the branch, registry row and journal", async () => {
  const f = await fixture();
  try {
    const kept = () => {
      expect(f.flags.branch).toBe(true);
      expect(f.files.get("forge-lanes.json")).toContain('"/lane"');
      expect(
        [...f.files.keys()].some((path) =>
          path.startsWith("forge-lane-close-"),
        ),
      ).toBe(true);
    };
    f.flags.deniedRemove = true;
    f.flags.listed = true;
    await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
    kept();
    f.flags.deniedRemove = false;
    f.flags.listed = false;
    await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
    kept();
    f.flags.denied = false;
    expect(await f.close()).toMatchObject({ status: "closed", removed: true });
    expect(f.flags.present).toBe(false);
    expect(f.flags.branch).toBe(false);
    expect(f.files.get("forge-lanes.json")).not.toContain('"/lane"');
    expect(f.comments()).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test("a retry from another worktree finishes cleanup after the lane directory was removed and the branch delete failed", async () => {
  const f = await fixture();
  try {
    f.flags.failBranchDelete = true;
    await expect(f.close()).rejects.toThrow("INPUT_CONFLICT");
    expect(f.flags.present).toBe(false);
    expect(f.flags.branch).toBe(true);
    f.flags.failBranchDelete = false;
    f.flags.root = "/other";
    const result = (await f.close()) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "closed", removed: true });
    expect(result.leftover).toBeUndefined();
    expect(f.flags.lanes).toBe("/project/.worktrees");
    expect(f.flags.branch).toBe(false);
    expect(f.files.get("forge-lanes.json")).not.toContain('"/lane"');
    expect(
      [...f.files.keys()].some((path) => path.startsWith("forge-lane-close-")),
    ).toBe(false);
    expect(f.comments()).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 30000);

async function refusal(close: () => Promise<unknown>) {
  const previous = globals.fail;
  globals.fail = (code: string, message: string) => {
    throw Object.assign(new Error(code), { error: { code, message } });
  };
  try {
    await close();
  } catch (error) {
    return (
      error as {
        error: {
          code: string;
          message: string;
          observed?: { next: string[][] };
        };
      }
    ).error;
  } finally {
    globals.fail = previous;
  }
  throw new Error("expected a refusal");
}
const resume = [
  "forge",
  "lane",
  "close",
  id,
  "--pr",
  "1",
  "--receipt",
  "proof",
];

test("a leftover whose emptiness read fails still finishes, and only a proven empty one gets rmdir", async () => {
  for (const fails of [true, false]) {
    const f = await fixture();
    try {
      f.flags.partialRemove = true;
      f.flags.emptyFails = fails;
      expect(await f.close()).toMatchObject({
        status: "closed",
        removed: true,
        leftover: {
          path: "/lane",
          empty: !fails,
          next: fails ? [] : [["rmdir", "/lane"]],
        },
      });
      expect(f.flags.branch).toBe(false);
      expect(f.files.get("forge-lanes.json")).not.toContain('"/lane"');
    } finally {
      await f.dispose();
    }
  }
}, 30000);

test("a lane git still lists gets worktree remove when its directory is gone, and prune with a warning when it is left", async () => {
  for (const vanished of [true, false]) {
    const f = await fixture();
    try {
      f.flags.listed = true;
      if (vanished) f.flags.vanishRemove = true;
      else f.flags.partialRemove = true;
      const error = await refusal(() => f.close());
      expect(error.code).toBe("INPUT_CONFLICT");
      expect(error.observed?.next).toEqual([
        vanished
          ? ["git", "worktree", "remove", "/lane"]
          : ["git", "worktree", "prune"],
        resume,
      ]);
      if (vanished) expect(error.message).not.toContain("prune");
      else
        expect(error.message).toContain(
          "git worktree prune acts on the whole repository",
        );
      expect(f.flags.branch).toBe(true);
      expect(f.files.get("forge-lanes.json")).toContain('"/lane"');
    } finally {
      await f.dispose();
    }
  }
}, 30000);

test("a lane branch another worktree has checked out is kept with the registry row and journal", async () => {
  const f = await fixture();
  try {
    f.flags.holder = true;
    const error = await refusal(() => f.close());
    expect(error.code).toBe("INPUT_CONFLICT");
    expect(error.message).toContain("/elsewhere");
    expect(error.message).toContain(
      "branch, registry row and journal were kept",
    );
    expect(error.observed?.next).toEqual([resume]);
    expect(f.flags.branch).toBe(true);
    expect(
      f.flags.calls.some(
        (args) => args[0] === "update-ref" && args[2] === "refs/heads/feature",
      ),
    ).toBe(false);
    expect(f.files.get("forge-lanes.json")).toContain('"/lane"');
    expect(
      [...f.files.keys()].some((path) => path.startsWith("forge-lane-close-")),
    ).toBe(true);
    f.flags.holder = false;
    expect(await f.close()).toMatchObject({ status: "closed", removed: true });
    expect(f.flags.branch).toBe(false);
  } finally {
    await f.dispose();
  }
}, 30000);

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

test("lane.close bounds a retained-commit note and reports omitted commits", async () => {
  const f = await fixture();
  const limit = tracker.$defs.CommentInput.properties.body.maxLength;
  try {
    f.flags.localHead = "c".repeat(40);
    f.flags.retained = [
      `${"c".repeat(40)} short`,
      `${"d".repeat(40)} ${"x".repeat(limit)}`,
      `${"e".repeat(40)} later`,
    ].join("\n");
    await f.close({
      pr: undefined,
      receipt: undefined,
      noPr: true,
      dropped: "Fixture finished",
    });
    const [comment] = f.comments();
    expect(comment).toBeDefined();
    const body = (comment!.value as { body: string }).body;
    expect(Array.from(body).length).toBeLessThanOrEqual(limit);
    expect(body).toContain(`${"c".repeat(40)} short`);
    expect(body).toEndWith("[Note shortened; 2 retained commits omitted]");
    expect(validateWorkRecord(comment!.key, comment!.value)).toBeUndefined();
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
const hostedInput = { hostedEvidence: true, receipt: undefined };
test("lane close accepts exactly one evidence mode and requires a PR for hosted evidence", () => {
  const schemaId = "https://test.invalid/lane-close";
  const schema = new SchemaRegistry([{ ...laneCloseInput, $id: schemaId }]);
  const validate = (input: Record<string, unknown>) =>
    schema.validate(schemaId, { id, ...input }, true);
  for (const input of [
    { pr: 1, hostedEvidence: true },
    { pr: 1, receipt: "proof" },
    { pr: 1, dropped: "fixture" },
    { noPr: true, dropped: "fixture" },
  ])
    expect(validate(input)).toEqual([]);
  for (const input of [
    { hostedEvidence: true },
    { pr: 1, hostedEvidence: false },
    { pr: 1, hostedEvidence: true, receipt: "proof" },
    { pr: 1, hostedEvidence: true, dropped: "fixture" },
    { noPr: true, hostedEvidence: true, dropped: "fixture" },
  ])
    expect(validate(input).length).toBeGreaterThan(0);
}, 30_000);

const hostedUrl = "https://github.com/harshanandak/forge/pull/1";
const ciGate = (databaseId = 17, workflowId = 10) => ({
  __typename: "CheckRun",
  databaseId,
  name: "CI Gate",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  isRequired: true,
  checkSuite: {
    app: { slug: "github-actions" },
    workflowRun: { workflow: { databaseId: workflowId } },
    commit: { oid: head },
    repository: { nameWithOwner: "harshanandak/forge" },
  },
});
function checkPage(
  nodes: unknown[],
  totalCount = nodes.length,
  oid = head,
  endCursor: string | null = null,
) {
  return {
    data: {
      repository: {
        object: {
          oid,
          statusCheckRollup: {
            contexts: {
              totalCount,
              pageInfo: { hasNextPage: endCursor !== null, endCursor },
              nodes,
            },
          },
        },
      },
    },
  };
}
const hostedRefusals: [string, string, (f: Fixture) => void][] = [
  [
    "stale lane head",
    "HOSTED_EVIDENCE_HEAD_MISMATCH",
    (f) => {
      f.flags.localHead = "c".repeat(40);
    },
  ],
  ...["OPEN", "CLOSED"].map((state): [string, string, (f: Fixture) => void] => [
    state,
    "HOSTED_EVIDENCE_NOT_MERGED",
    (f) => {
      f.flags.prState = state;
    },
  ]),
  ...(
    [
      ["missing CI Gate", checkPage([])],
      ["failed CI Gate", checkPage([{ ...ciGate(), conclusion: "FAILURE" }])],
      [
        "two CI Gate runs when one has no database ID",
        checkPage([ciGate(), { ...ciGate(18), databaseId: undefined }]),
      ],
      [
        "a CI Gate run without a workflow ID",
        checkPage([
          {
            ...ciGate(),
            checkSuite: { ...ciGate().checkSuite, workflowRun: null },
          },
        ]),
      ],
      [
        "a newer CI Gate success in a different workflow",
        checkPage([{ ...ciGate(), conclusion: "FAILURE" }, ciGate(18, 11)]),
      ],
      [
        "a second CI Gate still running",
        checkPage([
          ciGate(),
          { ...ciGate(18), status: "IN_PROGRESS", conclusion: null },
        ]),
      ],
      [
        "another app",
        checkPage([
          {
            ...ciGate(),
            checkSuite: { ...ciGate().checkSuite, app: { slug: "other-app" } },
          },
        ]),
      ],
      [
        "another repository",
        checkPage([
          {
            ...ciGate(),
            checkSuite: {
              ...ciGate().checkSuite,
              repository: { nameWithOwner: "fork/forge" },
            },
          },
        ]),
      ],
      [
        "another check suite head",
        checkPage([
          {
            ...ciGate(),
            checkSuite: { ...ciGate().checkSuite, commit: { oid: merge } },
          },
        ]),
      ],
      ["another queried head", checkPage([ciGate()], 1, merge)],
      [
        "a same-name status beside the real run",
        checkPage([
          ciGate(),
          {
            __typename: "StatusContext",
            context: "CI Gate",
            state: "SUCCESS",
            isRequired: true,
          },
        ]),
      ],
      ["an incomplete page", checkPage([ciGate()], 2)],
    ] as const
  ).map(([name, page]): [string, string, (f: Fixture) => void] => [
    name,
    "HOSTED_EVIDENCE_UNVERIFIED",
    (f) => {
      f.flags.checkPages = [page];
    },
  ]),
];

for (const [name, code, setup] of hostedRefusals) {
  test(`hosted lane close refuses ${name} with ${code} before changing the lane`, async () => {
    const f = await fixture(false, hostedUrl);
    try {
      f.flags.checkPages = [checkPage([ciGate()])];
      setup(f);
      const before = snapshot(f);
      const error = await refusal(() => f.close(hostedInput));
      expect(error.code).toBe(code);
      expect(snapshot(f)).toBe(before);
      expect(f.flags.calls.some((args) => args.includes("--ff-only"))).toBe(
        false,
      );
      if (code === "HOSTED_EVIDENCE_HEAD_MISMATCH") {
        expect(error.observed?.next).toEqual([
          ["git", "-C", "/lane", "fetch", "origin", "pull/1/head"],
          ["git", "-C", "/lane", "merge", "--ff-only", head],
          ["forge", "lane", "close", id, "--pr", "1", "--hosted-evidence"],
        ]);
      }
    } finally {
      await f.dispose();
    }
  }, 30_000);
}

for (const draftFailed of [false, true])
  test(`hosted lane close uses the successful CI Gate receipt (${draftFailed ? "after a failed draft" : "single run"})`, async () => {
    const f = await fixture(false, hostedUrl);
    try {
      const ready = checkPage([ciGate(18)], draftFailed ? 2 : 1);
      const draft = checkPage(
        [{ ...ciGate(), conclusion: "FAILURE" }],
        2,
        head,
        "ready",
      );
      f.flags.checkPages = draftFailed ? [draft, ready] : [ready];
      await expect(f.close(hostedInput)).resolves.toMatchObject({
        status: "closed",
        removed: true,
      });
      expect(f.state.get(`landing:${id}:1`)?.value).toMatchObject({
        receipt: `github-actions:check-run:18:${head}:success`,
      });
    } finally {
      await f.dispose();
    }
  }, 30_000);

test("hosted lane close accepts two successful runs and resumes from the saved evidence after a rerun", async () => {
  const f = await fixture(false, hostedUrl);
  const proof = `github-actions:check-run:18:${head}:success`;
  try {
    f.flags.checkPages = [checkPage([ciGate(), ciGate(18)])];
    f.flags.failComment = true;
    await expect(f.close(hostedInput)).rejects.toThrow(
      "injected landing comment failure",
    );
    expect(f.state.get(`issue:${id}`)?.value).toMatchObject({
      status: "closed",
      receipt: proof,
    });
    expect(f.state.get(`landing:${id}:1`)?.value).toMatchObject({
      receipt: proof,
    });
    f.flags.checkPages = [
      checkPage([{ ...ciGate(19), conclusion: "FAILURE" }]),
    ];
    f.flags.calls.length = 0;
    expect(await f.close(hostedInput)).toMatchObject({
      status: "closed",
      removed: true,
    });
    expect(f.flags.calls.some((args) => args[0] === "api")).toBe(false);
    const comment = f.comments()[0]?.value as { body: string } | undefined;
    expect(comment?.body).toContain(`Hosted CI evidence: ${proof}`);
    expect(f.files.get("forge-lanes.json")).not.toContain(id);
  } finally {
    await f.dispose();
  }
}, 30_000);

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
    expect(fetch?.slice(3)).toEqual([
      "--refmap=",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
    ]);
  } finally {
    await f.dispose();
  }
}, 30_000);

/** The next close runs well after a call that was cancelled or timed out. */
async function closeLater(f: Awaited<ReturnType<typeof fixture>>) {
  f.flags.refuse = false;
  f.flags.afterFetch = undefined;
  f.time.value += 2 * 3600000;
  await f.close();
}

test("a signal aborted right after the fetch reports the original error and the next close removes the leftover ref", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    f.flags.afterFetch = () => {
      controller.abort();
      f.flags.refuse = true;
    };
    await expect(f.close({}, { signal: controller.signal })).rejects.toThrow(
      "SERVICE_EXPIRED: merge-base",
    );
    await closeLater(f);
    expect(f.flags.privateRefs.size).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a deadline that expires right after the fetch reports the original error and the next close removes the leftover ref", async () => {
  const f = await fixture(),
    deadline = f.time.value + 60_000;
  try {
    f.flags.afterFetch = () => {
      f.time.value = deadline + 1;
      f.flags.refuse = true;
    };
    await expect(f.close({}, { deadline })).rejects.toThrow(
      "INVOCATION_TIMEOUT",
    );
    await closeLater(f);
    expect(f.flags.privateRefs.size).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30_000);

test("the next close removes a stale private ref and keeps a fresh one", async () => {
  const f = await fixture(),
    fresh = `refs/forge/lane-close/${f.time.value}-11111111-2222-4333-8444-555555555555`;
  try {
    f.flags.privateRefs.add(
      "refs/forge/lane-close/1-11111111-2222-4333-8444-555555555555",
    );
    f.flags.privateRefs.add(fresh);
    await f.close();
    expect([...f.flags.privateRefs]).toEqual([fresh]);
  } finally {
    await f.dispose();
  }
}, 30_000);

for (const mode of [
  "ordinary",
  "recovered after release",
  "recovered after expiry",
])
  test(`a landing note after a deleted high comment takes the next shared suffix (${mode})`, async () => {
    const f = await fixture();
    try {
      for (const n of [1, 2])
        f.owner.put(
          namespace,
          `comment:${id}:${n}`,
          { id, body: `earlier ${n}` },
          f.holder.actor,
          { expectRevision: 0 },
        );
      f.owner.delete(namespace, `comment:${id}:2`, f.holder.actor, {
        expectRevision: 1,
      });
      const deleted = f.owner.events(namespace, `comment:${id}:2`);
      const key = `comment:${id}:3`;
      if (mode === "ordinary") await f.close();
      else {
        f.flags.failComment = true;
        await expect(f.close()).rejects.toThrow(
          "injected landing comment failure",
        );
        if (mode.endsWith("release")) f.state.release(`issue:${id}`);
        else f.expire();
        const issue = f.state.get(`issue:${id}`),
          lease = f.state.lease(`issue:${id}`);
        const input = { id, pr: 1, receipt: "proof", generation: 1 };
        const written = f.state.appendLandingComment(input);
        expect(written.key).toBe(key);
        // The matching-note early return writes nothing and takes no number.
        const events = f.owner.events(namespace);
        expect(f.state.appendLandingComment(input)).toEqual(written);
        expect(f.owner.events(namespace)).toEqual(events);
        expect(f.state.get(`issue:${id}`)).toEqual(issue);
        expect(f.state.lease(`issue:${id}`)).toEqual(lease);
      }
      expect(f.comments().map((row) => row.key)).toEqual([
        `comment:${id}:1`,
        key,
      ]);
      expect(
        f.owner.get(namespace, `allocation:comment:${id}:`)?.value,
      ).toEqual({ prefix: `comment:${id}:`, number: 3 });
      expect(f.owner.events(namespace, `comment:${id}:2`)).toEqual(deleted);
    } finally {
      await f.dispose();
    }
  }, 30_000);
