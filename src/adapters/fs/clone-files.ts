import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, parse, relative, resolve, win32 } from "node:path";
import { ForgeFailure } from "../../contract/failure.ts";
import {
  createPrivateDirectory,
  createPrivateFile,
  removeDurable,
  replaceDurable,
} from "./durable-io.ts";

export type CloneFileArea = "project" | "git" | "common";
export interface CloneFilesOptions {
  readonly projectRoot: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly signal: AbortSignal;
  readonly deadline?: number;
  readonly maxBytes?: number;
}
export interface CloneFileCondition {
  readonly expected?: string | null;
  readonly area?: CloneFileArea;
}
export interface CloneFileWriteOptions extends CloneFileCondition {
  readonly executable?: boolean;
}
export interface CloneFilesService {
  readonly root: string;
  readonly roots: Readonly<Record<CloneFileArea, string>>;
  read(
    path: string,
    maxBytes: number,
    area?: CloneFileArea,
  ): string | undefined;
  write(path: string, text: string, options?: CloneFileWriteOptions): void;
  remove(path: string, options?: CloneFileCondition): void;
  inspect(path: string, area?: CloneFileArea): CloneFileInspection | undefined;
}
export interface CloneFileInspection {
  readonly regular: boolean;
  readonly executable: boolean;
  readonly size: number;
}

