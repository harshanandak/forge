import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  dirname,
  basename,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  win32,
} from "node:path";
import { ForgeFailure } from "../../contract/failure.ts";
import {
  createPrivateDirectory,
  createPrivateFile,
  removeDurable,
  publishExclusive,
  removePrivateDirectory,
  replaceDurable,
} from "./durable-io.ts";

export type CloneFileArea = "project" | "git" | "common";
export interface CloneMarkerCleanupScheduler {
  now(): number;
  schedule(
    callback: () => void,
    delay: number,
  ): {
    unref(): void;
    cancel(): void;
  };
}
export interface CloneFilesOptions {
  readonly markerCleanup?: CloneMarkerCleanupScheduler;
  readonly processStartTime?: (pid: number) => string | undefined;
  readonly projectRoot: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly signal: AbortSignal;
  readonly deadline?: number;
  readonly maxBytes?: number;
}
export interface CloneFileCondition {
  readonly expected?: string | null;
  readonly area?: CloneFileArea;
}
export interface CloneFileWriteOptions extends CloneFileCondition {
  readonly executable?: boolean;
}
export interface CloneFilesService {
  readonly root: string;
  readonly roots: Readonly<Record<CloneFileArea, string>>;
  read(
    path: string,
    maxBytes: number,
    area?: CloneFileArea,
  ): string | undefined;
  write(path: string, text: string, options?: CloneFileWriteOptions): void;
  remove(path: string, options?: CloneFileCondition): void;
  inspect(path: string, area?: CloneFileArea): CloneFileInspection | undefined;
  list(
    path: string,
    maxEntries: number,
    area?: CloneFileArea,
  ): readonly string[];
  /** Relative paths use common. Recoverable locks use owner-marked directories, never Git lock files. */
  lock(
    paths: readonly string[],
    options?: { readonly recoverDeadOwner?: boolean },
  ): CloneFileLock;
}
export interface CloneFileLock {
  release(): void;
}
export interface CloneFilesLease {
  readonly service: CloneFilesService;
  close(): void;
}
interface CloneFilesTestHooks {
  beforeCommit?(): void;
  afterClaim?(): void;
}
export interface CloneFileInspection {
  readonly regular: boolean;
  readonly executable: boolean;
  readonly size: number;
}

