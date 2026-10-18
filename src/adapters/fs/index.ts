// Project files on the local filesystem through node:fs, rooted at the project: the Node
// implementation of the ConfigFiles port. Paths arrive project-relative with "/" separators.
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
import type { ConfigFiles } from "../../core/config/files.ts";

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