const MAX_BYTES = 1_048_576;
function failure(code: string, message: string): never {
  throw new ForgeFailure({
    code,
    message,
    retry: code === "INPUT_CONFLICT" ? "reconcile_first" : "never",
  });
}
function active(options: CloneFilesOptions): void {
  options.signal.throwIfAborted();
  if (options.deadline !== undefined && Date.now() >= options.deadline)
    failure(
      "INVOCATION_TIMEOUT",
      "Clone file service invocation deadline expired",
    );
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
function boundedLimit(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    failure(
      "INPUT_INVALID",
      `File byte limit must be an integer from 1 to ${ceiling}`,
    );
  return value;
}
function stat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
function directory(path: string): void {
  const info = stat(path);
  if (info === null || !info.isDirectory() || info.isSymbolicLink())
    failure(
      "INPUT_INVALID",
      "Clone file root or parent must be an existing directory without symlinks",
    );
}
function validateRoot(path: string): string {
  if (!isAbsolute(path))
    failure("INPUT_INVALID", "Clone file roots must be absolute");
  const root = resolve(path);
  let current = parse(root).root;
  directory(current);
  for (const segment of relative(current, root)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, segment);
    directory(current);
  }
  return root;
}
function segmentsOf(path: string): readonly string[] {
  if (path.length > 4096)
    failure(
      "INPUT_INVALID",
      "Clone file path exceeds the platform path safety ceiling",
    );
  const segments = path.split("/");
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
    )
  )
    failure(
      "INPUT_INVALID",
      "Clone file path must be a strict relative path without platform aliases",
    );
  return segments;
}
function regular(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    failure(
      "INPUT_INVALID",
      "Clone files must be regular files without symlinks or hard links",
    );
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function createCloneFilesAccess(options: CloneFilesOptions): {
  readonly service: CloneFilesService;
  readonly readBytes: (
    path: string,
    maxBytes: number,
  ) => Uint8Array | undefined;
} {
  active(options);
  const limit = boundedLimit(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const roots: Readonly<Record<CloneFileArea, string>> = Object.freeze({
    project: validateRoot(options.projectRoot),
    git: validateRoot(options.gitDirectory),
    common: validateRoot(options.commonDirectory),
  });
  function targetFor(
    area: CloneFileArea,
    path: string,
    createParents = false,
    inspectFinal = false,
  ): string {
    active(options);
    const root = roots[area];
    if (root === undefined) failure("INPUT_INVALID", "Unknown clone file area");
    validateRoot(root);
    const segments = segmentsOf(path);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let info = stat(current);
      if (info === null && createParents) {
        active(options);
        try {
          createPrivateDirectory(current);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        info = stat(current);
      }
      if (info !== null && (!info.isDirectory() || info.isSymbolicLink()))
        failure(
          "INPUT_INVALID",
          "Clone file parents must be directories without symlinks",
        );
    }
    const target = join(root, ...segments);
    const info = stat(target);
    if (info !== null && !inspectFinal) regular(info);
    return target;
  }
  function readBytes(
    area: CloneFileArea,
    path: string,
    maxBytes: number,
  ): Uint8Array | undefined {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > limit)
      failure("INPUT_INVALID", "Clone file byte budget is invalid");
    const max = maxBytes;
    const target = targetFor(area, path);
    const before = stat(target);
    if (before === null) return undefined;
    let fd: number;
    try {
      fd = openSync(
        target,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    try {
      const opened = fstatSync(fd);
      regular(opened);
      if (!sameFile(before, opened))
        failure("INPUT_CONFLICT", "Clone file changed while opening");
      if (opened.size > max)
        failure("LIMIT_EXCEEDED", "Clone file exceeds the declared byte limit");
      const buffer = Buffer.alloc(max + 1);
      let count = 0;
      while (count < buffer.length) {
        active(options);
        const progress = readSync(
          fd,
          buffer,
          count,
          buffer.length - count,
          null,
        );
        if (progress === 0) break;
        count += progress;
      }
      if (count > max)
        failure("LIMIT_EXCEEDED", "Clone file exceeds the declared byte limit");
      const after = fstatSync(fd);
      regular(after);
      const current = stat(targetFor(area, path));
      if (
        current === null ||
        !sameFile(opened, current) ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs
      )
        failure("INPUT_CONFLICT", "Clone file changed during read");
      return buffer.subarray(0, count);
    } finally {
      closeSync(fd);
    }
  }
  function readFile(
    area: CloneFileArea,
    path: string,
    maxBytes: number,
  ): string | undefined {
    const bytes = readBytes(area, path, boundedLimit(maxBytes, limit));
    if (bytes === undefined) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      failure("INPUT_INVALID", "Clone file content must be valid UTF-8");
    }
  }
  function mutation(
    area: CloneFileArea,
    path: string,
    condition: CloneFileCondition,
    text?: string,
    executable = false,
  ): void {
    active(options);
    if (!options.write)
      failure(
        "EFFECT_UNDECLARED",
        "Clone file mutation requires the declared files:write effect",
      );
    if (text !== undefined && Buffer.byteLength(text, "utf8") > limit)
      failure("LIMIT_EXCEEDED", "Clone file exceeds the declared byte limit");
    if (text !== undefined && !text.isWellFormed())
      failure("INPUT_INVALID", "Clone file text must be valid Unicode");
    const target = targetFor(area, path);
    if (text === undefined && stat(target) === null) {
      if (condition.expected !== undefined && condition.expected !== null)
        failure(
          "INPUT_CONFLICT",
          "Clone file no longer matches expected content",
        );
      return;
    }
    targetFor(area, path, true);
    const lock = `${target}.lock`;
    let fd: number;
    try {
      fd = createPrivateFile(lock, executable);
    } catch (error) {
      if (errorCode(error) === "EEXIST")
        failure(
          "INPUT_CONFLICT",
          "Clone file is locked by another writer; inspect its lock before retrying",
        );
      throw error;
    }
    let promoted = false;
    try {
      const current = readFile(area, path, limit) ?? null;
      if (condition.expected !== undefined && current !== condition.expected)
        failure(
          "INPUT_CONFLICT",
          "Clone file no longer matches expected content",
        );
      active(options);
      if (text === undefined) {
        if (current !== null) {
          targetFor(area, path);
          removeDurable(target);
        }
      } else if (
        current !== text ||
        (process.platform !== "win32" &&
          ((stat(target)?.mode ?? 0) & 0o111) !== (executable ? 0o100 : 0))
      ) {
        writeFileSync(fd, text, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = -1;
        targetFor(area, path);
        active(options);
        replaceDurable(lock, target);
        promoted = true;
      }
    } finally {
      if (fd !== -1) closeSync(fd);
      if (!promoted && stat(lock) !== null) removeDurable(lock);
    }
  }
  const service: CloneFilesService = Object.freeze({
    get root(): string {
      active(options);
      return roots.project;
    },
    get roots(): Readonly<Record<CloneFileArea, string>> {
      active(options);
      return roots;
    },
    read(
      path: string,
      maxBytes: number,
      area: CloneFileArea = "project",
    ): string | undefined {
      active(options);
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone file reads require the declared files:read effect",
        );
      return readFile(area, path, maxBytes);
    },
    write(
      path: string,
      text: string,
      condition: CloneFileWriteOptions = {},
    ): void {
      mutation(
        condition.area ?? "project",
        path,
        condition,
        text,
        condition.executable ?? false,
      );
    },
    remove(path: string, condition: CloneFileCondition = {}): void {
      mutation(condition.area ?? "project", path, condition);
    },
    inspect(
      path: string,
      area: CloneFileArea = "project",
    ): CloneFileInspection | undefined {
      active(options);
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone file inspection requires the declared files:read effect",
        );
      const info = stat(targetFor(area, path, false, true));
      active(options);
      if (info === null) return undefined;
      const regularFile =
        info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
      return {
        regular: regularFile,
        executable:
          regularFile &&
          (process.platform === "win32" || (info.mode & 0o111) !== 0),
        size: info.size,
      };
    },
  });
  return {
    service,
    readBytes(path: string, maxBytes: number): Uint8Array | undefined {
      active(options);
      if (!options.read)
        failure(
          "EFFECT_UNDECLARED",
          "Clone file reads require the declared files:read effect",
        );
      return readBytes("project", path, maxBytes);
    },
  };
}

export function createCloneFiles(
  options: CloneFilesOptions,
): CloneFilesService {
  return createCloneFilesAccess(options).service;
}

/** The ordered paths and missing markers are framed separately from exact file bytes. */
export function digestCloneFiles(
  options: CloneFilesOptions,
  paths: readonly string[],
  maxTotalBytes: number,
): string {
  active(options);
  if (!options.read)
    failure(
      "EFFECT_UNDECLARED",
      "Clone file digests require the declared files:read effect",
    );
  if (paths.length > 1024)
    failure(
      "LIMIT_EXCEEDED",
      "Clone snapshot exceeds the 1024 selected-path safety ceiling",
    );
  boundedLimit(maxTotalBytes, MAX_BYTES * 1024);
  const seen = new Set<string>();
  for (const path of paths) {
    segmentsOf(path);
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(identity))
      failure("INPUT_INVALID", "Clone snapshot paths must be unique");
    seen.add(identity);
  }
  const access = createCloneFilesAccess(options);
  const hash = createHash("sha256").update("forge.clone-files/v1\0");
  let remaining = maxTotalBytes;
  for (const path of paths) {
    const bytes = access.readBytes(
      path,
      Math.min(remaining, options.maxBytes ?? MAX_BYTES),
    );
    hash.update(JSON.stringify([path, bytes?.byteLength ?? null]));
    hash.update("\0");
    if (bytes !== undefined) {
      hash.update(bytes);
      remaining -= bytes.byteLength;
    }
  }
  active(options);
  return hash.digest("hex");
}
