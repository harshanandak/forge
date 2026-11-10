import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCloneFilesLease,
  lockHostIdentity,
} from "../../../src/adapters/fs/clone-files.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import type { CloneMarkerCleanupScheduler } from "../../../src/adapters/fs/clone-files.ts";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  read = true,
  write = true,
  markerCleanup?: CloneMarkerCleanupScheduler,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-file-locks-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  const commonDirectory = join(root, "common");
  const gitDirectory = join(commonDirectory, "worktrees", "linked");
  mkdirSync(projectRoot);
  mkdirSync(gitDirectory, { recursive: true });
  const controller = new AbortController();
  const options = {
    ...(markerCleanup ? { markerCleanup } : {}),
    projectRoot,
    commonDirectory,
    gitDirectory,
    read,
    write,
    signal: controller.signal,
    deadline: Date.now() + 60_000,
  };
  const lease = createCloneFilesLease(options);
  return {
    root,
    projectRoot,
    commonDirectory,
    gitDirectory,
    options,
    controller,
    lease,
    files: lease.service,
  };
}

function scheduledCleanupFixture() {
  let now = 0;
  let sequence = 0;
  let cancellations = 0;
  const jobs = new Map<
    number,
    { callback: () => void; at: number; delay: number; keepAlive: boolean }
  >();
  const scheduler: CloneMarkerCleanupScheduler = {
    now: () => now,
    schedule(callback, delay) {
      const id = ++sequence;
      const job = { callback, at: now + delay, delay, keepAlive: true };
      jobs.set(id, job);
      return {
        unref() {
          job.keepAlive = false;
        },
        cancel() {
          if (jobs.delete(id)) cancellations += 1;
        },
      };
    },
  };
  const context = fixture(true, true, scheduler);
  const markers: string[] = [];
  const restore = (marker: string) => {
    if (existsSync(marker) && lstatSync(marker).isDirectory()) {
      rmSync(marker, { recursive: true });
      writeFileSync(marker, "");
    }
  };
  return {
    ...context,
    jobs,
    cancellations: () => cancellations,
    block(path: string) {
      const held = context.files.lock([path], { recoverDeadOwner: true });
      const target = join(context.commonDirectory, path);
      const marker = join(target, readdirSync(target)[0]!);
      markers.push(marker);
      rmSync(marker);
      mkdirSync(marker);
      expect(() => held.release()).toThrow("Clone lock cleanup failed");
      return { target, marker, restore: () => restore(marker) };
    },
    runNext() {
      const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      expect(next).toBeDefined();
      if (!next) return;
      jobs.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].callback();
    },
    dispose() {
      for (const marker of markers) restore(marker);
      context.lease.close();
      jobs.clear();
    },
  };
}

test("scheduled marker cleanup survives lease close without another lock call and unrefs its timer", () => {
  const context = scheduledCleanupFixture();
  try {
    const blocked = context.block("scheduled.lock");
    expect(() => context.lease.close()).toThrow("Clone lock cleanup failed");
    blocked.restore();
    expect(context.jobs.size).toBe(1);
    expect([...context.jobs.values()].every((job) => !job.keepAlive)).toBe(
      true,
    );
    context.runNext();
    expect(existsSync(blocked.target)).toBe(false);
    expect(context.jobs.size).toBe(0);
  } finally {
    context.dispose();
  }
}, 30_000);

test("marker cleanup backs off from 100ms to a 30s cap using the injected clock", () => {
  const context = scheduledCleanupFixture();
  try {
    context.block("backoff.lock");
    for (const delay of [
      100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000, 30000,
    ]) {
      expect(context.jobs.size).toBe(1);
      expect([...context.jobs.values()][0]?.delay).toBe(delay);
      expect([...context.jobs.values()][0]?.keepAlive).toBe(false);
      context.runNext();
    }
  } finally {
    context.dispose();
  }
}, 30_000);