const MAX_BYTES = 1_048_576;
function failure(code: string, message: string): never {
  throw new ForgeFailure({
    code,
    message,
    retry: code === "INPUT_CONFLICT" ? "reconcile_first" : "never",
  });
}
/** Untagged times may depend on locale or timezone and cannot prove PID reuse. */
function startTimeFormat(value: string | undefined): string | undefined {
  const match = value?.match(
    /^(linux-starttime-v1|win32-filetime-v1|darwin-lstart-utc-v1):(.+)$/,
  );
  if (!match) return undefined;
  const format = match[1]!,
    time = match[2]!;
  if (format !== "darwin-lstart-utc-v1")
    return /^[1-9]\d*$/.test(time) ? format : undefined;
  const instant = Date.parse(time);
  return Number.isFinite(instant) && new Date(instant).toISOString() === time
    ? format
    : undefined;
}
const pendingMarkerCleanup = new Map<string, () => void>();
/** Owner filenames make dead-owner cleanup generation-specific; unknown locks stay untouched. */
function recoverableLock(
  target: string,
  startTime?: (pid: number) => string | undefined,
): CloneFileLock {
  const owner = "owner-" + process.pid + "-" + randomUUID();
  const conflict = () =>
    failure(
      "INPUT_CONFLICT",
      "Recoverable exclusion lock is held; inspect its owner before retrying",
    );
  const removeEmpty = () => {
    try {
      removePrivateDirectory(target);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error) ?? ""))
        throw error;
    }
  };
  const release = (name: string, identity: BigIntStats) => {
    const info = stat(target);
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      !sameFile(info, identity)
    )
      return;
    try {
      removeDurable(join(target, name));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      if (stat(join(target, name)) === null) throw error;
      throw Object.assign(
        new Error("Clone lock marker cleanup pending", { cause: error }),
        { code: "LOCK_CLEANUP_PENDING" },
      );
    }
    removeEmpty();
  };
  const existing = stat(target);
  if (existing !== null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) conflict();
    const names = readdirSync(target),
      name = names.length === 1 ? names[0] : undefined;
    const match = name?.match(/^owner-([1-9]\d*)-[0-9a-f-]{36}$/);
    if (!match) conflict();
    let dead = false;
    try {
      process.kill(Number(match![1]), 0);
      const marker = join(target, name!);
      const info = stat(marker);
      if (
        startTime &&
        info?.isFile() &&
        !info.isSymbolicLink() &&
        info.size <= 512n
      ) {
        try {
          const record: unknown = JSON.parse(readFileSync(marker, "utf8"));
          if (
            typeof record === "object" &&
            record !== null &&
            "startTime" in record &&
            typeof record.startTime === "string" &&
            record.startTime !== ""
          ) {
            const current = startTime(Number(match![1]));
            const format = startTimeFormat(record.startTime);
            dead =
              format !== undefined &&
              format === startTimeFormat(current) &&
              current !== record.startTime;
          }
        } catch {
          // Empty legacy markers and unreadable identities retain PID-only handling.
        }
      }
    } catch (error) {
      dead = errorCode(error) === "ESRCH";
    }
    if (!dead) conflict();
    release(name!, existing);
  }
  // mkdir is exclusive on every platform. A directory rename can replace a file on Windows.
  // An empty directory has no proven owner, including while its creator publishes the marker.
  try {
    createPrivateDirectory(target);
  } catch (error) {
    if (errorCode(error) === "EEXIST") conflict();
    throw error;
  }
  const identity = stat(target)!;
  try {
    const fd = createPrivateFile(join(target, owner), false);
    try {
      const created = startTime?.(process.pid);
      if (created !== undefined) {
        writeFileSync(fd, JSON.stringify({ startTime: created }));
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const current = stat(target);
    if (current && sameFile(current, identity)) removeEmpty();
    throw error;
  }
  const marker = join(target, owner);
  const cleanup = () => {
    try {
      release(owner, identity);
      pendingMarkerCleanup.delete(marker);
    } catch (error) {
      if (errorCode(error) === "LOCK_CLEANUP_PENDING")
        pendingMarkerCleanup.set(marker, cleanup);
      throw error;
    }
  };
  return { release: cleanup };
}
function active(options: CloneFilesOptions): void {
  options.signal.throwIfAborted();
  if (options.deadline !== undefined && Date.now() >= options.deadline)
    failure(
      "INVOCATION_TIMEOUT",
      "Clone file service invocation deadline expired",
    );
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
function boundedLimit(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    failure(
      "INPUT_INVALID",
      `File byte limit must be an integer from 1 to ${ceiling}`,
    );
  return value;
}
function stat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
function directory(path: string): void {
  const info = stat(path);
  if (info === null || !info.isDirectory() || info.isSymbolicLink())
    failure(
      "INPUT_INVALID",
      "Clone file root or parent must be an existing directory without symlinks",
    );
}
function validateRoot(path: string): string {
  if (!isAbsolute(path))
    failure("INPUT_INVALID", "Clone file roots must be absolute");
  const root = resolve(path);
  let current = parse(root).root;
  directory(current);
  for (const segment of relative(current, root)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, segment);
    directory(current);
  }
  return realpathSync.native(root);
}
function segmentsOf(path: string): readonly string[] {
  if (path.length > 4096)
    failure(
      "INPUT_INVALID",
      "Clone file path exceeds the platform path safety ceiling",
    );
  const segments = path.split("/");
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
    )
  )
    failure(
      "INPUT_INVALID",
      "Clone file path must be a strict relative path without platform aliases",
    );
  return segments;
}
function regular(info: BigIntStats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
    failure(
      "INPUT_INVALID",
      "Clone files must be regular files without symlinks or hard links",
    );
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameCapturedFile(
  before: BigIntStats | null,
  claimed: BigIntStats | null,
  beforeHash: string | null,
  claimedHash: string | null,
  claimedText: string | undefined,
  expected: string,
): boolean {
  return (
    before !== null &&
    claimed !== null &&
    sameFile(before, claimed) &&
    before.size === claimed.size &&
    before.mtimeNs === claimed.mtimeNs &&
    beforeHash === claimedHash &&
    claimedText === expected
  );
}

/** Resolve parent aliases (including Windows short names), never a final lock symlink. */
function canonicalLockPath(path: string): string {
  if (!isAbsolute(path))
    failure("INPUT_INVALID", "Clone lock path belongs to another platform");
  const absolute = resolve(path);
  const suffix = [basename(absolute)];
  let ancestor = dirname(absolute);
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), ...suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || dirname(ancestor) === ancestor)
        throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

