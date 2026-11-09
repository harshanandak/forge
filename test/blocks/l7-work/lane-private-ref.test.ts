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
  // Names of the exclusion locks a call holds right now.
  const held = new Set<string>();
  // The handler reads time from this clock; tests never touch the global Date.
  const time = { value: Date.now() };
  const services = {
    clock: { now: () => time.value },
    state: {
      acquire() {},
      lease() {},
      get: () => ({ value: { id: "work-1", status: "open", dependsOn: [] } }),
    },
    files: {
      root: "/project",
      read: (path: string) => (path === "forge-lanes.json" ? undefined : brief),
      write() {},
      lock: ([name]: string[]) => {
        if (held.has(name!)) throw new Error(`held: ${name}`);
        held.add(name!);
        return { release: () => void held.delete(name!) };
      },
    },
    environment: { platform: "linux", select: () => ({}) },
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
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
  return { calls, refs, held, hooks, run, time };
}

test("the base fetch writes only its own ref", async () => {
  const f = fixture();
  await f.run();
  const fetch = f.calls.find((args) => args[0] === "fetch");
  expect(fetch?.slice(3)).toEqual([
    "--refmap=",
    "--no-tags",
    "--no-prune",
    "--no-recurse-submodules",
  ]);
}, 30_000);

/** The next start runs well after a call that was cancelled or timed out. */
async function runLater(f: ReturnType<typeof fixture>) {
  f.hooks.refuse = false;
  f.hooks.afterFetch = undefined;
  f.time.value += 2 * 3600000;
  await f.run();
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
    deadline = f.time.value + 60_000;
  f.hooks.afterFetch = () => {
    f.time.value = deadline + 1;
    f.hooks.refuse = true;
  };
  await expect(f.run({ deadline })).rejects.toThrow("INVOCATION_TIMEOUT");
  await runLater(f);
  expect(f.refs.size).toBe(0);
}, 30_000);

test("a failed cleanup does not replace the original error", async () => {
  const f = fixture();
  f.hooks.failRevParse = true;
  f.hooks.failUpdateRef = true;
  await expect(f.run()).rejects.toThrow("git rev-parse failed");
}, 30_000);

test("the next start removes a stale private ref and keeps a fresh one", async () => {
  const f = fixture(),
    fresh = `refs/forge/lane-base/${f.time.value}-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
  f.refs.add("refs/forge/lane-base/1-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  f.refs.add(fresh);
  await f.run();
  expect([...f.refs]).toEqual([fresh]);
}, 30_000);

const own = "forge-lane-ref-11111111-2222-4333-8444-555555555555.lock";
const stale = (ms: number, uuid: string) =>
  `refs/forge/lane-base/${ms}-${uuid}`;

test("the start holds an exclusion lock for its ref while it fetches and releases it after", async () => {
  const f = fixture();
  let heldDuringFetch = false;
  f.hooks.afterFetch = () => {
    heldDuringFetch = f.held.has(own);
  };
  await f.run();
  expect(heldDuringFetch).toBe(true);
  expect(f.held.size).toBe(0);
}, 30_000);

test("the sweep keeps a ref older than an hour while its owner still holds the lock", async () => {
  const f = fixture(),
    uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    behind = stale(f.time.value - 3 * 3600000, uuid);
  f.refs.add(behind);
  f.held.add(`forge-lane-ref-${uuid}.lock`);
  await f.run();
  expect([...f.refs]).toEqual([behind]);
}, 30_000);

test("the sweep removes a ref dated more than an hour ahead when no owner holds it", async () => {
  const f = fixture(),
    ahead = stale(
      f.time.value + 3 * 3600000,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  f.refs.add(ahead);
  await f.run();
  expect(f.refs.size).toBe(0);
}, 30_000);

test("the sweep keeps a ref dated more than an hour ahead while its owner holds the lock", async () => {
  const f = fixture(),
    uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ahead = stale(f.time.value + 3 * 3600000, uuid);
  f.refs.add(ahead);
  f.held.add(`forge-lane-ref-${uuid}.lock`);
  await f.run();
  expect([...f.refs]).toEqual([ahead]);
}, 30_000);