test.each(["marker", "directory"])(
  "scheduled cleanup preserves a changed %s identity",
  (kind) => {
    const context = scheduledCleanupFixture();
    try {
      const blocked = context.block("identity-retry.lock");
      blocked.restore();
      const name = readdirSync(blocked.target)[0]!;
      if (kind === "directory") {
        renameSync(blocked.target, blocked.target + ".moved");
        mkdirSync(blocked.target);
      } else rmSync(blocked.marker);
      const replacement = kind === "directory" ? name : name + "-replacement";
      writeFileSync(join(blocked.target, replacement), "replacement owner");
      expect(context.jobs.size).toBe(1);
      context.runNext();
      expect(readdirSync(blocked.target)).toEqual([replacement]);
      expect(readFileSync(join(blocked.target, replacement), "utf8")).toBe(
        "replacement owner",
      );
      if (kind === "directory")
        expect(existsSync(join(blocked.target + ".moved", name))).toBe(true);
      expect(context.jobs.size).toBe(0);
    } finally {
      context.dispose();
    }
  },
  30_000,
);

test("a lock call and a scheduled batch each retry at most eight pending markers", () => {
  const context = scheduledCleanupFixture();
  try {
    const blocked = Array.from({ length: 20 }, (_, i) =>
      context.block(`budget-${i}.lock`),
    );
    for (const marker of blocked) marker.restore();
    context.files.lock(["unrelated.lock"]).release();
    const remaining = () =>
      blocked.filter((marker) => existsSync(marker.target)).length;
    expect(remaining()).toBeGreaterThanOrEqual(12);
    expect(context.jobs.size).toBe(1);
    const before = remaining();
    context.runNext();
    expect(before - remaining()).toBeGreaterThan(0);
    expect(before - remaining()).toBeLessThanOrEqual(8);
  } finally {
    context.dispose();
  }
}, 30_000);

test("128 outstanding markers refuse new recoverable paths without dropping recovery duties", () => {
  const context = scheduledCleanupFixture();
  try {
    const blocked = Array.from({ length: 128 }, (_, i) =>
      context.block(`limit-${i}.lock`),
    );
    expect(() => {
      const ordinary = context.files.lock(["ordinary.lock"]);
      expect(existsSync(join(context.commonDirectory, "ordinary.lock"))).toBe(
        true,
      );
      ordinary.release();
    }).not.toThrow();
    expect(existsSync(join(context.commonDirectory, "ordinary.lock"))).toBe(
      false,
    );
    let caughtRefusal: unknown;
    let refusal = "";
    expect(() => {
      try {
        context.files.lock(["over-limit.lock"], { recoverDeadOwner: true });
      } catch (error) {
        caughtRefusal = error;
        refusal = String(error);
        throw error;
      }
    }).toThrow(/LOCK_CLEANUP_LIMIT/);
    expect(caughtRefusal).toMatchObject({
      error: { code: "LOCK_CLEANUP_LIMIT", retry: "safe" },
    });
    expect(refusal).toContain("retry after cleanup");
    for (let i = 0; i < 128; i += 1)
      expect(refusal).not.toContain(`limit-${i}.lock`);
    expect(existsSync(join(context.commonDirectory, "over-limit.lock"))).toBe(
      false,
    );
    expect(blocked.every((marker) => existsSync(marker.marker))).toBe(true);
    for (const marker of blocked) marker.restore();
    for (let batch = 0; batch < 128 && context.jobs.size > 0; batch += 1)
      context.runNext();
    expect(blocked.every((marker) => !existsSync(marker.target))).toBe(true);
    expect(context.jobs.size).toBe(0);
    context.files
      .lock(["over-limit.lock"], { recoverDeadOwner: true })
      .release();
  } finally {
    context.dispose();
  }
}, 30_000);

test("successful explicit cleanup cancels the pending injected timer", () => {
  const context = scheduledCleanupFixture();
  try {
    const blocked = context.block("cancel-retry.lock");
    expect(context.jobs.size).toBe(1);
    blocked.restore();
    context.lease.close();
    expect(context.jobs.size).toBe(0);
    expect(context.cancellations()).toBe(1);
  } finally {
    context.dispose();
  }
}, 30_000);

test("list reads sorted entries in the selected area and permits root '.' only there", () => {
  const { files, projectRoot, gitDirectory, lease } = fixture();
  writeFileSync(join(projectRoot, "z"), "z");
  writeFileSync(join(projectRoot, "a"), "a");
  mkdirSync(join(projectRoot, "empty"));
  writeFileSync(join(gitDirectory, "HEAD"), "head");
  expect(files.list(".", 3)).toEqual(["a", "empty", "z"]);
  expect(files.list("empty", 1)).toEqual([]);
  expect(files.list(".", 1, "git")).toEqual(["HEAD"]);
  expect(() => files.read(".", 10)).toThrow(/INPUT_INVALID/);
  expect(() => files.write(".", "bad")).toThrow(/INPUT_INVALID/);
  lease.close();
});

