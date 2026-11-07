import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  linkSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

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

export function createPrivateFile(
  path: string,
  executable: boolean,
  flags: "wx" | "wx+" = "wx",
): number {
  const fd = openSync(path, flags, executable ? 0o700 : 0o600);
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
  if (dirname(from) !== dirname(to)) syncParentDirectory(from);
}

export function publishExclusive(from: string, to: string): void {
  linkSync(from, to);
  syncParentDirectory(to);
}

export function removePrivateDirectory(path: string): void {
  rmdirSync(path);
  syncParentDirectory(path);
}

export function removeDurable(path: string): void {
  unlinkSync(path);
  syncParentDirectory(path);
}

/**
 * Writes a private file by atomic replace: a new 0600 file is renamed over the old one, so a
 * broader mode on the old file is never inherited.
 */
export function writePrivateTextAtomic(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = createPrivateFile(temporary, false);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    replaceDurable(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the failed write. */
    }
    throw error;
  }
}

/**
 * Why a file that grants authority cannot be trusted, or undefined when it is missing or fine.
 * POSIX: it must be a regular file owned by this user and not group- or world-writable. Windows
 * relies on the protected device folder the file is created in.
 */
export function untrustedFileReason(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return "it is not a regular file";
  if (info.uid !== process.getuid?.())
    return "it is not owned by the current user";
  if ((info.mode & 0o022) !== 0) return "it is group- or world-writable";
  return undefined;
}
