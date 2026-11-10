import { expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly } from "../../../src/assembly/index.ts";
import * as providers from "../../../src/assembly/providers.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createCloneFilesLease } from "../../../src/adapters/fs/clone-files.ts";
import { StateOwner } from "../../../src/core/state/index.ts";

const namespace = "forge/work",
  head = "a".repeat(40),
  merge = "b".repeat(40);
const actor = { kind: "agent" as const, id: "worker" };
const session = { id: "release", device: "fixture" };

/** Real assembly, schemas and state authority; only clone files and external commands are fake. */
async function fixture(realLocks = false) {
  const folder = mkdtempSync(join(tmpdir(), "forge-release-")),
    root = join(folder, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        work: {
          source: { builtin: "forge/work" },
          config: { idPrefix: "sample", lanes: { base: "main" } },
        },
      },
    }),
  );
  const source = fileURLToPath(firstPartyBlocks["forge/work"]!),
    target = join(folder, "work");
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  writeFileSync(
    join(target, "entry.cjs"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(source, "entry.cts"), "utf8"),
    ),
  );
  const lane = {
    issue: "work-1",
    branch: "feature",
    worktree: join(root, ".worktrees", "feature"),
    brief: "",
    base: head,
  };
  const files = new Map([["forge-lanes.json", JSON.stringify([lane])]]);
  const flags = {
    present: true,
    branch: true,
    locked: false,
    merged: false,
    dropped: false,
    localHead: head,
    registeredWorktree: lane.worktree,
    registeredBranch: lane.branch,
    canonicalWorktree: lane.worktree,
    indexEntries: "H visible.txt\0",
    truncateIndex: false,
    timeoutIndex: false,
    evidence: undefined as
      { command: string; mode: "incomplete" | "missing" } | undefined,
    afterRead: undefined as (() => void) | undefined,
    duringRemove: undefined as (() => Promise<void>) | undefined,
    failRemove: false,
  };
  const calls: string[][] = [];
  const limits: { args: string[]; maxOutputBytes: number }[] = [];
  const mutations: string[] = [];
  const process: providers.ProcessService = {
    cwd: root,
    capability: "forge.process/v1",
    resolve: (path) => ({ kind: "resolved", path }),
    async run(_executable, args, options) {
      calls.push([...args]);
      limits.push({ args: [...args], maxOutputBytes: options.maxOutputBytes });
      let stdout = "",
        exitCode = 0;
      if (
        ["fetch", "update-ref", "merge", "reset"].includes(args[0]!) ||
        (args[0] === "branch" && args.some((arg) => /^-[dD]$/.test(arg))) ||
        (args[0] === "worktree" && args[1] === "remove")
      )
        mutations.push(args.join(" "));
      if (args[0] === "pr")
        stdout = JSON.stringify({
          state: flags.dropped ? "CLOSED" : "MERGED",
          headRefName: lane.branch,
          baseRefName: "main",
          headRefOid: head,
          mergeCommit: flags.dropped ? null : { oid: merge },
          url: "https://github.com/example/repo/pull/1",
        });
      else if (args[0] === "worktree" && args[1] === "list")
        stdout = `worktree ${root}\0branch refs/heads/main\0\0worktree ${flags.registeredWorktree}\0branch refs/heads/${flags.registeredBranch}\0\0`;
      else if (args[0] === "worktree" && args[1] === "remove") {
        await flags.duringRemove?.();
        if (flags.failRemove) throw new Error("remove refused");
        flags.present = false;
      } else if (args[0] === "update-ref" && args[2] === "refs/heads/feature")
        flags.branch = false;
      else if (args[0] === "branch" && args.some((arg) => /^-[dD]$/.test(arg)))
        flags.branch = false;
      else if (args.includes("--is-inside-work-tree")) {
        stdout = "true";
        exitCode = flags.present ? 0 : 1;
      } else if (args.includes("symbolic-ref"))
        stdout = args.includes("refs/remotes/origin/HEAD")
          ? "refs/remotes/origin/main"
          : lane.branch;
      else if (args[0] === "for-each-ref")
        stdout = args[2]?.startsWith("refs/forge/")
          ? ""
          : flags.branch
            ? "refs/heads/feature"
            : "";
      else if (args.includes("--show-toplevel"))
        stdout = args[0] === "-C" ? flags.canonicalWorktree : root;
      else if (args[0] === "rev-parse") stdout = flags.localHead;
      else if (args[0] === "ls-files") stdout = flags.indexEntries;
      else if (args[0] === "merge-base") {
        stdout = args[1] === "--is-ancestor" ? "" : args[1]!;
        exitCode = flags.merged ? 0 : 1;
      }
      // Like the real runner, cut output at the caller's cap and report truncation.
      let truncated = flags.truncateIndex && args[0] === "ls-files";
      if (Buffer.byteLength(stdout) > options.maxOutputBytes) {
        truncated = true;
        stdout = stdout.slice(0, options.maxOutputBytes);
      }
      // The hook runs after the command yields, while the lane lock must still be held.
      await Promise.resolve();
      const hook = flags.afterRead;
      flags.afterRead = undefined;
      hook?.();
      const stream = (complete: boolean) => ({
        head: "",
        tail: "",
        encoding: "base64" as const,
        totalBytes: Buffer.byteLength(stdout),
        digest: "sha256:fixture",
        complete,
      });
      const mark = flags.evidence;
      const evidence = mark && mark.command === args[0] ? mark.mode : undefined;
      return {
        stdout,
        stderr: "",
        exitCode,
        signal: null,
        timedOut: flags.timeoutIndex && args[0] === "ls-files",
        truncated,
        durationMs: 0,
        ...(evidence === "missing"
          ? {}
          : {
              outputEvidence: {
                stdout: stream(evidence !== "incomplete"),
                stderr: stream(true),
              },
            }),
      };
    },
  };
  const locks = realLocks
    ? createCloneFilesLease({
        projectRoot: root,
        gitDirectory: root,
        commonDirectory: root,
        read: true,
        write: true,
        signal: new AbortController().signal,
        processStartTime: () => "linux-starttime-v1:200",
      })
    : undefined;
  const cloneFiles: providers.FilesService = {
    root,
    roots: { project: root, git: root, common: root },
    read: (path) => files.get(path),
    write: (path, text) => {
      mutations.push(`write ${path}`);
      files.set(path, text);
    },
    remove: (path) => {
      mutations.push(`remove ${path}`);
      files.delete(path);
    },
    inspect: () => undefined,
    list: () => [],
    lock: (paths, options) => {
      const held = locks?.service.lock(paths, options);
      flags.locked = true;
      return {
        release: () => {
          held?.release();
          flags.locked = false;
        },
      };
    },
    snapshot: () => Promise.resolve({ head, filesDigest: head }),
  };
  const open = blockCapture.open.bind(blockCapture),
    factory = providers.createAssemblyProviders;
  const mocks = [
    spyOn(blockCapture, "open").mockImplementation((path) =>
      open(path === source ? target : path),
    ),
    spyOn(providers, "projectStateRoot").mockResolvedValue(root),
    spyOn(providers, "checkoutScopeRoot").mockResolvedValue(root),
    spyOn(providers, "idPrefixObservation").mockResolvedValue([]),
    spyOn(providers, "createAssemblyProviders").mockImplementation(
      (...args) => ({
        ...factory(...args),
        process: () => process,
        openFiles: () =>
          Promise.resolve({
            ownership: "owned" as const,
            value: cloneFiles,
            close: () => Promise.resolve(),
          }),
      }),
    ),
  ];
  const assembly = await createAssembly({
    root,
    deviceRoot: join(folder, "device"),
    providers: { env: {} },
  });
  let request = 0;
  const invoke = (op: string, input: object, leased = false) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `release-${++request}`,
      op,
      input,
      caller: "agent",
      context: {
        actor,
        session,
        project: { id: root, root },
        ...(leased ? { leaseGeneration: 1 } : {}),
      },
    });
  const created = await invoke("issue.create", { title: "Release" });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const opened = await createSqliteStore(folder).open({
    path: join(root, ".forge", "state.sqlite"),
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const owner = new StateOwner(opened.handle.value, { now: () => Date.now() });
  const change = (extra: object) => {
    const row = owner.get(namespace, "issue:work-1")!;
    owner.put(
      namespace,
      row.key,
      { ...(row.value as object), ...extra },
      actor,
      { expectRevision: row.revision },
    );
  };
  change({ status: "closed", withoutReceipt: "closed by hand" });
  const snapshot = () =>
    JSON.stringify({
      files: [...files],
      present: flags.present,
      branch: flags.branch,
    });
  return {
    root,
    lane,
    flags,
    calls,
    limits,
    mutations,
    files,
    owner,
    change,
    invoke,
    snapshot,
    cloneFiles,
    claim: () =>
      owner.acquire(
        namespace,
        "issue:work-1",
        { actor, session },
        60_000,
        `claim-${++request}`,
      ),
    async close() {
      locks?.close();
      await opened.handle.close();
      await assembly.close();
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test("release through the assembly needs no lease, removes the lane and preserves its unmerged branch", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.flags.present).toBe(false);
    expect(f.flags.branch).toBe(true);
    expect(JSON.parse(f.files.get("forge-lanes.json")!)).toEqual([]);
    expect(JSON.stringify(result.result)).toMatch(/feature/);
    expect(JSON.stringify(result.result)).toMatch(/kept|retain/i);
    expect(f.owner.get(namespace, "issue:work-1")!.value).toMatchObject({
      status: "closed",
    });
  } finally {
    await f.close();
  }
}, 30_000);

for (const reason of ["open", "live lease", "receipt"] as const) {
  test(`assembly release refuses ${reason} without git or file mutations`, async () => {
    const f = await fixture();
    try {
      if (reason === "open") f.change({ status: "open" });
      if (reason === "live lease") f.claim();
      if (reason === "receipt") f.change({ receipt: "proof" });
      const before = f.snapshot();
      const result = await f.invoke("lane.release", { id: "sample-1" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INPUT_CONFLICT" },
      });
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const [flag, tag] of [
  ["assume-unchanged", "h"],
  ["skip-worktree", "S"],
] as const) {
  test(`assembly release refuses ${flag} before status or cleanup`, async () => {
    const f = await fixture();
    try {
      f.flags.indexEntries = `H visible.txt\0${tag} hidden.txt\0`;
      const before = f.snapshot();
      const result = await f.invoke("lane.release", { id: "sample-1" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INPUT_CONFLICT",
          message:
            "Clear assume-unchanged or skip-worktree flags before releasing the lane",
        },
      });
      expect(f.calls).toContainEqual(["ls-files", "-v", "-z"]);
      expect(f.calls.some((args) => args[0] === "status")).toBe(false);
      expect(
        f.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
      ).toBe(false);
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const path of [
  "traversal",
  "outside",
  "another lane",
  "root folder",
  "symlink escape",
] as const) {
  test(`assembly release refuses ${path} without git mutation or registry write`, async () => {
    const f = await fixture();
    try {
      const target =
        path === "traversal"
          ? `${f.root}/.worktrees/../outside`
          : path === "outside"
            ? join(f.root, "outside")
            : path === "root folder"
              ? join(f.root, ".worktrees")
              : join(f.root, ".worktrees", "other");
      f.flags.canonicalWorktree =
        path === "symlink escape" || path === "traversal"
          ? join(f.root, "outside")
          : target;
      f.flags.registeredWorktree = f.flags.canonicalWorktree;
      f.flags.registeredBranch = path === "another lane" ? "other" : "feature";
      f.files.set(
        "forge-lanes.json",
        JSON.stringify([
          { ...f.lane, worktree: target },
          ...(path === "another lane"
            ? [
                {
                  ...f.lane,
                  issue: "work-2",
                  worktree: target,
                  branch: "other",
                },
              ]
            : []),
        ]),
      );
      const before = f.snapshot();
      const result = await f.invoke("lane.release", { id: "sample-1" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INPUT_CONFLICT" },
      });
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const race of ["reopened", "claimed"] as const) {
  test(`assembly release refuses an issue ${race} after its first awaited git read`, async () => {
    const f = await fixture();
    try {
      let injected = false;
      f.flags.afterRead = () => {
        expect(f.flags.locked).toBe(true);
        injected = true;
        if (race === "reopened") f.change({ status: "open" });
        else f.claim();
      };
      const before = f.snapshot();
      const result = await f.invoke("lane.release", { id: "sample-1" });
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INPUT_CONFLICT" },
      });
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const mode of ["keep-open", "dropped"] as const) {
  test(`assembly refuses lane close with ${mode} before any mutating git call`, async () => {
    const f = await fixture();
    try {
      if (mode === "keep-open") f.claim();
      else {
        f.change({ status: "open" });
        f.owner.acquire(
          namespace,
          "issue:work-1",
          { actor, session: { ...session, id: "other" } },
          60_000,
          "foreign",
        );
        f.flags.localHead = "c".repeat(40);
      }
      f.flags.dropped = mode === "dropped";
      f.flags.merged = true;
      const before = f.snapshot();
      const result = await f.invoke(
        "lane.close",
        {
          id: "sample-1",
          pr: 1,
          ...(mode === "dropped"
            ? { dropped: "Superseded" }
            : {
                receipt: "proof",
                ...(mode === "keep-open" ? { keepOpen: true } : {}),
              }),
        },
        true,
      );
      expect(result.ok, JSON.stringify(result)).toBe(false);
      expect(f.calls.length).toBeGreaterThan(0);
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

const lsFilesLimit = 33_554_432,
  defaultLimit = 262_144,
  tooMany = "Too many tracked files to verify flags; release the lane by hand";
const clean = (bytes: number) =>
  "H clean-file-name.txt\0".repeat(Math.ceil(bytes / 22));

const cleanupReservation = "forge-lane-cleanup-work-1.lock";

for (const failRemove of [false, true]) {
  test(`claim during removal refuses with a retry hint and cleanup unlocks after ${failRemove ? "failure" : "success"}`, async () => {
    const f = await fixture(true);
    try {
      let attempted = false;
      let reserved = false;
      let competingClaim: Awaited<ReturnType<typeof f.invoke>> | undefined;
      f.flags.failRemove = failRemove;
      f.flags.duringRemove = async () => {
        attempted = true;
        try {
          f.cloneFiles
            .lock([cleanupReservation], { recoverDeadOwner: true })
            .release();
        } catch {
          reserved = true;
        }
        competingClaim = await f.invoke("issue.claim", { id: "sample-1" });
        expect(f.owner.get(namespace, "issue:work-1")!.value).toMatchObject({
          status: "closed",
        });
        expect(f.owner.lease(namespace, "issue:work-1")).toBeUndefined();
        expect(f.flags.present).toBe(true);
      };
      const released = await f.invoke("lane.release", { id: "sample-1" });
      expect(attempted).toBe(true);
      expect(reserved).toBe(true);
      expect(competingClaim).toMatchObject({
        ok: false,
        error: { code: "INPUT_CONFLICT", retry: "reconcile_first" },
      });
      if (!competingClaim || competingClaim.ok)
        throw new Error("Claim was not refused during cleanup");
      expect(competingClaim.error.message).toMatch(/cleanup.*retry/i);
      expect(released.ok).toBe(!failRemove);
      expect(f.flags.present).toBe(failRemove);
      expect(JSON.parse(f.files.get("forge-lanes.json")!)).toHaveLength(
        failRemove ? 1 : 0,
      );
      f.change({ status: "open" });
      const claimed = await f.invoke("issue.claim", { id: "sample-1" });
      expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
      expect(existsSync(join(f.root, cleanupReservation))).toBe(false);
    } finally {
      await f.close();
    }
  }, 30_000);
}

test("claim recovers a cleanup reservation left by a dead process generation", async () => {
  const f = await fixture(true);
  try {
    f.change({ status: "open" });
    const path = join(f.root, cleanupReservation);
    mkdirSync(path);
    writeFileSync(
      join(path, `owner-${process.pid}-11111111-2222-4333-8444-555555555555`),
      JSON.stringify({ startTime: "linux-starttime-v1:100" }),
    );
    const claimed = await f.invoke("issue.claim", { id: "sample-1" });
    expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
    expect(existsSync(path)).toBe(false);
  } finally {
    await f.close();
  }
}, 30_000);

test("a live cleanup reservation refuses an open issue claim without acquiring a lease", async () => {
  const f = await fixture(true);
  const held = f.cloneFiles.lock([cleanupReservation], {
    recoverDeadOwner: true,
  });
  try {
    f.change({ status: "open" });
    const claimed = await f.invoke("issue.claim", { id: "sample-1" });
    expect(claimed).toMatchObject({
      ok: false,
      error: { code: "INPUT_CONFLICT", retry: "reconcile_first" },
    });
    if (claimed.ok) throw new Error("Claim succeeded during cleanup");
    expect(claimed.error.message).toMatch(/cleanup.*retry/i);
    expect(f.owner.lease(namespace, "issue:work-1")).toBeUndefined();
  } finally {
    held.release();
    await f.close();
  }
}, 30_000);

test("release proceeds when a clean ls-files reply exceeds the default git output cap", async () => {
  const f = await fixture();
  try {
    f.flags.indexEntries = clean(defaultLimit * 2);
    expect(f.flags.indexEntries.length).toBeGreaterThan(defaultLimit);
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.flags.present).toBe(false);
    expect(JSON.parse(f.files.get("forge-lanes.json")!)).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("release refuses a flagged entry placed after the first default-cap bytes", async () => {
  const f = await fixture();
  try {
    f.flags.indexEntries = `${clean(defaultLimit * 2)}h hidden.txt\0`;
    const before = f.snapshot();
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INPUT_CONFLICT",
        message:
          "Clear assume-unchanged or skip-worktree flags before releasing the lane",
      },
    });
    expect(f.calls.some((args) => args[0] === "status")).toBe(false);
    expect(f.snapshot()).toBe(before);
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

for (const mode of ["reported truncation", "output over the cap"] as const) {
  test(`release refuses with the too-many-files message on ${mode}`, async () => {
    const f = await fixture();
    try {
      if (mode === "reported truncation") f.flags.truncateIndex = true;
      else f.flags.indexEntries = `H ${"a".repeat(lsFilesLimit)}\0`;
      const before = f.snapshot();
      const result = await f.invoke("lane.release", { id: "sample-1" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INPUT_CONFLICT", message: tooMany },
      });
      expect(f.calls.some((args) => args[0] === "status")).toBe(false);
      expect(
        f.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
      ).toBe(false);
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}

// A reported truncation below the cap with unfinished pipes is incomplete output, not too many files.
test("release names incomplete output when ls-files is truncated below the cap with incomplete evidence", async () => {
  const f = await fixture();
  try {
    f.flags.truncateIndex = true;
    f.flags.evidence = { command: "ls-files", mode: "incomplete" };
    f.flags.indexEntries = "H visible.txt";
    const before = f.snapshot();
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INPUT_CONFLICT",
        message: "Git output was incomplete; inspect the lane before releasing",
      },
    });
    expect(
      f.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
    ).toBe(false);
    expect(f.calls.some((args) => args[0] === "status")).toBe(false);
    expect(f.snapshot()).toBe(before);
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("release keeps the too-many-files message when ls-files is truncated with complete evidence", async () => {
  const f = await fixture();
  try {
    f.flags.truncateIndex = true;
    f.flags.indexEntries = "H visible.txt";
    const before = f.snapshot();
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INPUT_CONFLICT", message: tooMany },
    });
    expect(f.snapshot()).toBe(before);
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("release reports UNAVAILABLE when ls-files times out, even with truncation and incomplete evidence", async () => {
  const f = await fixture();
  try {
    f.flags.timeoutIndex = true;
    f.flags.truncateIndex = true;
    f.flags.evidence = { command: "ls-files", mode: "incomplete" };
    const before = f.snapshot();
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Git timed out or exceeded the lane output limit",
      },
    });
    expect(
      f.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
    ).toBe(false);
    expect(f.snapshot()).toBe(before);
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("only the ls-files check gets the larger output cap", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke("lane.release", { id: "sample-1" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const flagged = f.limits.filter((row) => row.args[0] === "ls-files");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.maxOutputBytes).toBe(lsFilesLimit);
    const others = f.limits.filter((row) => row.args[0] !== "ls-files");
    expect(others.length).toBeGreaterThan(1);
    for (const row of others) expect(row.maxOutputBytes).toBe(defaultLimit);
  } finally {
    await f.close();
  }
}, 30_000);

for (const [command, mode] of [
  ["ls-files", "incomplete"],
  ["status", "incomplete"],
  ["ls-files", "missing"],
  ["status", "missing"],
] as const) {
  test(`release refuses when ${command} output evidence is ${mode}`, async () => {
    const f = await fixture();
    try {
      f.flags.evidence = { command, mode };
      // An unread tail could hold a flagged entry or dirty work; the prefix alone looks clean.
      f.flags.indexEntries = "H visible.txt ";
      const before = f.snapshot();
      const result = await f.invoke("lane.release", { id: "sample-1" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INPUT_CONFLICT",
          message:
            "Git output was incomplete; inspect the lane before releasing",
        },
      });
      expect(
        f.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
      ).toBe(false);
      expect(f.snapshot()).toBe(before);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);
}