test("list rejects over-limit directories, invalid caps, non-directories and linked parents", () => {
  const { files, projectRoot, root, lease } = fixture();
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(projectRoot, "alias"), "junction");
  writeFileSync(join(projectRoot, "file"), "x");
  expect(() => files.list(".", 1)).toThrow(/LIMIT_EXCEEDED/);
  for (const path of ["file", "missing", "../outside", "alias", "alias/nested"])
    expect(() => files.list(path, 10)).toThrow(/INPUT_INVALID/);
  for (const cap of [0, -1, 1.5, Number.NaN, 1025])
    expect(() => files.list(".", cap)).toThrow(/INPUT_INVALID/);
  lease.close();
});

test("lock uses native exclusive paths under common and linked-worktree metadata", () => {
  const { files, commonDirectory, gitDirectory, lease } = fixture();
  const paths = [
    join(gitDirectory, "HEAD.lock"),
    join(gitDirectory, "index.lock"),
    join(commonDirectory, "refs", "heads", "main.lock"),
  ];
  const held = files.lock(paths);
  for (const path of paths) expect(existsSync(path)).toBe(true);
  expect(() => files.lock(["fourth.lock"])).toThrow(/LIMIT_EXCEEDED/);
  held.release();
  held.release();
  for (const path of paths) expect(existsSync(path)).toBe(false);
  const relative = files.lock(["relative.lock"]);
  expect(existsSync(join(commonDirectory, "relative.lock"))).toBe(true);
  relative.release();
  lease.close();
});

test("lock validates all authority, suffix, count and uniqueness constraints before side effects", () => {
  const { files, commonDirectory, projectRoot, root, lease } = fixture();
  for (const paths of [
    [join(root, "outside.lock")],
    [join(projectRoot, "project.lock")],
    ["nested/no-suffix"],
    ["../escape.lock"],
    ["same.lock", "same.lock"],
    ["a.lock", "b.lock", "c.lock", "d.lock"],
    ["valid.lock", join(root, "outside.lock")],
  ])
    expect(() => files.lock(paths)).toThrow(/INPUT_INVALID|LIMIT_EXCEEDED/);
  expect(readdirSync(commonDirectory)).toEqual(["worktrees"]);
  lease.close();
});

test("partial lock acquisition rolls back own files and preserves a pre-existing lock", () => {
  const { files, commonDirectory, lease } = fixture();
  writeFileSync(join(commonDirectory, "index.lock"), "existing owner");
  expect(() => files.lock(["HEAD.lock", "index.lock"])).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(false);
  expect(readFileSync(join(commonDirectory, "index.lock"), "utf8")).toBe(
    "existing owner",
  );
  const held = files.lock(["HEAD.lock"]);
  held.release();
  lease.close();
});

test("release preserves a replacement inode even when its content copies the owned nonce", () => {
  const { files, commonDirectory, lease } = fixture();
  const path = join(commonDirectory, "HEAD.lock");
  const held = files.lock(["HEAD.lock"]);
  const nonce = readFileSync(path, "utf8");
  renameSync(path, join(commonDirectory, "moved.lock"));
  writeFileSync(path, nonce);
  held.release();
  expect(readFileSync(path, "utf8")).toBe(nonce);
  lease.close();
});

test("release preserves the original inode if another owner rewrites its nonce", () => {
  const { files, commonDirectory, lease } = fixture();
  const held = files.lock(["HEAD.lock"]);
  writeFileSync(join(commonDirectory, "HEAD.lock"), "replacement owner");
  held.release();
  expect(readFileSync(join(commonDirectory, "HEAD.lock"), "utf8")).toBe(
    "replacement owner",
  );
  lease.close();
});

test("release and lease close clean owned locks after cancellation and synchronous expiry", () => {
  const { files, commonDirectory, controller, options, lease } = fixture();
  const held = files.lock(["HEAD.lock"]);
  files.lock(["index.lock"]);
  options.deadline = Date.now() - 1;
  controller.abort();
  held.release();
  lease.close();
  lease.close();
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(false);
  expect(existsSync(join(commonDirectory, "index.lock"))).toBe(false);
});

