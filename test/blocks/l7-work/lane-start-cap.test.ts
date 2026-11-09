import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { BoundContext } from "../../../src/generated/types.ts";

type Handler = (call: {
  input: Record<string, unknown>;
  config: unknown;
  services: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Promise<{ issue: string }>;
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

const namespace = "forge/work";
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
const worktree = (n: number) => `/project/.worktrees/work-${n}`;

/** A real state owner holding the issues, and a registry of lanes over a fake git. */
async function fixture(lanes: readonly number[]) {
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
  const state = createStateClient({
    owner,
    namespace,
    context,
    write: true,
    requestId: "start",
  });
  const addIssue = (n: number, extra: object = {}) =>
    owner.put(
      namespace,
      `issue:work-${n}`,
      {
        id: `work-${n}`,
        title: `Lane ${n}`,
        status: "open",
        labels: [],
        dependsOn: [],
        createdAt: new Date(now).toISOString(),
        ...extra,
      },
      holder.actor,
      { expectRevision: 0 },
    );
  const registry = new Map<string, string>([
    [
      "forge-lanes.json",
      JSON.stringify(
        lanes.map((n) => ({
          issue: `work-${n}`,
          branch: `feat/work-${n}`,
          worktree: worktree(n),
          brief: "",
          base: "a".repeat(40),
        })),
      ),
    ],
  ]);
  const services = {
    state: { ...state, now: () => now },
    files: {
      root: "/project",
      roots: { common: "/project/.git" },
      read: (path: string) =>
        registry.get(path) ??
        (path === "info/exclude" ? ".worktrees/\n" : brief),
      write: (path: string, text: string) => {
        registry.set(path, text);
      },
      lock: () => ({ release() {} }),
    },
    environment: { platform: "linux", select: () => ({}) },
    crypto: { randomUUID: () => "invocation-1" },
    process: {
      resolve: () => ({ kind: "resolved", path: "git" }),
      run: (_git: unknown, args: string[]) => {
        let stdout = "";
        if (args[0] === "check-ref-format") stdout = "feat/next";
        else if (args[0] === "rev-parse" && args[1] === "--verify")
          stdout = "a".repeat(40);
        else if (args[0] === "-C") stdout = "true";
        else if (args[0] === "worktree" && args[1] === "list")
          stdout =
            "worktree /project\0branch refs/heads/main\0\0" +
            lanes
              .map(
                (n) =>
                  `worktree ${worktree(n)}\0branch refs/heads/feat/work-${n}\0\0`,
              )
              .join("");
        return Promise.resolve({
          exitCode: 0,
          stdout,
          stderr: "",
          timedOut: false,
          truncated: false,
        });
      },
    },
  };
  return {
    owner,
    holder,
    addIssue,
    close: (n: number) => {
      const issue = owner.get(namespace, `issue:work-${n}`)!;
      owner.put(
        namespace,
        `issue:work-${n}`,
        {
          ...(issue.value as object),
          status: "closed",
          withoutReceipt: "closed by hand",
        },
        holder.actor,
        { expectRevision: issue.revision },
      );
    },
    claim: (n: number) =>
      owner.acquire(namespace, `issue:work-${n}`, holder, 60_000, `claim-${n}`),
    expire: (n: number) => {
      now =
        Date.parse(owner.lease(namespace, `issue:work-${n}`)!.expiresAt) + 1;
    },
    start: (n: number) =>
      operations["lane.start"]!({
        input: { id: `work-${n}`, branch: "feat/next", brief: "brief.md" },
        config: { lanes: { base: "main", max: 3 } },
        services,
        signal: new AbortController().signal,
        deadline: Number.MAX_SAFE_INTEGER,
      }),
    dispose: () => opened.handle.close(),
  };
}

test("three lanes with open issues still hold the cap", async () => {
  const f = await fixture([1, 2, 3]);
  try {
    for (const n of [1, 2, 3, 4]) f.addIssue(n);
    await expect(f.start(4)).rejects.toThrow("LIMIT_REACHED");
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a lane whose issue was closed without a receipt and holds no lease frees its slot", async () => {
  const f = await fixture([1, 2, 3]);
  try {
    for (const n of [1, 2, 3, 4]) f.addIssue(n);
    f.close(1);
    expect((await f.start(4)).issue).toBe("work-4");
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a closed issue that still holds a live lease keeps its slot until the lease ends", async () => {
  const f = await fixture([1, 2, 3]);
  try {
    for (const n of [1, 2, 3, 4]) f.addIssue(n);
    f.claim(1);
    f.close(1);
    await expect(f.start(4)).rejects.toThrow("LIMIT_REACHED");
    f.expire(1);
    expect((await f.start(4)).issue).toBe("work-4");
  } finally {
    await f.dispose();
  }
}, 30_000);

test("a lane whose issue cannot be found keeps its slot", async () => {
  const f = await fixture([1, 2, 9]);
  try {
    for (const n of [1, 2, 4]) f.addIssue(n);
    await expect(f.start(4)).rejects.toThrow("LIMIT_REACHED");
  } finally {
    await f.dispose();
  }
}, 30_000);
