// The project files config reads and writes, rooted at the project. Injected, so tests can
// interleave two writers deterministically; the Node implementation is the real one.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface ConfigFiles {
  /** Bytes of a project-relative file, or undefined when it does not exist. */
  read(path: string): Uint8Array | undefined;
  /** Replace a file atomically: write a sibling temporary file, then rename it over. */
  write(path: string, bytes: Uint8Array): void;
  /** Remove a file; absent is fine. */
  remove(path: string): void;
  /** File names in a directory; empty when it does not exist. */
  list(dir: string): readonly string[];
  /** Create a file only if it does not exist; false when it already does. */
  createExclusive(path: string, bytes: Uint8Array): boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

let sequence = 0;

export function nodeConfigFiles(root: string): ConfigFiles {
  const at = (path: string): string => join(root, ...path.split("/"));
  return {
    read(path) {
      try {
        return readFileSync(at(path));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
    },
    write(path, bytes) {
      const target = at(path);
      mkdirSync(dirname(target), { recursive: true });
      sequence += 1;
      const temporary = `${target}.${process.pid}.${sequence}.tmp`;
      try {
        writeFileSync(temporary, bytes);
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove(path) {
      rmSync(at(path), { force: true });
    },
    list(dir) {
      try {
        return readdirSync(at(dir)).sort();
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    },
    createExclusive(path, bytes) {
      const target = at(path);
      mkdirSync(dirname(target), { recursive: true });
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
