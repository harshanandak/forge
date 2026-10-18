import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface DirectorySyncPort {
  readonly platform: string;
  openSync(path: string, flags: "r"): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync?(from: string, to: string): void;
}

export interface DirectoryCreatePort extends DirectorySyncPort {
  statSync(path: string): { isDirectory(): boolean };
  mkdirSync(path: string, options: { mode: number }): void;
}

const nodeFs: DirectoryCreatePort = {
  platform: process.platform,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  statSync,
  mkdirSync,
};

export function syncParentDirectory(
  path: string,
  fs: DirectorySyncPort = nodeFs,
): void {
  if (fs.platform === "win32") return;
  const fd = fs.openSync(dirname(path), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Publish each private directory entry durably before descending into it. */
export function ensurePrivateDirectory(
  path: string,
  fs: DirectoryCreatePort = nodeFs,
): void {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      if (!fs.statSync(current).isDirectory())
        throw new Error(`State directory is not a directory: ${current}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !fs.statSync(directory).isDirectory()
      )
        throw error;
    }
    syncParentDirectory(directory, fs);
  }
}

export function createPrivateFile(
  path: string,
  flags: "wx" | "wx+",
  fs?: DirectorySyncPort,
): number {
  const fd = openSync(path, flags, 0o600);
  try {
    syncParentDirectory(path, fs);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

export function openStoreFile(
  path: string,
  readOnly: boolean,
  fs?: DirectorySyncPort,
): number {
  if (readOnly) return openSync(path, "r");
  try {
    return openSync(path, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return createPrivateFile(path, "wx", fs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return openSync(path, "r+");
  }
}

export function writePrivateFile(
  path: string,
  data: Uint8Array,
  fs?: DirectorySyncPort,
): void {
  const fd = createPrivateFile(path, "wx", fs);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** SQLite must create VACUUM output itself; its containing directory is private until this adopts it. */
export function adoptPrivateFile(path: string, fs?: DirectorySyncPort): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
  syncParentDirectory(path, fs);
}

export function copyPrivateFile(
  from: string,
  to: string,
  fs?: DirectorySyncPort,
): void {
  const source = openSync(from, "r");
  try {
    const target = createPrivateFile(to, "wx", fs);
    try {
      const buffer = Buffer.alloc(65536);
      let count: number;
      while ((count = readSync(source, buffer, 0, buffer.length, null)) > 0) {
        let written = 0;
        while (written < count) {
          const progress = writeSync(target, buffer, written, count - written);
          if (progress <= 0) throw new Error("Store copy made no progress");
          written += progress;
        }
      }
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
}

export function renameDurable(
  from: string,
  to: string,
  fs: DirectorySyncPort = nodeFs,
): void {
  (fs.renameSync ?? renameSync)(from, to);
  syncParentDirectory(to, fs);
  if (dirname(from) !== dirname(to)) syncParentDirectory(from, fs);
}

export function removeDurable(
  path: string,
  options?: { recursive?: boolean; force?: boolean },
  fs?: DirectorySyncPort,
): void {
  rmSync(path, options);
  syncParentDirectory(path, fs);
}

export function makePrivateTempDirectory(
  prefix: string,
  fs?: DirectorySyncPort,
): string {
  const path = `${prefix}${randomUUID()}`;
  mkdirSync(path, { mode: 0o700 });
  syncParentDirectory(path, fs);
  return path;
}
