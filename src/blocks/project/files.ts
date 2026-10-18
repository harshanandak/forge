import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only, synchronous view of one project folder. Detectors see the project only through this,
 * so they run unchanged over a real folder, an in-memory tree in a test, or any reader an
 * assembly injects. Paths are relative, forward-slash and never leave the project.
 */
export interface ProjectFiles {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** UTF-8 text, or undefined when the file is missing, unreadable, binary or over the size cap. */
  read(path: string): string | undefined;
  /** Entry names of a folder in code-unit order; empty when it is missing. */
  list(directory: string): readonly string[];
}

/** Manifests are small; a larger file is refused rather than slurped into memory. */
export const MAX_READ_BYTES = 1_048_576;

function safeRelative(path: string): string | undefined {
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return undefined;
  const parts = path.split("/");
  return parts.includes("..") || path.includes("\\") || path.includes("\0")
    ? undefined
    : path;
}

/**
 * True only when every segment exists with exactly this spelling. A case-folding disk would
 * otherwise answer for `Docs/ADR` when asked about `docs/adr`, and the same project would detect
 * differently on another machine.
 */
function existsExactly(root: string, relative: string): boolean {
  let current = root;
  for (const segment of relative.split("/")) {
    try {
      if (!readdirSync(current).includes(segment)) return false;
    } catch {
      return false;
    }
    current = join(current, segment);
  }
  return true;
}

export function createFolderFiles(root: string): ProjectFiles {
  const absolute = (path: string): string | undefined => {
    if (path === ".") return root;
    const relative = safeRelative(path);
    return relative === undefined || !existsExactly(root, relative)
      ? undefined
      : join(root, relative);
  };
  return {
    exists(path) {
      const target = absolute(path);
      if (target === undefined) return false;
      try {
        statSync(target);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory(path) {
      const target = absolute(path);
      if (target === undefined) return false;
      try {
        return statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    read(path) {
      const target = absolute(path);
      if (target === undefined) return undefined;
      try {
        const stat = statSync(target);
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined;
        const buffer = Buffer.alloc(stat.size);
        const handle = openSync(target, "r");
        try {
          readSync(handle, buffer, 0, stat.size, 0);
        } finally {
          closeSync(handle);
        }
        if (buffer.subarray(0, 8000).includes(0)) return undefined;
        return buffer.toString("utf8").replace(/^﻿/, "");
      } catch {
        return undefined;
      }
    },
    list(directory) {
      const target = absolute(directory);
      if (target === undefined) return [];
      try {
        return readdirSync(target).sort();
      } catch {
        return [];
      }
    },
  };
}

/** An in-memory tree: keys are file paths, values their text. Folders exist because files are under them. */
export function createMemoryFiles(
  tree: Readonly<Record<string, string>>,
): ProjectFiles {
  const paths = Object.keys(tree);
  const entries = (directory: string): string[] => {
    const prefix = directory === "" || directory === "." ? "" : `${directory}/`;
    const names = new Set<string>();
    for (const path of paths) {
      if (path.startsWith(prefix) && path !== directory) {
        names.add(path.slice(prefix.length).split("/")[0] as string);
      }
    }
    return [...names].sort();
  };
  return {
    exists: (path) =>
      path in tree ||
      paths.some((candidate) => candidate.startsWith(`${path}/`)),
    isDirectory: (path) =>
      !(path in tree) &&
      paths.some((candidate) => candidate.startsWith(`${path}/`)),
    read: (path) => tree[path],
    list: (directory) => entries(directory),
  };
}
