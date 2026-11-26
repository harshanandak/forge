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
  existsSync,
  fstatSync,
  fsyncSync,
  type BigIntStats,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";
import type { ConfigFiles } from "../../core/config/files.ts";
import {
  MAX_CONFIG_FILE_BYTES,
  MAX_LOCK_FILE_BYTES,
  removeConflict,
} from "../../core/config/files.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import {
  publishExclusive,
  removeDurable,
  syncParentDirectory,
} from "./durable-io.ts";
import { nodeProjectFiles } from "./project-files.ts";

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
  return !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel);
}

/** How a symlink in the LAST component is treated: followed (list), refused, or left alone (remove). */
type FinalLink = "follow" | "refuse" | "keep";

export function resolveIn(
  root: string,
  path: string,
  finalLink: FinalLink,
): string {
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
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
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
      if (errorCode(error) !== "ENOENT")
        throw Object.assign(
          new Error(error instanceof Error ? error.message : String(error), {
            cause: error,
          }),
          { relativePath: parent },
        );
    }
    parent = parent.split("/").slice(0, -1).join("/");
  }
}

export function restoreClaim(
  path: string,
  target: string,
  claimed: string,
): void {
  try {
    publishExclusive(claimed, target);
  } catch (error) {
    let linked: boolean;
    try {
      linked = lstatSync(claimed).nlink > 1;
    } catch {
      linked = false;
    }
    throw new Error(
      linked
        ? `${path} was put back after a refused removal but could not be made durable; a copy is also kept at ${claimed}`
        : `${path} could not be put back after a refused removal; its content is kept at ${claimed}`,
      { cause: error },
    );
  }
  try {
    removeDurable(claimed);
  } catch {
    return;
  }
}

function restoreAfterRemoveFailure(
  path: string,
  target: string,
  claimed: string,
  failure: unknown,
): never {
  try {
    restoreClaim(path, target, claimed);
  } catch (restoreError) {
    if (!(failure instanceof Error) || failure instanceof ForgeFailure)
      throw new AggregateError(
        [failure, restoreError],
        failure instanceof Error ? failure.message : "Config removal failed",
        { cause: restoreError },
      );
    const cause: unknown = failure.cause;
    failure.cause =
      cause === undefined
        ? restoreError
        : new AggregateError([cause, restoreError], "Config removal causes");
  }
  throw failure;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function claimIntact(
  claimed: string,
  held: BigIntStats,
  expected: Uint8Array,
): boolean {
  const info = lstatSync(claimed, { bigint: true });
  return (
    info.isFile() &&
    (info.ino === 0n || held.ino === 0n || sameFile(info, held)) &&
    info.size === BigInt(expected.byteLength) &&
    Buffer.from(expected).equals(readFileSync(claimed))
  );
}

function holdsExpected(
  target: string,
  expected: Uint8Array,
): BigIntStats | undefined {
  if (!lstatSync(target).isFile()) return undefined;
  const fd = openSync(target, "r");
  let opened: BigIntStats;
  let matched: boolean;
  try {
    opened = fstatSync(fd, { bigint: true });
    matched =
      opened.isFile() &&
      opened.size === BigInt(expected.byteLength) &&
      Buffer.from(expected).equals(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
  const named = lstatSync(target, { bigint: true });
  return matched && named.isFile() && sameFile(named, opened)
    ? opened
    : undefined;
}

export function nodeConfigFiles(
  root: string,
  options: { beforeOpen?: () => void; requireExistingRemove?: boolean } = {},
): ConfigFiles {
  const files = nodeProjectFiles(root, options);
  return {
    read(
      path,
      maxBytes = path === ".forge/config.lock"
        ? MAX_LOCK_FILE_BYTES
        : MAX_CONFIG_FILE_BYTES,
    ) {
      try {
        return files.read(path, maxBytes);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
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
    remove(path, expected) {
      const target = resolveIn(root, path, "keep");
      const claimed = join(
        dirname(target),
        `.${basename(target)}.${randomUUID()}.claim`,
      );
      let held: BigIntStats;
      try {
        const found = holdsExpected(target, expected);
        if (found === undefined) throw removeConflict(path);
        held = found;
        renameSync(target, claimed);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          if (options.requireExistingRemove) throw removeConflict(path);
          return;
        }
        throw error;
      }
      try {
        if (!claimIntact(claimed, held, expected)) throw removeConflict(path);
        syncParentDirectory(claimed);
      } catch (error) {
        restoreAfterRemoveFailure(path, target, claimed, error);
      }
      try {
        removeDurable(claimed);
      } catch (error) {
        if (existsSync(claimed))
          restoreAfterRemoveFailure(path, target, claimed, error);
      }
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
      // Write and sync a sibling file, then publish it with a link that fails if the target exists,
      // so a crash never leaves an empty, partial or unsynced file at the target.
      const temporary = join(
        dirname(target),
        `.${basename(target)}.${randomUUID()}.tmp`,
      );
      const fd = openSync(temporary, "wx");
      try {
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          publishExclusive(temporary, target);
        } catch (error) {
          if (errorCode(error) === "EEXIST") return false;
          throw error;
        }
        return true;
      } finally {
        try {
          removeDurable(temporary);
        } catch {
          /* A leftover hidden temporary file must not turn a published create into a failure. */
        }
      }
    },
  };
}

export { createLocalJournal } from "./journal.ts";
