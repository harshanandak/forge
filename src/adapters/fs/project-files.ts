import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import { fileLimitExceeded } from "../../core/config/files.ts";

const same = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

/** Bounded pathname mitigation, not directory-handle-relative, race-free access. */
export function nodeProjectFiles(
  root: string,
  options: { beforeOpen?: () => void } = {},
) {
  return {
    read(path: string, maxBytes: number): Uint8Array {
      const refuse = (why: string): never => {
        throw new Error(`refusing "${path}": ${why}`);
      };
      if (isAbsolute(path) || win32.isAbsolute(path))
        refuse("absolute path is outside the project root");
      const segments = path.split("/").filter((s) => s !== "" && s !== ".");
      if (segments.some((s) => s === ".." || s.includes("\\")))
        refuse("path leaves the project root");
      const realRoot = realpathSync.native(root);
      const walked = new Map<string, BigIntStats>();
      const remember = (entry: string): BigIntStats => {
        const info = lstatSync(entry, { bigint: true });
        walked.set(entry, info);
        return info;
      };
      let current = realRoot;
      remember(current);
      for (const [index, segment] of segments.entries()) {
        current = join(current, segment);
        if (!remember(current).isSymbolicLink()) continue;
        if (index === segments.length - 1)
          refuse("symlinked file is not followed");
        let target: string;
        try {
          target = realpathSync.native(current);
        } catch {
          return refuse("dangling symlink");
        }
        const rel = relative(realRoot, target);
        if (/^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel))
          refuse("symlink target is outside the project root");
        current = realRoot;
        for (const part of rel.split(sep).filter(Boolean)) {
          current = join(current, part);
          remember(current);
        }
      }
      const leaf = walked.get(current)!;
      // Opening a FIFO with no writer blocks forever, so refuse a special file before opening it.
      if (!leaf.isFile() && !leaf.isDirectory()) refuse("not a regular file");
      options.beforeOpen?.();
      const fd = openSync(current, "r");
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (
          !same(opened, leaf) ||
          [...walked].some(
            ([entry, info]) => !same(info, lstatSync(entry, { bigint: true })),
          )
        )
          refuse("project root or file changed during open");
        if (opened.size > maxBytes) throw fileLimitExceeded(path, maxBytes);
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
  };
}