test("lease close revokes retained methods and releases locks without requiring abort", () => {
  const { files, commonDirectory, lease } = fixture();
  files.lock(["HEAD.lock"]);
  lease.close();
  for (const operation of [
    () => files.root,
    () => files.read("file", 10),
    () => files.list(".", 10),
    () => files.lock(["index.lock"]),
  ])
    expect(operation).toThrow(/SERVICE_EXPIRED/);
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(false);
});

test("list and lock require their individual effects before touching the clone", () => {
  const { files, commonDirectory, projectRoot, lease } = fixture(false, false);
  expect(() => files.list(".", 10)).toThrow(/EFFECT_UNDECLARED/);
  expect(() => files.lock(["new/HEAD.lock"])).toThrow(/EFFECT_UNDECLARED/);
  expect(readdirSync(commonDirectory)).toEqual(["worktrees"]);
  expect(readdirSync(projectRoot)).toEqual([]);
  lease.close();
});

test("lock refuses linked metadata parents and preserves final replacement links", () => {
  const { files, commonDirectory, root, lease } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(commonDirectory, "alias"), "junction");
  expect(() => files.lock(["alias/HEAD.lock"])).toThrow(/INPUT_INVALID/);
  const held = files.lock(["HEAD.lock"]);
  rmSync(join(commonDirectory, "HEAD.lock"));
  symlinkSync(outside, join(commonDirectory, "HEAD.lock"), "junction");
  held.release();
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(true);
  expect(readdirSync(outside)).toEqual([]);
  lease.close();
});

test("absolute lock aliases resolve to canonical metadata before confinement, including missing suffixes", () => {
  const { files, commonDirectory, root, lease } = fixture();
  const alias = join(root, "metadata-alias");
  symlinkSync(commonDirectory, alias, "junction");
  const held = files.lock([join(alias, "new", "branch.lock")]);
  expect(existsSync(join(commonDirectory, "new", "branch.lock"))).toBe(true);
  held.release();
  expect(existsSync(join(commonDirectory, "new", "branch.lock"))).toBe(false);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const escape = join(commonDirectory, "escape");
  symlinkSync(outside, escape, "junction");
  expect(() => files.lock([join(escape, "HEAD.lock")])).toThrow(
    /INPUT_INVALID/,
  );
  expect(readdirSync(outside)).toEqual([]);
  lease.close();
});

test("recoverable locks preserve live owners and replacement directory generations", () => {
  const { files, commonDirectory, lease } = fixture();
  const path = join(commonDirectory, "coordination.lock");
  const held = files.lock(["coordination.lock"], { recoverDeadOwner: true });
  expect(() =>
    files.lock(["coordination.lock"], { recoverDeadOwner: true }),
  ).toThrow(/INPUT_CONFLICT/);
  renameSync(path, path + ".moved");
  mkdirSync(path);
  writeFileSync(join(path, "other-owner"), "");
  held.release();
  lease.close();
  expect(readdirSync(path)).toEqual(["other-owner"]);
});

test("failed marker removal frees every caller slot, preserves exclusion and retries at shutdown", () => {
  const { files, options, commonDirectory, lease } = fixture();
  const contender = createCloneFilesLease(options);
  const path = join(commonDirectory, "pending.lock");
  const held = files.lock(["pending.lock"], { recoverDeadOwner: true });
  const marker = join(path, readdirSync(path)[0]!);
  const content = readFileSync(marker, "utf8");
  // A directory at the marker path makes unlink fail on every supported platform.
  rmSync(marker);
  mkdirSync(marker);
  try {
    expect(() => held.release()).toThrow();
    expect(existsSync(marker)).toBe(true);
    expect(() =>
      contender.service.lock(["pending.lock"], { recoverDeadOwner: true }),
    ).toThrow(/INPUT_CONFLICT/);
    const full = files.lock(["one.lock", "two.lock", "three.lock"]);
    expect(() => files.lock(["four.lock"])).toThrow(/LIMIT_EXCEEDED/);
    full.release();
  } finally {
    rmSync(marker, { recursive: true });
    writeFileSync(marker, content);
    contender.close();
    lease.close();
  }
  expect(existsSync(path)).toBe(false);
}, 30_000);