function createCloneFilesAccess(
  options: CloneFilesOptions,
  hooks: CloneFilesTestHooks = {},
): {
  readonly service: CloneFilesService;
  readonly readBytes: (
    path: string,
    maxBytes: number,
  ) => Uint8Array | undefined;
  readonly close: () => void;
} {
  active(options);
  const limit = boundedLimit(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const roots: Readonly<Record<CloneFileArea, string>> = Object.freeze({
    project: validateRoot(options.projectRoot),
    git: validateRoot(options.gitDirectory),
    common: validateRoot(options.commonDirectory),
  });
  let closed = false;
  interface OwnedLock {
    readonly target: string;
    readonly area: CloneFileArea;
    readonly path: string;
    readonly fd: number;
    readonly identity: BigIntStats;
    readonly nonce: Buffer;
    written: number;
    released: boolean;
  }
  const locks = new Set<OwnedLock>();
  const recoverable = new Set<CloneFileLock>();
  const pendingCleanup = new Set<CloneFileLock>();
  function checkActive(): void {
    if (closed) failure("SERVICE_EXPIRED", "Clone file service has closed");
    active(options);
  }
  function targetFor(
    area: CloneFileArea,
    path: string,
    createParents = false,
    inspectFinal = false,
    cleanup = false,
  ): string {
    if (!cleanup) checkActive();
    const root = roots[area];
    if (root === undefined) failure("INPUT_INVALID", "Unknown clone file area");
    validateRoot(root);
    const segments = segmentsOf(path);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let info = stat(current);
      if (info === null && createParents) {
        checkActive();
        try {
          createPrivateDirectory(current);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        info = stat(current);
      }
      if (info !== null && (!info.isDirectory() || info.isSymbolicLink()))
        failure(
          "INPUT_INVALID",
          "Clone file parents must be directories without symlinks",
        );
    }
    const target = join(root, ...segments);
    const info = stat(target);
    if (info !== null && !inspectFinal) regular(info);
    return target;
  }
  function readBytes(
    area: CloneFileArea,
    path: string,
    maxBytes: number,
  ): Uint8Array | undefined {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > limit)
      failure("INPUT_INVALID", "Clone file byte budget is invalid");
    const max = maxBytes;
    const target = targetFor(area, path);
    const before = stat(target);
    if (before === null) return undefined;
    let fd: number;
    try {
      fd = openSync(
        target,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    try {
      const opened = fstatSync(fd, { bigint: true });
      regular(opened);
      if (!sameFile(before, opened))
        failure("INPUT_CONFLICT", "Clone file changed while opening");
      if (opened.size > BigInt(max))
        failure("LIMIT_EXCEEDED", "Clone file exceeds the declared byte limit");
      const buffer = Buffer.alloc(max + 1);
      let count = 0;
      while (count < buffer.length) {
        checkActive();
        const progress = readSync(
          fd,
          buffer,
          count,
          buffer.length - count,
          null,
        );
        if (progress === 0) break;
        count += progress;
      }
      if (count > max)
        failure("LIMIT_EXCEEDED", "Clone file exceeds the declared byte limit");
      const after = fstatSync(fd, { bigint: true });
      regular(after);
      const current = stat(targetFor(area, path));
      if (
        current === null ||
        !sameFile(opened, current) ||
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs
      )
        failure("INPUT_CONFLICT", "Clone file changed during read");
      return buffer.subarray(0, count);
    } finally {
      closeSync(fd);
    }
  }
  function readFile(
    area: CloneFileArea,
    path: string,
    maxBytes: number,
  ): string | undefined {
    const bytes = readBytes(area, path, boundedLimit(maxBytes, limit));
    if (bytes === undefined) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      failure("INPUT_INVALID", "Clone file content must be valid UTF-8");
    }
  }
  function mutation(
    area: CloneFileArea,
    path: string,
    condition: CloneFileCondition,
    text?: string,
    executable = false,
  ): void {
    checkActive();
    if (!options.write)
      failure(
        "EFFECT_UNDECLARED",
        "Clone file mutation requires the declared files:write effect",
      );
    if (text !== undefined && Buffer.byteLength(text, "utf8") > limit)
      failure("LIMIT_EXCEEDED", "Clone file exceeds the declared byte limit");
    if (text !== undefined && !text.isWellFormed())
      failure("INPUT_INVALID", "Clone file text must be valid Unicode");
    const target = targetFor(area, path);
    if (text === undefined && stat(target) === null) {
      if (condition.expected !== undefined && condition.expected !== null)
        failure(
          "INPUT_CONFLICT",
          "Clone file no longer matches expected content",
        );
      return;
    }
    targetFor(area, path, true);
    const lock = `${target}.lock`;
    let fd: number;
    try {
      fd = createPrivateFile(lock, executable);
    } catch (error) {
      if (errorCode(error) === "EEXIST")
        failure(
          "INPUT_CONFLICT",
          "Clone file is locked by another writer; inspect its lock before retrying",
        );
      throw error;
    }
    let promoted = false;
    const identity = fstatSync(fd, { bigint: true });
    let quarantine: string | undefined;
    let claimed: string | undefined;
    function restoreClaim(): void {
      if (claimed === undefined || stat(claimed) === null) return;
      try {
        publishExclusive(claimed, target);
      } catch {
        failure(
          "INPUT_CONFLICT",
          `Concurrent replacement preserved; reconcile the original in ${quarantine}`,
        );
      }
      removeDurable(claimed);
    }
    try {
      const captured = stat(target);
      const current = readFile(area, path, limit) ?? null;
      const capturedHash =
        current === null
          ? null
          : createHash("sha256").update(current, "utf8").digest("hex");
      const afterRead = stat(target);
      if (
        (captured === null) !== (afterRead === null) ||
        (captured !== null &&
          afterRead !== null &&
          (!sameFile(captured, afterRead) ||
            captured.size !== afterRead.size ||
            captured.mtimeNs !== afterRead.mtimeNs))
      )
        failure(
          "INPUT_CONFLICT",
          "Clone file identity changed during its initial read",
        );
      if (condition.expected !== undefined && current !== condition.expected)
        failure(
          "INPUT_CONFLICT",
          "Clone file no longer matches expected content",
        );
      if (text !== undefined) {
        writeFileSync(fd, text, "utf8");
        fsyncSync(fd);
      }
      hooks.beforeCommit?.();
      checkActive();
      const lockNow = stat(lock);
      if (
        lockNow === null ||
        !sameFile(identity, lockNow) ||
        lockNow.nlink !== 1n
      )
        failure("INPUT_CONFLICT", "Clone file lock changed before commit");
      if (condition.expected !== undefined) {
        if (condition.expected !== null) {
          quarantine = join(dirname(target), `.forge-restore-${randomUUID()}`);
          createPrivateDirectory(quarantine);
          claimed = join(quarantine, "original");
          targetFor(area, path);
          try {
            replaceDurable(target, claimed);
          } catch (error) {
            if (errorCode(error) === "ENOENT")
              failure("INPUT_CONFLICT", "Clone file disappeared before commit");
            throw error;
          }
          const claimedPath = relative(roots[area], claimed)
            .split("\\")
            .join("/");
          const claimedIdentity = stat(claimed);
          const claimedText = readFile(area, claimedPath, limit);
          const claimedHash =
            claimedText === undefined
              ? null
              : createHash("sha256").update(claimedText, "utf8").digest("hex");
          // Claim before comparing: a changed target can be restored without overwriting a new one.
          if (
            !sameCapturedFile(
              captured,
              claimedIdentity,
              capturedHash,
              claimedHash,
              claimedText,
              condition.expected,
            )
          ) {
            restoreClaim();
            failure(
              "INPUT_CONFLICT",
              "Clone file changed before commit; its replacement was restored",
            );
          }
          hooks.afterClaim?.();
        }
        checkActive();
        if (text !== undefined) {
          try {
            publishExclusive(lock, target);
          } catch (error) {
            if (errorCode(error) === "EEXIST")
              failure(
                "INPUT_CONFLICT",
                "A concurrent clone file replacement was preserved",
              );
            throw error;
          }
          removeDurable(lock);
          promoted = true;
        }
        if (claimed !== undefined && stat(claimed) !== null)
          removeDurable(claimed);
      } else if (text === undefined) {
        if (current !== null) {
          targetFor(area, path);
          removeDurable(target);
        }
      } else if (
        current !== text ||
        (process.platform !== "win32" &&
          ((stat(target)?.mode ?? 0n) & 0o111n) !== (executable ? 0o100n : 0n))
      ) {
        closeSync(fd);
        fd = -1;
        targetFor(area, path);
        checkActive();
        replaceDurable(lock, target);
        promoted = true;
      }
    } catch (error) {
      restoreClaim();
      throw error;
    } finally {
      if (fd !== -1) closeSync(fd);
      const remaining = stat(lock);
      if (!promoted && remaining !== null && sameFile(remaining, identity))
        removeDurable(lock);
      if (
        quarantine !== undefined &&
        (claimed === undefined || stat(claimed) === null)
      )
        removePrivateDirectory(quarantine);
    }
  }
  function releaseLock(lock: OwnedLock): void {
    if (lock.released) return;
    lock.released = true;
    locks.delete(lock);
    try {
      try {
        targetFor(lock.area, lock.path, false, true, true);
      } catch (error) {
        if (error instanceof ForgeFailure) return;
        throw error;
      }
      const candidate = stat(lock.target);
      if (
        candidate === null ||
        !candidate.isFile() ||
        candidate.isSymbolicLink() ||
        candidate.nlink !== 1n ||
        !sameFile(candidate, lock.identity)
      )
        return;
      const opened = fstatSync(lock.fd, { bigint: true });
      if (
        !sameFile(opened, lock.identity) ||
        opened.nlink !== 1n ||
        opened.size !== BigInt(lock.written)
      )
        return;
      const actual = Buffer.alloc(lock.written + 1);
      let count = 0;
      while (count < actual.length) {
        const progress = readSync(
          lock.fd,
          actual,
          count,
          actual.length - count,
          count,
        );
        if (progress === 0) break;
        count += progress;
      }
      if (
        count !== lock.written ||
        !actual.subarray(0, count).equals(lock.nonce.subarray(0, lock.written))
      )
        return;
      const final = stat(lock.target);
      if (
        final !== null &&
        sameFile(final, lock.identity) &&
        final.nlink === 1n
      )
        removeDurable(lock.target);
    } finally {
      closeSync(lock.fd);
    }
  }
  function releaseAll(
    owned: readonly OwnedLock[],
    held: readonly CloneFileLock[] = [],
  ): void {
    const errors: unknown[] = [];
    for (const lock of held) {
      if (!recoverable.delete(lock) && !pendingCleanup.has(lock)) continue;
      // Caller release frees its slot even while the marker still excludes other owners.
      pendingCleanup.add(lock);
      try {
        lock.release();
        pendingCleanup.delete(lock);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const lock of owned) {
      try {
        releaseLock(lock);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Clone lock cleanup failed");
  }
  function acquire(
    paths: readonly string[],
    lockOptions?: { readonly recoverDeadOwner?: boolean },
  ): CloneFileLock {
    checkActive();
    if (!options.write)
      failure(
        "EFFECT_UNDECLARED",
        "Clone lock acquisition requires the declared files:write effect",
      );
    if (paths.length > 3 || locks.size + recoverable.size + paths.length > 3)
      failure(
        "LIMIT_EXCEEDED",
        "Clone service may hold at most three exclusion locks",
      );
    const seen = new Set<string>();
    const plans = paths.map((path) => {
      let area: CloneFileArea = "common";
      let local = path;
      if (isAbsolute(path) || win32.isAbsolute(path)) {
        const canonical = canonicalLockPath(path);
        const matched = (["common", "git"] as const).find((candidate) => {
          const localPath = relative(roots[candidate], canonical);
          return (
            localPath !== "" &&
            !localPath.startsWith(
              `..${process.platform === "win32" ? "\\" : "/"}`,
            ) &&
            localPath !== ".." &&
            !isAbsolute(localPath)
          );
        });
        if (matched === undefined)
          failure(
            "INPUT_INVALID",
            "Clone locks must stay inside verified Git metadata roots",
          );
        area = matched;
        local = relative(roots[area], canonical).split("\\").join("/");
      }
      if (!local.endsWith(".lock"))
        failure(
          "INPUT_INVALID",
          "Clone exclusion paths must name native .lock files",
        );
      const target = targetFor(
        area,
        local,
        false,
        lockOptions?.recoverDeadOwner,
      );
      const identity =
        process.platform === "win32" ? target.toLowerCase() : target;
      if (seen.has(identity))
        failure("INPUT_INVALID", "Clone exclusion lock paths must be unique");
      seen.add(identity);
      return { area, path: local, target };
    });
    for (const cleanup of pendingMarkerCleanup.values()) {
      try {
        cleanup();
      } catch {
        // Retain failed cleanup without replacing this acquisition's result.
      }
    }
    if (lockOptions?.recoverDeadOwner) {
      const held: CloneFileLock[] = [];
      const result = {
        release() {
          releaseAll([], held);
        },
      };
      try {
        for (const plan of plans) {
          targetFor(plan.area, plan.path, true, true);
          const lock = recoverableLock(plan.target, options.processStartTime);
          held.push(lock);
          recoverable.add(lock);
        }
        return result;
      } catch (error) {
        result.release();
        throw error;
      }
    }
    const acquired: OwnedLock[] = [];
    try {
      for (const plan of plans) {
        checkActive();
        targetFor(plan.area, plan.path, true);
        let fd: number;
        try {
          fd = createPrivateFile(plan.target, false, "wx+");
        } catch (error) {
          if (errorCode(error) === "EEXIST")
            failure(
              "INPUT_CONFLICT",
              "A native Git exclusion lock already exists",
            );
          throw error;
        }
        const lock: OwnedLock = {
          ...plan,
          fd,
          identity: fstatSync(fd, { bigint: true }),
          nonce: Buffer.from(`${randomUUID()}\n`),
          written: 0,
          released: false,
        };
        locks.add(lock);
        acquired.push(lock);
        while (lock.written < lock.nonce.length) {
          const progress = writeSync(
            fd,
            lock.nonce,
            lock.written,
            lock.nonce.length - lock.written,
            lock.written,
          );
          if (progress <= 0)
            throw new Error("Clone lock write made no progress");
          lock.written += progress;
        }
        fsyncSync(fd);
        checkActive();
      }
      return Object.freeze({
        release(): void {
          releaseAll(acquired);
        },
      });
    } catch (error) {
      releaseAll(acquired);
      throw error;
    }
  }
  const service: CloneFilesService = Object.freeze({
    get root(): string {
      checkActive();
      return roots.project;
    },
    get roots(): Readonly<Record<CloneFileArea, string>> {
      checkActive();
      return roots;
    },
    read(
      path: string,
      maxBytes: number,
      area: CloneFileArea = "project",
    ): string | undefined {
      checkActive();
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone file reads require the declared files:read effect",
        );
      return readFile(area, path, maxBytes);
    },
    write(
      path: string,
      text: string,
      condition: CloneFileWriteOptions = {},
    ): void {
      mutation(
        condition.area ?? "project",
        path,
        condition,
        text,
        condition.executable ?? false,
      );
    },
    remove(path: string, condition: CloneFileCondition = {}): void {
      mutation(condition.area ?? "project", path, condition);
    },
    inspect(
      path: string,
      area: CloneFileArea = "project",
    ): CloneFileInspection | undefined {
      checkActive();
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone file inspection requires the declared files:read effect",
        );
      const info = stat(targetFor(area, path, false, true));
      checkActive();
      if (info === null) return undefined;
      const regularFile =
        info.isFile() && !info.isSymbolicLink() && info.nlink === 1n;
      return {
        regular: regularFile,
        executable:
          regularFile &&
          (process.platform === "win32" || (info.mode & 0o111n) !== 0n),
        size: Number(info.size),
      };
    },
    list(
      path: string,
      maxEntries: number,
      area: CloneFileArea = "project",
    ): readonly string[] {
      checkActive();
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone directory listing requires the declared files:read effect",
        );
      const cap = boundedLimit(maxEntries, 1024);
      if (roots[area] === undefined)
        failure("INPUT_INVALID", "Unknown clone file area");
      const target =
        path === "."
          ? validateRoot(roots[area])
          : targetFor(area, path, false, true);
      directory(target);
      const dir = opendirSync(target, { bufferSize: 1 });
      try {
        const names: string[] = [];
        for (;;) {
          checkActive();
          const entry = dir.readSync();
          if (entry === null) break;
          if (names.length === cap)
            failure(
              "LIMIT_EXCEEDED",
              "Clone directory exceeds the declared entry limit",
            );
          names.push(entry.name);
        }
        if (path === ".") validateRoot(roots[area]);
        else directory(targetFor(area, path, false, true));
        checkActive();
        return names.sort();
      } finally {
        dir.closeSync();
      }
    },
    lock: acquire,
  });
  return {
    service,
    close(): void {
      closed = true;
      releaseAll([...locks], [...recoverable, ...pendingCleanup]);
    },
    readBytes(path: string, maxBytes: number): Uint8Array | undefined {
      checkActive();
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone file reads require the declared files:read effect",
        );
      return readBytes("project", path, maxBytes);
    },
  };
}

