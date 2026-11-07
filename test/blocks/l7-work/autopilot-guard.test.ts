import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(180_000);
type Action = {
  lane: string;
  step: string;
  kind: string;
  why: string;
  ask?: string;
  raw?: string;
};
type Status = {
  enabled: boolean;
  stopped: boolean;
  hold?: string;
  lanes: {
    id: string;
    stopped: boolean;
    calls: { used: number; limit: number };
    hold?: string;
  }[];
};
type Handler<Output> = (call: {
  input: Record<string, unknown>;
  services: unknown;
  config?: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Output | Promise<Output>;
type Operations = {
  "lane.next": Handler<Action | { actions: Action[] }>;
  "lane.stop": Handler<{ stopped: string }>;
  "lane.resume": Handler<{ resumed: string }>;
  "lane.status": Handler<Status>;
};
type Row = {
  key: string;
  revision: number;
  updatedAt: string;
  value: Record<string, unknown>;
};
type Load = { freeMemoryMb: number; cpuBusyPercent: number };

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

function fixture(
  autopilot: Record<string, unknown> = {},
  lanes: Record<string, unknown> = {},
) {
  const config = { lanes: { ...lanes, autopilot } };
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
  const ids = ["work-1", "work-2"];
  for (const id of ids)
    put(
      `issue:${id}`,
      {
        id,
        title: id,
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
  const registry = ids.map((id) => ({
    issue: id,
    issueId: id,
    worktree: `/lane/${id}`,
    branch: `feat/${id}`,
    brief: `/project/.worktrees/briefs/${id}.md`,
  }));
  const sample = { value: { freeMemoryMb: 8000, cpuBusyPercent: 10 } as Load };
  const ghCalls: string[][] = [];
  const services = {
    state,
    files: {
      root: "/project",
      read: (path: string) =>
        path === "forge-lanes.json" ? JSON.stringify(registry) : undefined,
    },
    environment: {
      platform: "linux",
      select: () => ({}),
      load: () => Promise.resolve(sample.value),
    },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: (_executable: unknown, args: string[]) => {
        ghCalls.push(args);
        return Promise.reject(new Error("guard must decide before GitHub"));
      },
    },
  };
  const bound = (input: Record<string, unknown>) => ({
    input,
    services,
    config,
    signal: new AbortController().signal,
    deadline: Number.MAX_SAFE_INTEGER,
  });
  return {
    records,
    sample,
    ghCalls,
    call: (id: string, n: number) =>
      put(
        `comment:${id}:${n}`,
        { id, body: `call ${n} builder`, call: n },
        { expectRevision: 0 },
      ),
    next: async (input: Record<string, unknown>) =>
      await operations["lane.next"](bound(input)),
    all: async () =>
      (
        (await operations["lane.next"](bound({ all: true }))) as {
          actions: Action[];
        }
      ).actions,
    stop: (input: Record<string, unknown>) =>
      operations["lane.stop"](bound(input)),
    status: async () => await operations["lane.status"](bound({})),
  };
}

test("with the stop flag set, lane.next --all returns only pause for every lane", async () => {
  const f = fixture();
  await f.stop({ all: true });
  const actions = await f.all();
  expect(actions).toHaveLength(2);
  for (const action of actions) {
    expect(action.kind).toBe("pause");
    expect(action.why).toMatch(/stop/i);
  }
  expect(await f.next({ id: "work-1" })).toMatchObject({ kind: "pause" });
  expect(f.ghCalls).toHaveLength(0);
  expect((await f.status()).stopped).toBe(true);
});

test("a lane whose calls are used up pauses with an ask naming calls, limit and use", async () => {
  const f = fixture({ budgets: { calls: 3 } });
  for (const n of [1, 2, 3]) f.call("work-1", n);
  const action = (await f.next({ id: "work-1", pr: 7 })) as Action;
  expect(action.kind).toBe("pause");
  expect(action.ask).toMatch(/calls/);
  expect(action.ask).toContain("limit 3");
  expect(action.ask).toContain("used 3");
  expect(f.ghCalls).toHaveLength(0);
  const row = (await f.status()).lanes.find((lane) => lane.id === "work-1");
  expect(row?.calls).toEqual({ used: 3, limit: 3 });
});

test("the default call budget is 20", async () => {
  const f = fixture();
  expect((await f.status()).lanes[0]?.calls).toEqual({ used: 0, limit: 20 });
});

test("a load over the limit holds a new start and lane.status shows why", async () => {
  const f = fixture();
  expect((await f.status()).hold).toBeUndefined();
  f.sample.value = { freeMemoryMb: 500, cpuBusyPercent: 10 };
  expect((await f.status()).hold).toMatch(/^hold: .*free memory 500 MB/);
  f.sample.value = { freeMemoryMb: 8000, cpuBusyPercent: 97 };
  expect((await f.status()).hold).toMatch(/^hold: .*CPU 97%/);
  const tuned = fixture({ load: { minFreeMemoryMb: 100, maxCpuPercent: 99 } });
  tuned.sample.value = { freeMemoryMb: 500, cpuBusyPercent: 97 };
  expect((await tuned.status()).hold).toBeUndefined();
});

test("the project lane cap holds a new start", async () => {
  const f = fixture({}, { max: 2 });
  expect((await f.status()).hold).toMatch(/^hold: .*lane cap 2/);
  const roomy = fixture({}, { max: 3 });
  expect((await roomy.status()).hold).toBeUndefined();
});

test("lanes.autopilot.enabled false makes every lane.next pause", async () => {
  const f = fixture({ enabled: false });
  const actions = await f.all();
  expect(actions.map((action) => action.kind)).toEqual(["pause", "pause"]);
  expect(await f.next({ id: "work-2" })).toMatchObject({ kind: "pause" });
  expect((await f.status()).enabled).toBe(false);
  expect(f.ghCalls).toHaveLength(0);
});

// A fresh process per call, against the real store: only the on-disk state survives.
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
let root: string;
let repo: string;
type Envelope = {
  ok: boolean;
  result: Record<string, unknown>;
  error?: { code: string; message: string };
};
function git(args: string[], cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function call(op: string, input: unknown, session: string): Envelope {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.FORGE_DEVICE_ROOT = join(root, "device");
  env.FORGE_SESSION = session;
  const result = spawnSync(
    "node",
    [bin, ...op.split("."), "--input", JSON.stringify(input)],
    { cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 90000 },
  );
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout) as Envelope;
}
const brief = ".worktrees/briefs/guard.md";
function prepare() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-guard-")));
  const origin = join(root, "origin.git");
  repo = join(root, "project");
  git(["init", "--bare", "--initial-branch=main", origin], root);
  git(["clone", origin, repo], root);
  git(["config", "user.name", "Lane test"]);
  git(["config", "user.email", "lane@example.test"]);
  writeFileSync(join(repo, "tracked"), "base\n");
  git(["add", "tracked"]);
  git(["commit", "-m", "base"]);
  git(["push", "origin", "main"]);
  git(["remote", "set-head", "origin", "main"]);
  mkdirSync(join(repo, ".forge"));
  writeFileSync(
    join(repo, ".forge/config.yaml"),
    "schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample, lanes: { autopilot: { receiptChecks: [typecheck] } } }\n",
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(
    join(repo, brief),
    [
      "Goal",
      "Acceptance test",
      "Files",
      "Forbidden actions",
      "Stop point",
      "Prior art",
    ]
      .map((name) => `## ${name}\nConcrete content.\n`)
      .join("\n"),
  );
}
test("a stop survives restarts, and resume needs a relayed owner approval", () => {
  prepare();
  try {
    const lanes: string[] = [];
    for (const title of ["One", "Two"]) {
      const created = call("issue.create", { title }, "first");
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const id = String(created.result.id);
      const started = call(
        "lane.start",
        { id, branch: `feat/${id}`, brief },
        "first",
      );
      expect(started.ok, JSON.stringify(started)).toBe(true);
      lanes.push(id);
    }
    const stopped = call("lane.stop", { all: true }, "first");
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);

    const next = call("lane.next", { all: true }, "second");
    expect(next.ok, JSON.stringify(next)).toBe(true);
    const actions = next.result.actions as Action[];
    expect(actions.map((action) => action.kind)).toEqual(["pause", "pause"]);
    expect(actions.map((action) => action.lane).toSorted()).toEqual(
      lanes.toSorted(),
    );

    const bare = call("lane.resume", { all: true }, "second");
    expect(bare.ok).toBe(false);
    expect(bare.error?.code).toBe("APPROVAL_REQUIRED");
    const request = (bare.result as { request?: { id?: string } }).request;
    expect(request?.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      (call("lane.status", {}, "third").result as unknown as Status).stopped,
    ).toBe(true);

    const approval = {
      request: request!.id,
      quote: "yes, resume the lanes",
      source: { harness: "codex", thread: "owner-chat", message: "m1" },
    };
    const resumed = call("lane.resume", { all: true, approval }, "second");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    const status = call("lane.status", {}, "third").result as unknown as Status;
    expect(status.stopped).toBe(false);
    expect(status.lanes).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
