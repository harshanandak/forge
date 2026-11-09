import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";

type Handler = (call: {
  input: Record<string, unknown>;
  config: unknown;
  services: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Promise<{ base: string }>;
let start: Handler;
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  const operations = require(
    resolve(import.meta.dirname, "../../../src/blocks/work/entry.cts"),
  ) as Record<string, Handler>;
  start = operations["lane.start"]!;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

const brief = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
]
  .map((name) => `## ${name}\nConcrete content.\n`)
  .join("\n");

function fixture() {
  const calls: string[][] = [],
    refs = new Set<string>(),
    hooks = {
      afterFetch: undefined as (() => void) | undefined,
      failRevParse: false,
      failUpdateRef: false,
      refuse: false,
    };
  let pinned = "";
  const services = {
    state: {
      acquire() {},
      lease() {},
      get: () => ({ value: { id: "work-1", status: "open", dependsOn: [] } }),
    },
    files: {
      root: "/project",
      read: (path: string) => (path === "forge-lanes.json" ? undefined : brief),
      write() {},
      lock: () => ({ release() {} }),
    },
    environment: { platform: "linux", select: () => ({}) },
    crypto: { randomUUID: () => "invocation-1" },
    process: {
      resolve: () => ({ kind: "resolved", path: "git" }),
      run: (
        _git: unknown,
        args: string[],
        options?: { signal?: AbortSignal },
      ) => {
        // A cancelled or expired invocation refuses every further process call.
        if (hooks.refuse || options?.signal?.aborted)
          return Promise.reject(new Error(`SERVICE_EXPIRED: ${args[0]}`));
        calls.push(args);
        let stdout = "",
          exitCode = 0;
        if (args[0] === "fetch") {
          pinned = args[2]!.split(":")[1]!;
          refs.add(pinned);
          hooks.afterFetch?.();
        } else if (args[0] === "update-ref") {
          if (hooks.failUpdateRef) exitCode = 1;
          else refs.delete(args[2]!);
        } else if (args[0] === "for-each-ref") stdout = [...refs].join("\n");
        else if (args[0] === "check-ref-format") stdout = "feat/test";
        else if (args[0] === "rev-parse") {
          if (hooks.failRevParse) exitCode = 1;
          stdout =
            args[2] === pinned + "^{commit}" ? "a".repeat(40) : "b".repeat(40);
        } else if (args[0] === "worktree" && args[1] === "list")
          stdout = "worktree /project\0branch refs/heads/main\0\0";
        return Promise.resolve({
          exitCode,
          stdout,
          stderr: exitCode ? "boom" : "",
          timedOut: false,
          truncated: false,
        });
      },
    },
  };
  const run = (call: { signal?: AbortSignal; deadline?: number } = {}) =>
    start({
      input: { id: "work-1", branch: "feat/test", brief: "brief.md" },
      config: { lanes: { base: "main" } },
      services,
      signal: call.signal ?? new AbortController().signal,
      deadline: call.deadline ?? Number.MAX_SAFE_INTEGER,
    });
  return { calls, refs, hooks, run };
}

test("the base fetch writes only its own ref", async () => {
  const f = fixture();
  await f.run();
  const fetch = f.calls.find((args) => args[0] === "fetch");
  expect(fetch?.slice(3)).toEqual(["--refmap=", "--no-tags", "--no-prune"]);
}, 30_000);

/** The next start runs well after a call that was cancelled or timed out. */
async function runLater(f: ReturnType<typeof fixture>) {
  const realNow = Date.now;
  f.hooks.refuse = false;
  f.hooks.afterFetch = undefined;
  Date.now = () => realNow() + 2 * 3600000;
  try {
    await f.run();
  } finally {
    Date.now = realNow;
  }
}

test("a signal aborted right after the fetch reports the original error and the next start removes the leftover ref", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.hooks.afterFetch = () => {
    controller.abort();
    f.hooks.refuse = true;
  };
  await expect(f.run({ signal: controller.signal })).rejects.toThrow(
    "SERVICE_EXPIRED: rev-parse",
  );
  await runLater(f);
  expect(f.refs.size).toBe(0);
}, 30_000);

test("a deadline that expires right after the fetch reports the original error and the next start removes the leftover ref", async () => {
  const f = fixture(),
    realNow = Date.now,
    deadline = Date.now() + 60_000;
  try {
    f.hooks.afterFetch = () => {
      Date.now = () => deadline + 1;
      f.hooks.refuse = true;
    };
    await expect(f.run({ deadline })).rejects.toThrow("INVOCATION_TIMEOUT");
    Date.now = realNow;
    await runLater(f);
    expect(f.refs.size).toBe(0);
  } finally {
    Date.now = realNow;
  }
}, 30_000);

test("a failed cleanup does not replace the original error", async () => {
  const f = fixture();
  f.hooks.failRevParse = true;
  f.hooks.failUpdateRef = true;
  await expect(f.run()).rejects.toThrow("git rev-parse failed");
}, 30_000);

test("the next start removes a stale private ref and keeps a fresh one", async () => {
  const f = fixture(),
    fresh = `refs/forge/lane-base/${Date.now()}-fresh`;
  f.refs.add("refs/forge/lane-base/1-stale");
  f.refs.add(fresh);
  await f.run();
  expect([...f.refs]).toEqual([fresh]);
}, 30_000);
