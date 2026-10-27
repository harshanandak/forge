// Project files on the local filesystem through node:fs, rooted at the project: the Node
// implementation of the ConfigFiles port. Paths arrive project-relative with "/" separators.
//
// Every operation resolves its path against the REAL project root first and refuses anything that
// lands outside it: `..`, absolute paths, and symlinks (or junctions) in any component whose target
// leaves the root — including dangling ones. A symlinked final component is never followed for
// reads or writes, and writes replace the target atomically (exclusive temp file in the same
// directory, then rename).
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { ConfigFiles } from "../../core/config/files.ts";
import {
  fileLimitExceeded,
  MAX_CONFIG_FILE_BYTES,
  MAX_LOCK_FILE_BYTES,
} from "../../core/config/files.ts";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function escape(path: string, why: string): Error {
  return new Error(`refusing "${path}": ${why}`);
}

const realpath = (path: string): string => realpathSync.native(path);

function within(realRoot: string, candidate: string): boolean {
  const rel = relative(realRoot, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** How a symlink in the LAST component is treated: followed (list), refused, or left alone (remove). */
type FinalLink = "follow" | "refuse" | "keep";

function resolveIn(root: string, path: string, finalLink: FinalLink): string {
  if (isAbsolute(path) || win32.isAbsolute(path))
    throw escape(path, "absolute path is outside the project root");
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === ".." || s.includes("\\")))
    throw escape(path, "path leaves the project root");

  let realRoot: string;
  try {
    realRoot = realpath(root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return join(resolve(root), ...segments); // no root yet: nothing in it can be a link
  }

  let current = realRoot;
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    const last = index === segments.length - 1;
    let info;
    try {
      info = lstatSync(next);
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        return join(next, ...segments.slice(index + 1)); // the rest does not exist yet
      throw error;
    }
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (last && finalLink === "keep") return next;
    if (last && finalLink === "refuse")
      throw escape(path, "symlinked file is not followed");
    let real: string;
    try {
      real = realpath(next);
    } catch {
      throw escape(path, "dangling symlink");
    }
    if (!within(realRoot, real))
      throw escape(path, "symlink target is outside the project root");
    current = real;
  }
  return current;
}

/** Classify an entry without following its final link or opening its contents. */
export function entryKind(
  root: string,
  path: string,
): "file" | "directory" | "link" | "missing" | "other" {
  try {
    const info = lstatSync(resolveIn(root, path, "keep"));
    if (info.isSymbolicLink()) return "link";
    if (info.isDirectory()) return "directory";
    return info.isFile() ? "file" : "other";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "other";
  }
}

/** Prune only empty parents of a deleted file, through the named containing folder. */
export function removeEmptyParents(
  root: string,
  path: string,
  folder: string,
): void {
  let parent = path.split("/").slice(0, -1).join("/");
  while (parent === folder || parent.startsWith(`${folder}/`)) {
    try {
      rmdirSync(resolveIn(root, parent, "refuse"));
    } catch (error) {
      if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST")
        return;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    parent = parent.split("/").slice(0, -1).join("/");
  }
}

export function nodeConfigFiles(root: string): ConfigFiles {
  return {
    read(
      path,
      maxBytes = path === ".forge/config.lock"
        ? MAX_LOCK_FILE_BYTES
        : MAX_CONFIG_FILE_BYTES,
    ) {
      let fd: number;
      try {
        fd = openSync(resolveIn(root, path, "refuse"), "r");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      try {
        if (fstatSync(fd).size > maxBytes)
          throw fileLimitExceeded(path, maxBytes);
        const buffer = Buffer.allocUnsafe(maxBytes + 1);
        let count = 0;
        while (count <= maxBytes) {
          const read = readSync(fd, buffer, count, maxBytes + 1 - count, null);
          if (read === 0) break;
          count += read;
        }
        if (count > maxBytes) throw fileLimitExceeded(path, maxBytes);
        return buffer.subarray(0, count);
      } finally {
        closeSync(fd);
      }
    },
    write(path, bytes) {
      const parent = dirname(resolveIn(root, path, "refuse"));
      mkdirSync(parent, { recursive: true });
      // re-resolve once the directories exist so a link planted meanwhile is still caught
      const target = resolveIn(root, path, "refuse");
      const temporary = join(
        dirname(target),
        `.${globalThis.crypto.randomUUID()}.tmp`,
      );
      try {
        writeFileSync(temporary, bytes, { flag: "wx" });
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove(path) {
      rmSync(resolveIn(root, path, "keep"), { force: true });
    },
    list(dir) {
      try {
        return readdirSync(resolveIn(root, dir, "follow")).sort();
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    },
    createExclusive(path, bytes) {
      mkdirSync(dirname(resolveIn(root, path, "refuse")), { recursive: true });
      const target = resolveIn(root, path, "refuse");
      let fd: number;
      try {
        fd = openSync(target, "wx");
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      return true;
    },
  };
}
