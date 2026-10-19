import { stopCgroupScope } from "./cgroup-stop.ts";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ProcessSpawnError } from "./errors.ts";

const SELF_CGROUP = "/proc/self/cgroup";
const SELF_MOUNTS = "/proc/self/mountinfo";
const MAX_CONTROL_BYTES = 1_048_576;
const MAX_CGROUPS = 1_024;
const MAX_DEPTH = 64;
const MAX_PIDS = 65_536;

export interface LinuxCgroupOptions {
  readonly root?: string;
  readonly cleanupTimeoutMs: number;
  readonly pollIntervalMs: number;
}

interface CgroupMount {
  readonly root: string;
  readonly path: string;
}

interface CgroupIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PendingCgroup {
  readonly path: string;
  readonly depth: number;
}

export interface LinuxCgroup {
  readonly path: string;
  attach(pid: number): void;
  stop(): Promise<readonly number[]>;
  close(): void;
}

export interface LinuxCgroupProbe {
  readonly available: boolean;
  readonly reason?: string;
}

function unavailable(message: string, cause?: unknown): ProcessSpawnError {
  return new ProcessSpawnError("CONTAINMENT_UNAVAILABLE", message, cause);
}

function killFailure(message: string, cause?: unknown): ProcessSpawnError {
  return new ProcessSpawnError("TREE_KILL_FAILED", message, cause);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function readBounded(path: string, maxBytes = MAX_CONTROL_BYTES): string {
  const fd = openSync(path, "r");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(4_096, maxBytes + 1 - size));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) return Buffer.concat(chunks, size).toString("utf8");
      chunks.push(chunk.subarray(0, read));
      size += read;
    }
  } finally {
    closeSync(fd);
  }
  throw new Error(`control file exceeded ${maxBytes} bytes`);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateOptions(options: LinuxCgroupOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    !Number.isInteger(options.cleanupTimeoutMs) ||
    options.cleanupTimeoutMs < 1 ||
    options.cleanupTimeoutMs > 60_000 ||
    !Number.isInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < 1 ||
    options.pollIntervalMs > 1_000 ||
    options.pollIntervalMs > options.cleanupTimeoutMs
  ) {
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "Cgroup cleanup must be 1..60000 ms; polling must be 1..1000 ms and no greater than cleanup.",
    );
  }
  if (
    options.root !== undefined &&
    (typeof options.root !== "string" ||
      options.root.length === 0 ||
      options.root.includes("\0"))
  ) {
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "The delegated cgroup root must be a nonempty path without NUL bytes.",
    );
  }
}

function cgroupMounts(): readonly CgroupMount[] {
  try {
    return readBounded(SELF_MOUNTS)
      .split("\n")
      .flatMap((line) => {
        const [mount, filesystem] = line.split(" - ");
        if (filesystem?.split(" ")[0] !== "cgroup2") return [];
        const fields = mount?.split(" ");
        const root = fields?.[3];
        const path = fields?.[4];
        if (root === undefined || path === undefined)
          throw new Error("invalid cgroup mount");
        const decode = (value: string): string =>
          value.replace(/\\([0-7]{3})/g, (_escape, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
          );
        return [
          { root: decode(root), path: realpathSync.native(decode(path)) },
        ];
      });
  } catch (cause) {
    throw unavailable("The cgroup v2 mounts could not be read.", cause);
  }
}

function currentDelegatedRoot(mounts: readonly CgroupMount[]): string {
  let entry: string | undefined;
  try {
    entry = readBounded(SELF_CGROUP, 65_536)
      .split("\n")
      .find((line) => line.startsWith("0::"));
  } catch (cause) {
    throw unavailable("Linux cgroup membership could not be read.", cause);
  }
  if (entry === undefined) {
    throw unavailable(
      "The current process is not in a unified cgroup v2 hierarchy.",
    );
  }
  const memberPath = entry.slice(3);
  if (!memberPath.startsWith("/") || memberPath.includes("\0")) {
    throw unavailable("The current cgroup v2 membership path is invalid.");
  }

  for (const mount of mounts) {
    // Membership can be relative to a cgroup namespace while mountinfo exposes a
    // subtree root. Confirm the mapping by finding our own pid, rather than guessing.
    const paths = [memberPath];
    if (isWithin(mount.root, memberPath))
      paths.unshift(`/${relative(mount.root, memberPath)}`);
    for (const path of paths) {
      const candidate = resolve(mount.path, `.${path}`);
      if (!isWithin(mount.path, candidate)) continue;
      try {
        if (readPids(candidate).includes(process.pid)) return candidate;
      } catch {
        // Try another mount or namespace mapping.
      }
    }
  }
  throw unavailable(
    "The current cgroup could not be resolved inside a cgroup v2 mount.",
  );
}

function resolveDelegatedRoot(root?: string): string {
  if (process.platform !== "linux") {
    throw unavailable(
      "Linux cgroup v2 containment is unavailable on this platform.",
    );
  }
  const mounts = cgroupMounts();
  const requested = root ?? currentDelegatedRoot(mounts);
  if (requested.includes("\0")) {
    throw unavailable("The delegated cgroup root is invalid.");
  }

  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(requested));
    if (!statSync(canonical).isDirectory()) {
      throw new Error("delegated root is not a directory");
    }
    accessSync(canonical, constants.W_OK | constants.X_OK);
    accessSync(join(canonical, "cgroup.controllers"), constants.R_OK);
    accessSync(join(canonical, "cgroup.procs"), constants.R_OK);
  } catch (cause) {
    throw unavailable(
      "A writable delegated cgroup v2 subtree is unavailable.",
      cause,
    );
  }

  if (!mounts.some((mount) => isWithin(mount.path, canonical))) {
    throw unavailable(
      "The delegated cgroup root is outside a cgroup v2 mount.",
    );
  }
  return canonical;
}