test("repeated close retries pending marker cleanup while its owner process is live", () => {
  const { files, options, commonDirectory, lease } = fixture();
  const contender = createCloneFilesLease(options);
  const path = join(commonDirectory, "pending-close.lock");
  files.lock(["pending-close.lock"], { recoverDeadOwner: true });
  const name = readdirSync(path)[0]!;
  expect(name.startsWith(`owner-${process.pid}-`)).toBe(true);
  const marker = join(path, name);
  const content = readFileSync(marker, "utf8");
  rmSync(marker);
  mkdirSync(marker);
  try {
    expect(() => lease.close()).toThrow("Clone lock cleanup failed");
    expect(existsSync(marker)).toBe(true);
    expect(() => files.lock(["other.lock"])).toThrow(/SERVICE_EXPIRED/);
    expect(() =>
      contender.service.lock(["pending-close.lock"], {
        recoverDeadOwner: true,
      }),
    ).toThrow(/INPUT_CONFLICT/);
    rmSync(marker, { recursive: true });
    writeFileSync(marker, content);
    lease.close();
    expect(existsSync(path)).toBe(false);
    const acquired = contender.service.lock(["pending-close.lock"], {
      recoverDeadOwner: true,
    });
    acquired.release();
    lease.close();
    expect(() => files.list(".", 10)).toThrow(/SERVICE_EXPIRED/);
  } finally {
    contender.close();
  }
}, 30_000);

test("close cleanup retry preserves another process's replacement marker", () => {
  const { files, commonDirectory, lease } = fixture();
  const path = join(commonDirectory, "replaced-close.lock");
  files.lock(["replaced-close.lock"], { recoverDeadOwner: true });
  const name = readdirSync(path)[0]!;
  const marker = join(path, name);
  const content = readFileSync(marker, "utf8");
  rmSync(marker);
  mkdirSync(marker);
  expect(() => lease.close()).toThrow("Clone lock cleanup failed");
  rmSync(marker, { recursive: true });
  writeFileSync(marker, content);
  const moved = path + ".moved";
  renameSync(path, moved);
  mkdirSync(path);
  const otherName = `owner-${process.ppid}-00000000-0000-4000-8000-000000000000`;
  writeFileSync(join(path, otherName), "another process");
  lease.close();
  expect(readdirSync(path)).toEqual([otherName]);
  expect(readFileSync(join(path, otherName), "utf8")).toBe("another process");
  expect(readFileSync(join(moved, name), "utf8")).toBe(content);
}, 30_000);

test.each(["restored", "blocked"])(
  "a new lease retries only recorded markers: %s",
  (kind) => {
    const { files, options, commonDirectory, lease } = fixture();
    files.lock(["retry.lock"], { recoverDeadOwner: true });
    const path = join(commonDirectory, "retry.lock");
    const marker = join(path, readdirSync(path)[0]!);
    const content = readFileSync(marker, "utf8");
    rmSync(marker);
    mkdirSync(marker);
    expect(() => lease.close()).toThrow("Clone lock cleanup failed");
    const restore = () => {
      rmSync(marker, { recursive: true });
      writeFileSync(marker, content);
    };
    const unknown = join(commonDirectory, "unrecorded.lock");
    mkdirSync(unknown);
    const name = `owner-${process.pid}-00000000-0000-4000-8000-000000000000`;
    writeFileSync(join(unknown, name), "unrecorded owner");
    if (kind === "restored") restore();
    const next = createCloneFilesLease(options);
    const held = next.service.lock(["own.lock"], { recoverDeadOwner: true });
    expect(existsSync(join(commonDirectory, "own.lock"))).toBe(true);
    held.release();
    expect(existsSync(marker)).toBe(kind === "blocked");
    expect(readdirSync(unknown)).toEqual([name]);
    expect(readFileSync(join(unknown, name), "utf8")).toBe("unrecorded owner");
    if (kind === "blocked") {
      restore();
      next.service.lock(["own.lock"], { recoverDeadOwner: true }).release();
    }
    const third = createCloneFilesLease(options);
    third.service.lock(["retry.lock"], { recoverDeadOwner: true }).release();
    expect(existsSync(path)).toBe(false);
    next.close();
    third.close();
  },
  30_000,
);

