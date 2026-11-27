import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { dirname } from "node:path";
import type { WorkerClaim } from "../contract/runtime.ts";
import { protectDirectoryChain, protectPath } from "./protect.ts";

export function workerLockPath(database: string): string {
  return database + ".worker.lock";
}

const statOptions = { bigint: true } as const;
const windows = process.platform === "win32";

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function verifyDirectory(path: string, identity: BigIntStats): void {
  if (
    !protectDirectoryChain(path) ||
    !protectPath(path, "dir") ||
    !sameIdentity(identity, lstatSync(path, statOptions))
  )
    throw new Error("Unsafe lock directory");
}

function verifyLock(path: string, identity: BigIntStats): void {
  if (!protectPath(path, "file")) throw new Error("Unsafe lock file");
  const current = lstatSync(path, statOptions);
  if (
    !current.isFile() ||
    current.nlink !== 1n ||
    current.size !== 0n ||
    !sameIdentity(identity, current)
  )
    throw new Error("Lock file identity changed");
}

function syncDirectory(path: string, identity: BigIntStats): void {
  if (windows) return;
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!sameIdentity(identity, fstatSync(fd, statOptions)))
      throw new Error("Lock directory identity changed");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function claimWorkerLock(database: string): WorkerClaim {
  const path = workerLockPath(database);
  const parent = dirname(path);
  let file: number | undefined;
  try {
    const directory = lstatSync(parent, statOptions);
    verifyDirectory(parent, directory);
    const fd = openSync(path, "wx", 0o600);
    file = fd;
    if (!windows) fchmodSync(fd, 0o600);
    const identity = fstatSync(fd, statOptions);
    verifyLock(path, identity);
    fsyncSync(fd);
    syncDirectory(parent, directory);
    let held = true;
    file = undefined;
    return {
      release() {
        if (!held) return;
        held = false;
        try {
          verifyDirectory(parent, directory);
          verifyLock(path, identity);
          unlinkSync(path);
          syncDirectory(parent, directory);
        } catch {
          throw new Error(
            "Hub effect worker lock could not be safely released",
          );
        } finally {
          closeSync(fd);
        }
      },
    };
  } catch {
    throw new Error("Hub effect worker lock is present or unavailable");
  } finally {
    if (file !== undefined) closeSync(file);
  }
}
