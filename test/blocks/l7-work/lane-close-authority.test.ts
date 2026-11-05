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
  );
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
async function fixture() {
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
      run: (_executable: unknown, args: string[]) => {
        let stdout = "",
          exitCode = 0;
        if (args[0] === "pr")
          stdout = JSON.stringify({
            state: "MERGED",
            headRefName: lane.branch,
            headRefOid: head,
            mergeCommit: { oid: merge },
            url,
          });
        else if (args[0] === "worktree" && args[1] === "list")
          stdout = "worktree /project\0branch refs/heads/main\0\0";
        else if (args[0] === "for-each-ref")
          stdout = flags.branch ? `refs/heads/${lane.branch}` : "";
        else if (args[0] === "rev-parse") stdout = head;
        else if (args[0] === "symbolic-ref") stdout = lane.branch;
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
      now += 60001;
    },
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
    await expect(f.close()).rejects.toThrow();
    expect(f.flags.present).toBe(true);
    expect(f.flags.branch).toBe(true);
    expect(f.comments()).toHaveLength(0);
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
      else f.expire();
      f.flags.failCleanup = true;
      await expect(f.close()).rejects.toThrow();
      expect(f.comments()).toHaveLength(1);
      f.flags.failCleanup = false;
      await f.close();
      expect(f.comments()).toHaveLength(1);
      expect(f.comments()[0]!.value).toMatchObject({
        body: expect.stringContaining("PR #1 landed:"),
      });
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