test.each([
  "matching",
  "different",
  "unavailable",
  "legacy",
  "different format",
  "unparsable",
  "untagged",
  "unparsable current",
])("recoverable locks compare start times conservatively: %s", (kind) => {
  const { options, commonDirectory, lease } = fixture();
  const owner = createCloneFilesLease({
    ...options,
    hostIdentity: null,
    processStartTime: () => "linux-starttime-v1:100",
  });
  const held = owner.service.lock(["identity.lock"], {
    recoverDeadOwner: true,
  });
  const path = join(commonDirectory, "identity.lock");
  const marker = readdirSync(path)[0]!;
  expect(JSON.parse(readFileSync(join(path, marker), "utf8"))).toEqual({
    startTime: "linux-starttime-v1:100",
  });
  if (kind === "legacy") writeFileSync(join(path, marker), "");
  if (
    kind === "different format" ||
    kind === "unparsable" ||
    kind === "untagged"
  )
    writeFileSync(
      join(path, marker),
      JSON.stringify({
        startTime:
          kind === "different format"
            ? "win32-filetime-v1:100"
            : kind === "untagged"
              ? "100"
              : "linux-starttime-v1:unparsable",
      }),
    );
  const contender = createCloneFilesLease({
    ...options,
    processStartTime: () =>
      kind === "unavailable"
        ? undefined
        : kind === "unparsable current"
          ? "linux-starttime-v1:unparsable"
          : kind === "matching"
            ? "linux-starttime-v1:100"
            : "linux-starttime-v1:101",
  });
  try {
    const acquire = () =>
      contender.service.lock(["identity.lock"], { recoverDeadOwner: true });
    if (kind === "different") {
      const replacement = acquire();
      held.release();
      expect(readdirSync(path)).not.toEqual([marker]);
      replacement.release();
      expect(existsSync(path)).toBe(false);
    } else {
      expect(acquire).toThrow(/INPUT_CONFLICT/);
      expect(readdirSync(path)).toEqual([marker]);
    }
  } finally {
    contender.close();
    owner.close();
    lease.close();
  }
});

test.each([
  { host: "0123456789abcdef", live: false, start: "101", kept: false },
  { host: undefined, live: false, start: "101", kept: false },
  { host: undefined, live: true, start: "101", kept: false },
  { host: "0123456789abcdef", live: true, start: "100", kept: true },
  { host: "0123456789abcdef", live: true, start: "101", kept: false },
  { host: "fedcba9876543210", live: false, start: "101", kept: true },
  { host: "fedcba9876543210", live: true, start: "101", kept: true },
])(
  "recoverable owner host=[$host]; live=[$live]; kept=[$kept]",
  ({ host, live, start, kept }) => {
    const { options, commonDirectory, lease } = fixture();
    const lockPath = "host-owner.lock";
    const path = join(commonDirectory, lockPath);
    const marker = "owner-12345-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const record = JSON.stringify({
      ...(host === undefined ? {} : { hostIdentity: host }),
      startTime: "linux-starttime-v1:100",
    });
    mkdirSync(path);
    writeFileSync(join(path, marker), record);
    const probes: number[] = [];
    const contender = createCloneFilesLease({
      ...options,
      hostIdentity: "0123456789abcdef",
      processProbe(pid) {
        probes.push(pid);
        if (!live) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      },
      processStartTime: () => `linux-starttime-v1:${start}`,
    });
    try {
      const acquire = () =>
        contender.service.lock([lockPath], { recoverDeadOwner: true });
      if (kept) {
        expect(acquire).toThrow();
        expect(readdirSync(path)).toEqual([marker]);
        expect(readFileSync(join(path, marker), "utf8")).toBe(record);
      } else {
        acquire().release();
        expect(existsSync(path)).toBe(false);
      }
      expect(probes).toEqual(host === "fedcba9876543210" ? [] : [12345]);
    } finally {
      contender.close();
      lease.close();
    }
  },
  30_000,
);

test.each([
  {
    label: "normalized",
    input: "  ABC  ",
    expected: "ba7816bf8f01cfea",
  },
  { label: "empty", input: "  ", expected: "unknown" },
  { label: "unavailable", input: undefined, expected: "unknown" },
])(
  "lock host identity handles [$label] hostnames",
  ({ input, expected }) => {
    expect(
      lockHostIdentity(() => {
        if (input === undefined) throw new Error("hostname unavailable");
        return input;
      }),
    ).toBe(expected);
  },
  30_000,
);