function cgroupPopulated(path: string): boolean {
  const line = readBounded(join(path, "cgroup.events"), 16_384)
    .split("\n")
    .find((entry) => entry.startsWith("populated "));
  if (line === "populated 0") return false;
  if (line === "populated 1") return true;
  throw new Error("cgroup.events did not report a valid populated state");
}

function readPids(path: string): readonly number[] {
  const contents = readBounded(join(path, "cgroup.procs"));
  if (contents.trim() === "") return [];
  return contents
    .trim()
    .split("\n")
    .map((line) => {
      if (!/^[1-9]\d*$/.test(line)) {
        throw new Error("cgroup.procs contained an invalid process id");
      }
      const pid = Number(line);
      if (!Number.isSafeInteger(pid)) {
        throw new Error("cgroup.procs contained an unsafe process id");
      }
      return pid;
    });
}

function snapshotPids(owner: string): readonly number[] {
  const pending: PendingCgroup[] = [{ path: owner, depth: 0 }];
  const pids = new Set<number>();
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > MAX_CGROUPS) {
      throw new Error(`cgroup tree exceeded ${MAX_CGROUPS} groups`);
    }
    for (const pid of readPids(current.path)) {
      pids.add(pid);
      if (pids.size > MAX_PIDS) {
        throw new Error(`cgroup tree exceeded ${MAX_PIDS} processes`);
      }
    }

    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch (error) {
      if (current.path !== owner && isErrno(error, "ENOENT")) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (current.depth >= MAX_DEPTH) {
        throw new Error(`cgroup tree exceeded depth ${MAX_DEPTH}`);
      }
      const candidate = join(current.path, entry.name);
      let canonical: string;
      try {
        canonical = realpathSync.native(candidate);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (!isWithin(owner, canonical) || canonical === owner) {
        throw new Error(
          "cgroup tree contained a path outside its owned subtree",
        );
      }
      pending.push({ path: canonical, depth: current.depth + 1 });
    }
  }
  return [...pids].sort((left, right) => left - right);
}

class OwnedLinuxCgroup implements LinuxCgroup {
  readonly path: string;
  private readonly root: string;
  private readonly identity: CgroupIdentity;
  private readonly timing: LinuxCgroupOptions;
  private closed = false;

  constructor(
    path: string,
    root: string,
    identity: CgroupIdentity,
    timing: LinuxCgroupOptions,
  ) {
    this.path = path;
    this.root = root;
    this.identity = identity;
    this.timing = {
      cleanupTimeoutMs: timing.cleanupTimeoutMs,
      pollIntervalMs: timing.pollIntervalMs,
    };
  }

