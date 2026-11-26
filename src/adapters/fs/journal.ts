import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { ForgeFailure } from "../../contract/failure.ts";
import type {
  Journal,
  JournalAppendPolicy,
  JournalFileSecurity,
} from "../../ports/journal.ts";
import {
  createPrivateDirectory,
  createPrivateFile,
  removeDurable,
  replaceDurable,
  writePrivateTextAtomic,
} from "./durable-io.ts";

export interface LocalJournalOptions {
  readonly root: string;
  readonly instance: string;
  readonly insideLock?: () => void;
  readonly afterRead?: (path: string) => void;
  readonly publish?: (from: string, to: string) => void;
  readonly security?: JournalFileSecurity;
}

const minimumMaxBytes = 131_072;
const maximumMaxBytes = 1_048_576;
const defaultMaxBytes = 262_144;
const defaultMaxFiles = 4;

function refuse(code: string, message: string): never {
  throw new ForgeFailure({ code, message, retry: "never" });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function validInstance(instance: string): void {
  if (
    instance.length < 1 ||
    instance.length > 128 ||
    instance === "." ||
    instance === ".." ||
    /[\\/:\0]/.test(instance)
  )
    refuse("INPUT_INVALID", "Journal instance must be one safe path segment");
}

function policyOf(policy: JournalAppendPolicy) {
  const maxBytes = policy.maxBytes ?? defaultMaxBytes;
  const maxFiles = policy.maxFiles ?? defaultMaxFiles;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < minimumMaxBytes ||
    maxBytes > maximumMaxBytes ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 8
  )
    refuse("INPUT_INVALID", "Journal policy is outside its bounded range");
  return { maxBytes, maxFiles };
}

function validLine(line: string): void {
  if (typeof line !== "string" || line.includes("\n") || line.includes("\r"))
    refuse("INPUT_INVALID", "Journal records are single JSON lines");
  try {
    JSON.parse(line);
  } catch {
    refuse("INPUT_INVALID", "Journal records are single JSON lines");
  }
}

function makeDirectories(path: string): boolean {
  if (!missing(path)) return false;
  const parent = dirname(path);
  if (parent !== path) makeDirectories(parent);
  try {
    createPrivateDirectory(path);
    return true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST" || !lstatSync(path).isDirectory())
      throw error;
    return true;
  }
}

export function createLocalJournal(options: LocalJournalOptions): Journal {
  validInstance(options.instance);
  const logs = join(options.root, "logs");
  const directory = join(logs, options.instance);
  const current = join(directory, "journal.jsonl");
  const lock = join(directory, "journal.lock");
  const publish = options.publish ?? replaceDurable;
  const generations = Array.from({ length: 7 }, (_, index) =>
    join(directory, `journal.jsonl.${7 - index}`),
  ).concat(current);
  const security = options.security;

  function inspectDirectory(path: string, created: boolean): void {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      refuse("INPUT_INVALID", "Journal directory must be a real directory");
    security?.directory(path, created);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      refuse("INPUT_INVALID", "Journal directory is not private");
  }

  function inspectFile(path: string): Stats {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      refuse("INPUT_INVALID", "Journal generation must be one private file");
    security?.file(path);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      refuse("INPUT_INVALID", "Journal generation is not private");
    return info;
  }

  function prepareDirectory(): void {
    inspectDirectory(logs, makeDirectories(logs));
    inspectDirectory(directory, makeDirectories(directory));
  }

  function rotate(maxFiles: number): void {
    const archives = maxFiles - 1;
    if (archives === 0) {
      if (!missing(current)) removeDurable(current);
      return;
    }
    const oldest = join(directory, `journal.jsonl.${archives}`);
    if (!missing(oldest)) removeDurable(oldest);
    for (let index = archives - 1; index >= 1; index -= 1) {
      const from = join(directory, `journal.jsonl.${index}`);
      if (!missing(from))
        publish(from, join(directory, `journal.jsonl.${index + 1}`));
    }
    if (!missing(current)) publish(current, join(directory, "journal.jsonl.1"));
  }

  function prune(maxFiles: number): void {
    for (let index = maxFiles; index <= 7; index += 1) {
      const extra = join(directory, `journal.jsonl.${index}`);
      if (!missing(extra)) removeDurable(extra);
    }
  }

  function boundedRead(path: string, size: number) {
    const fd = openSync(path, "r");
    try {
      const length = Math.min(size, maximumMaxBytes);
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, bytes, offset, length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      return {
        text: bytes.toString("utf8", 0, offset),
        truncated: size > maximumMaxBytes,
      };
    } finally {
      closeSync(fd);
    }
  }

  return {
    append(line, policy = {}) {
      validLine(line);
      const { maxBytes, maxFiles } = policyOf(policy);
      const recordBytes = Buffer.byteLength(line, "utf8") + 1;
      if (recordBytes > maxBytes)
        refuse("LIMIT_EXCEEDED", "Journal record exceeds the active byte cap");
      prepareDirectory();
      let fd: number;
      try {
        fd = createPrivateFile(lock, false);
      } catch (error) {
        if (errorCode(error) === "EEXIST" || errorCode(error) === "EISDIR")
          refuse("INPUT_CONFLICT", "Journal writer lock is held");
        throw error;
      }
      try {
        options.insideLock?.();
        for (const path of generations) if (!missing(path)) inspectFile(path);
        const active = missing(current) ? "" : readFileSync(current, "utf8");
        if (active !== "" && !active.endsWith("\n"))
          refuse("INPUT_CONFLICT", "Journal active generation is incomplete");
        if (Buffer.byteLength(active, "utf8") + recordBytes > maxBytes)
          rotate(maxFiles);
        const retained = missing(current) ? "" : readFileSync(current, "utf8");
        writePrivateTextAtomic(current, `${retained}${line}\n`);
        prune(maxFiles);
      } finally {
        try {
          closeSync(fd);
        } finally {
          removeDurable(lock);
        }
      }
    },
    read() {
      if (missing(directory)) return { lines: [], incomplete: false };
      inspectDirectory(logs, false);
      inspectDirectory(directory, false);
      const lines: string[] = [];
      let incomplete = false;
      for (const path of generations) {
        if (missing(path)) continue;
        const before = inspectFile(path);
        const read = boundedRead(path, before.size);
        options.afterRead?.(path);
        try {
          const after = inspectFile(path);
          if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size
          )
            incomplete = true;
        } catch {
          incomplete = true;
        }
        if (read.truncated || !read.text.endsWith("\n")) incomplete = true;
        for (const line of read.text.split("\n").slice(0, -1))
          if (line !== "") lines.push(line);
      }
      return { lines, incomplete };
    },
  };
}