test("unknown owner and current host identities never permit dead-owner recovery", () => {
  const { options, commonDirectory, lease } = fixture();
  const path = join(commonDirectory, "unknown-host.lock");
  const marker = "owner-12345-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const record = JSON.stringify({
    hostIdentity: "unknown",
    startTime: "linux-starttime-v1:100",
  });
  mkdirSync(path);
  writeFileSync(join(path, marker), record);
  const probes: number[] = [];
  const contender = createCloneFilesLease({
    ...options,
    hostIdentity: "unknown",
    processProbe(pid) {
      probes.push(pid);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    },
    processStartTime: () => "linux-starttime-v1:101",
  });
  try {
    expect(() =>
      contender.service.lock(["unknown-host.lock"], { recoverDeadOwner: true }),
    ).toThrow(/LOCK_FOREIGN_HOST/);
    expect(probes).toEqual([]);
    expect(readdirSync(path)).toEqual([marker]);
    expect(readFileSync(join(path, marker), "utf8")).toBe(record);
  } finally {
    contender.close();
    lease.close();
  }
}, 30_000);

test("a foreign lock refusal identifies its host, relative marker and manual recovery", () => {
  const { options, commonDirectory, lease } = fixture();
  const lockPath = "foreign.lock";
  const marker = "owner-12345-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const path = join(commonDirectory, lockPath);
  mkdirSync(path);
  writeFileSync(
    join(path, marker),
    JSON.stringify({
      hostIdentity: "fedcba9876543210",
      startTime: "linux-starttime-v1:100",
    }),
  );
  const contender = createCloneFilesLease({
    ...options,
    hostIdentity: "0123456789abcdef",
    processProbe: () => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    },
  });
  let refusal: unknown;
  try {
    contender.service.lock([lockPath], { recoverDeadOwner: true });
  } catch (error) {
    refusal = error;
  } finally {
    contender.close();
    lease.close();
  }
  expect(refusal).toBeInstanceOf(ForgeFailure);
  expect((refusal as ForgeFailure).error.code).toBe("LOCK_FOREIGN_HOST");
  const message = (refusal as ForgeFailure).error.message;
  expect(message).toContain("fedcba9876543210");
  expect(message).toContain(`${lockPath}/${marker}`);
  expect(message).not.toContain(commonDirectory);
  expect(message).toMatch(/run.+on.+fedcba9876543210/i);
  expect(message).toMatch(/confirm.+machine.+down/i);
  expect(message).toMatch(/remove.+marker/i);
  expect(message).toContain(`now-empty lock directory ../common/${lockPath}`);
  expect(readdirSync(path)).toEqual([marker]);
}, 30_000);