  private assertOwned(): void {
    if (this.closed) throw killFailure("The owned cgroup is already closed.");
    if (dirname(this.path) !== this.root || !isWithin(this.root, this.path)) {
      throw killFailure("The cgroup path is outside its delegated root.");
    }
    let current;
    try {
      current = lstatSync(this.path, { bigint: true });
    } catch (cause) {
      throw killFailure("The owned cgroup is no longer available.", cause);
    }
    if (
      !current.isDirectory() ||
      current.dev !== this.identity.dev ||
      current.ino !== this.identity.ino
    ) {
      throw killFailure("The owned cgroup identity changed.");
    }
  }

  attach(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ProcessSpawnError(
        "INVALID_OPTIONS",
        "The process id to attach must be a positive safe integer.",
      );
    }
    this.assertOwned();
    try {
      writeFileSync(join(this.path, "cgroup.procs"), String(pid), "utf8");
      if (!readPids(this.path).includes(pid)) {
        throw new Error("the process was not present after attachment");
      }
    } catch (cause) {
      throw unavailable(
        "The process could not be attached to its private cgroup.",
        cause,
      );
    }
  }

  async stop(): Promise<readonly number[]> {
    this.assertOwned();
    return stopCgroupScope(
      {
        snapshot: () => snapshotPids(this.path),
        kill: () => writeFileSync(join(this.path, "cgroup.kill"), "1", "utf8"),
        populated: () => cgroupPopulated(this.path),
        now: () => performance.now(),
        pause: (ms) => sleep(ms),
      },
      this.timing,
    );
  }

  close(): void {
    if (this.closed) return;
    this.assertOwned();
    try {
      if (cgroupPopulated(this.path)) {
        throw new Error("the cgroup is still populated");
      }
      rmdirSync(this.path);
      this.closed = true;
    } catch (cause) {
      throw killFailure("The owned empty cgroup could not be removed.", cause);
    }
  }
}

export function openLinuxCgroup(options: LinuxCgroupOptions): LinuxCgroup {
  validateOptions(options);
  const delegatedRoot = resolveDelegatedRoot(options.root);
  let path: string | undefined;
  try {
    path = mkdtempSync(join(delegatedRoot, "forge-"));
    const canonical = realpathSync.native(path);
    if (
      dirname(canonical) !== delegatedRoot ||
      !isWithin(delegatedRoot, canonical)
    ) {
      throw new Error("private cgroup resolved outside the delegated root");
    }
    path = canonical;

    const stat = statSync(path, { bigint: true });
    // cgroupfs chooses directory modes; mkdir's owner-only mode is not guaranteed.
    if (!stat.isDirectory()) {
      throw new Error("private cgroup is not a directory");
    }
    if (
      typeof process.geteuid === "function" &&
      stat.uid !== BigInt(process.geteuid())
    ) {
      throw new Error("private cgroup is not owned by the current user");
    }
    accessSync(join(path, "cgroup.procs"), constants.R_OK | constants.W_OK);
    accessSync(join(path, "cgroup.events"), constants.R_OK);
    accessSync(join(path, "cgroup.kill"), constants.W_OK);

    // Killing an empty group is harmless and verifies the OS operation before any spawn.
    writeFileSync(join(path, "cgroup.kill"), "1", "utf8");
    if (cgroupPopulated(path)) {
      throw new Error("new private cgroup was unexpectedly populated");
    }
    return new OwnedLinuxCgroup(
      path,
      delegatedRoot,
      {
        dev: stat.dev,
        ino: stat.ino,
      },
      options,
    );
  } catch (cause) {
    if (path !== undefined) {
      try {
        rmdirSync(path);
      } catch {
        // A failed open still reports the original capability failure. The path is direct and
        // private; recursive cleanup is deliberately forbidden.
      }
    }
    if (
      cause instanceof ProcessSpawnError &&
      cause.code === "CONTAINMENT_UNAVAILABLE"
    ) {
      throw cause;
    }
    throw unavailable("A private Linux cgroup could not be opened.", cause);
  }
}

export function probeLinuxCgroup(
  options: LinuxCgroupOptions,
): LinuxCgroupProbe {
  validateOptions(options);
  let group: LinuxCgroup | undefined;
  try {
    group = openLinuxCgroup(options);
    group.close();
    return { available: true };
  } catch (error) {
    if (group !== undefined) {
      try {
        group.close();
      } catch {
        // The capability result below retains the first failure.
      }
    }
    return {
      available: false,
      reason:
        error instanceof Error ? error.message : "Unknown cgroup failure.",
    };
  }
}