export function createCloneFiles(
  options: CloneFilesOptions,
  hooks?: CloneFilesTestHooks,
): CloneFilesService {
  return createCloneFilesAccess(options, hooks).service;
}

export function createCloneFilesLease(
  options: CloneFilesOptions,
): CloneFilesLease {
  const access = createCloneFilesAccess(options);
  return { service: access.service, close: access.close };
}

/** The ordered paths and missing markers are framed separately from exact file bytes. */
export function digestCloneFiles(
  options: CloneFilesOptions,
  paths: readonly string[],
  maxTotalBytes: number,
): string {
  active(options);
  if (!options.read)
    failure(
      "EFFECT_UNDECLARED",
      "Clone file digests require the declared files:read effect",
    );
  if (paths.length > 1024)
    failure(
      "LIMIT_EXCEEDED",
      "Clone snapshot exceeds the 1024 selected-path safety ceiling",
    );
  boundedLimit(maxTotalBytes, MAX_BYTES * 1024);
  const seen = new Set<string>();
  for (const path of paths) {
    segmentsOf(path);
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(identity))
      failure("INPUT_INVALID", "Clone snapshot paths must be unique");
    seen.add(identity);
  }
  const access = createCloneFilesAccess(options);
  const hash = createHash("sha256").update("forge.clone-files/v1\0");
  let remaining = maxTotalBytes;
  for (const path of paths) {
    const bytes = access.readBytes(
      path,
      Math.min(remaining, options.maxBytes ?? MAX_BYTES),
    );
    hash.update(JSON.stringify([path, bytes?.byteLength ?? null]));
    hash.update("\0");
    if (bytes !== undefined) {
      hash.update(bytes);
      remaining -= bytes.byteLength;
    }
  }
  active(options);
  return hash.digest("hex");
}