test.each([
  { label: "unknown", host: "unknown" },
  { label: "control characters", host: "private-host\r\ninjected" },
  { label: "uppercase hash", host: "ABCDEF0123456789" },
])(
  "invalid host marker [$label] stays private and never permits recovery",
  ({ host }) => {
    const { options, commonDirectory, lease } = fixture();
    const path = join(commonDirectory, "invalid-host.lock");
    const marker = "owner-12345-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const record = JSON.stringify({ hostIdentity: host });
    mkdirSync(path);
    writeFileSync(join(path, marker), record);
    const probes: number[] = [];
    const contender = createCloneFilesLease({
      ...options,
      hostIdentity: host,
      processProbe: (pid) => {
        probes.push(pid);
        throw Object.assign(new Error("dead"), { code: "ESRCH" });
      },
    });
    try {
      let refusal: unknown;
      try {
        contender.service.lock(["invalid-host.lock"], {
          recoverDeadOwner: true,
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ForgeFailure);
      const failure = (refusal as ForgeFailure).error;
      expect(failure.code).toBe("LOCK_FOREIGN_HOST");
      expect(failure.message).toContain(
        `host id ${host === "unknown" ? "unknown" : "invalid"}`,
      );
      if (host !== "unknown") expect(failure.message).not.toContain(host);
      expect(probes).toEqual([]);
      expect(readFileSync(join(path, marker), "utf8")).toBe(record);
    } finally {
      contender.close();
      lease.close();
    }
  },
  30_000,
);

test("a contender keeps a temp-only lock while the complete host record awaits publication", () => {
  const { options, commonDirectory, lease } = fixture();
  const probes: number[] = [];
  const contender = createCloneFilesLease({
    ...options,
    hostIdentity: "fedcba9876543210",
    processProbe: (pid) => {
      probes.push(pid);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    },
  });
  let interleavings = 0;
  const owner = createCloneFilesLease({
    ...options,
    hostIdentity: "0123456789abcdef",
    beforeOwnerPublish(temporary) {
      interleavings++;
      const path = join(commonDirectory, "publication.lock");
      expect(readdirSync(path)).toHaveLength(1);
      expect(readdirSync(path).some((name) => name.startsWith("owner-"))).toBe(
        false,
      );
      expect(JSON.parse(readFileSync(temporary, "utf8"))).toEqual({
        hostIdentity: "0123456789abcdef",
      });
      expect(() =>
        contender.service.lock(["publication.lock"], {
          recoverDeadOwner: true,
        }),
      ).toThrow(/INPUT_CONFLICT/);
      expect(existsSync(temporary)).toBe(true);
      expect(probes).toEqual([]);
    },
  });
  try {
    const held = owner.service.lock(["publication.lock"], {
      recoverDeadOwner: true,
    });
    expect(interleavings).toBe(1);
    expect(readdirSync(join(commonDirectory, "publication.lock"))[0]).toMatch(
      /^owner-/,
    );
    held.release();
    expect(existsSync(join(commonDirectory, "publication.lock"))).toBe(false);
  } finally {
    owner.close();
    contender.close();
    lease.close();
  }
}, 30_000);

test("removing the foreign marker and then its empty directory restores acquisition", () => {
  const { options, commonDirectory, lease } = fixture();
  const path = join(commonDirectory, "manual-recovery.lock");
  const marker = join(path, "owner-12345-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  mkdirSync(path);
  writeFileSync(marker, JSON.stringify({ hostIdentity: "fedcba9876543210" }));
  const contender = createCloneFilesLease({
    ...options,
    hostIdentity: "0123456789abcdef",
  });
  const acquire = () =>
    contender.service.lock(["manual-recovery.lock"], {
      recoverDeadOwner: true,
    });
  try {
    expect(acquire).toThrow(/LOCK_FOREIGN_HOST/);
    rmSync(marker);
    expect(acquire).toThrow(/INPUT_CONFLICT/);
    expect(existsSync(path)).toBe(true);
    rmdirSync(path);
    acquire().release();
    expect(existsSync(path)).toBe(false);
  } finally {
    contender.close();
    lease.close();
  }
}, 30_000);

test("new owner markers record the injected host identity with their start time", () => {
  const { options, commonDirectory, lease } = fixture();
  const owner = createCloneFilesLease({
    ...options,
    hostIdentity: "0123456789abcdef",
    processStartTime: () => "linux-starttime-v1:100",
  });
  try {
    owner.service.lock(["host-record.lock"], { recoverDeadOwner: true });
    const path = join(commonDirectory, "host-record.lock");
    const marker = readdirSync(path)[0]!;
    expect(JSON.parse(readFileSync(join(path, marker), "utf8"))).toEqual({
      hostIdentity: "0123456789abcdef",
      startTime: "linux-starttime-v1:100",
    });
  } finally {
    owner.close();
    lease.close();
  }
}, 30_000);

test.each(["file", "empty directory", "unknown marker"])(
  "recoverable locks preserve an unproven owner: %s",
  (kind) => {
    const { files, commonDirectory, lease } = fixture();
    const path = join(commonDirectory, "unknown.lock");
    if (kind === "file") writeFileSync(path, "held");
    else {
      mkdirSync(path);
      if (kind === "unknown marker") writeFileSync(join(path, "held"), "held");
    }
    expect(() =>
      files.lock(["unknown.lock"], { recoverDeadOwner: true }),
    ).toThrow(/INPUT_CONFLICT/);
    lease.close();
    if (kind === "file") expect(readFileSync(path, "utf8")).toBe("held");
    else
      expect(readdirSync(path)).toEqual(
        kind === "unknown marker" ? ["held"] : [],
      );
  },
);
