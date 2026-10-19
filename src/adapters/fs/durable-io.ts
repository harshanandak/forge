import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

/** Windows does not expose directory fsync through Node's file descriptors. */
export function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  syncParentDirectory(path);
}

export function createPrivateFile(path: string, executable: boolean): number {
  const fd = openSync(path, "wx", executable ? 0o700 : 0o600);
  try {
    if (process.platform !== "win32")
      fchmodSync(fd, executable ? 0o700 : 0o600);
    syncParentDirectory(path);
    return fd;
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      /* Preserve the failed durability operation. */
    }
    throw error;
  }
}

export function replaceDurable(from: string, to: string): void {
  renameSync(from, to);
  syncParentDirectory(to);
}

export function removeDurable(path: string): void {
  unlinkSync(path);
  syncParentDirectory(path);
}
