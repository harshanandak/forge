import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
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
import type { PrivateFileGuard } from "./private-files.ts";

export interface DirectorySyncPort {
  readonly security?: PrivateFileGuard;
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

export function securedFileOps(
  security: PrivateFileGuard,
  fs: DirectorySyncPort = nodeFs,
): DirectorySyncPort & { renameSync(from: string, to: string): void } {
  return {
    ...fs,
    security,
    renameSync: (from, to) =>
      fs.renameSync ? fs.renameSync(from, to) : renameSync(from, to),
  };
}

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

/** Sync every path entry on each attempt, including entries left by a failed sync. */
export function ensurePrivateDirectory(
  path: string,
  fs: DirectoryCreatePort = nodeFs,
): void {
  const directories: string[] = [];
  let current = resolve(path);
  while (dirname(current) !== current) {
    directories.push(current);
    current = dirname(current);
  }
  for (const directory of directories.reverse()) {
    try {
      if (!fs.statSync(directory).isDirectory())
        throw new Error(`State directory is not a directory: ${directory}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !fs.statSync(directory).isDirectory()
        )
          throw error;
      }
    }
    syncParentDirectory(directory, fs);
  }
}

export function createPrivateFile(
  path: string,
  flags: "wx" | "wx+",
  fs?: DirectorySyncPort,
): number {
  fs?.security?.directory(dirname(path));
  const fd = openSync(path, flags, 0o600);
  try {
    fs?.security?.file(path);
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
  if (readOnly) {
    fs?.security?.file(path);
    return openSync(path, "r");
  }
  fs?.security?.directory(dirname(path));
  try {
    fs?.security?.file(path);
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
  fs?.security?.file(path);
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

/** Publish a completed file without replacing a competing creator's destination. */
export function linkDurable(
  from: string,
  to: string,
  fs?: DirectorySyncPort,
): void {
  linkSync(from, to);
  syncParentDirectory(to, fs);
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
  fs?.security?.directory(path);
  syncParentDirectory(path, fs);
  return path;
}
