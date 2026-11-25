import { expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsPrivateFiles } from "../../src/adapters/process/windows-acl.ts";

setDefaultTimeout(30_000);

export interface JournalAppendPolicy {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

export interface JournalReadResult {
  readonly lines: readonly string[];
  readonly incomplete: boolean;
}

export interface Journal {
  append(line: string, policy?: JournalAppendPolicy): void;
  read(): JournalReadResult;
}

export interface JournalFactoryOptions {
  readonly root: string;
  readonly instance: string;
  readonly insideLock?: () => void;
  readonly afterRead?: (path: string) => void;
  readonly publish?: (from: string, to: string) => void;
}

export type JournalFactory = (options: JournalFactoryOptions) => Journal;

const minimumMaxBytes = 131_072;

function journalDirectory(root: string, instance: string): string {
  return join(root, "logs", instance);
}

function journalCurrent(root: string, instance: string): string {
  return join(journalDirectory(root, instance), "journal.jsonl");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function lineBytes(line: string): number {
  return byteLength(line) + 1;
}

function withRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "forge-journal-contract-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function recordOf(byteTarget: number, unicode: boolean, marker = "a"): string {
  const overhead = byteLength(`{"v":""}`);
  const fill = byteTarget - overhead;
  if (fill < 1 || byteLength(marker) !== 1)
    throw new Error("record target is too small");
  let pairs = unicode ? Math.floor(fill / 2) : 0;
  let ascii = unicode ? fill % 2 : fill;
  if (unicode && ascii === 0) {
    pairs -= 1;
    ascii = 2;
  }
  const value = `${"é".repeat(pairs)}${marker}${"a".repeat(ascii - 1)}`;
  const record = `{"v":"${value}"}`;
  expect(byteLength(record)).toBe(byteTarget);
  return record;
}

function prepareDirectory(root: string): string {
  const logs = join(root, "logs");
  const directory = join(logs, "memory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const native = windowsPrivateFiles();
    for (const path of [logs, directory])
      native.protect(path, `D:P(A;OICI;FA;;;${native.sid})`);
  } else {
    chmodSync(logs, 0o700);
    chmodSync(directory, 0o700);
  }
  return directory;
}

function seedGeneration(root: string, name: string, text: string): string {
  const directory = prepareDirectory(root);
  const path = join(directory, name);
  writeFileSync(path, text, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

function generationNames(root: string): string[] {
  return readdirSync(journalDirectory(root, "memory"))
    .filter(
      (name) => name === "journal.jsonl" || /^journal\.jsonl\.\d+$/.test(name),
    )
    .sort();
}

function journalText(root: string, name = "journal.jsonl"): string {
  return readFileSync(join(journalDirectory(root, "memory"), name), "utf8");
}

function protectWindows(path: string): void {
  const native = windowsPrivateFiles();
  native.protect(path, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
}

export function journalContract(
  label: string,
  factory: () => JournalFactory,
): void {
  const policy = { maxBytes: minimumMaxBytes, maxFiles: 4 } as const;

  test(`journal capability is available (${label})`, () => {
    expect(factory()).toBeFunction();
  });

  test(`append keeps UTF8 lines and rotates at the exact byte boundary (${label})`, () => {
    const create = factory();
    for (const unicode of [false, true]) {
      for (const over of [false, true]) {
        withRoot((root) => {
          const journal = create({ root, instance: "memory" });
          const first = `{"n":0}`;
          const target =
            minimumMaxBytes - lineBytes(first) - 1 + (over ? 1 : 0);
          const second = recordOf(target, unicode);
          expect(lineBytes(first) + lineBytes(second)).toBe(
            minimumMaxBytes + (over ? 1 : 0),
          );
          journal.append(first, policy);
          journal.append(second, policy);
          expect(journal.read()).toEqual({
            lines: [first, second],
            incomplete: false,
          });
          if (over) {
            expect(journalText(root, "journal.jsonl.1")).toBe(`${first}\n`);
            expect(journalText(root)).toBe(`${second}\n`);
          } else {
            expect(journalText(root)).toBe(`${first}\n${second}\n`);
            expect(
              existsSync(
                join(journalDirectory(root, "memory"), "journal.jsonl.1"),
              ),
            ).toBe(false);
          }
          for (const name of generationNames(root))
            expect(
              lstatSync(join(journalDirectory(root, "memory"), name)).size,
            ).toBeLessThanOrEqual(minimumMaxBytes);
        });
      }
    }
  });

  test(`rotation bounds active and archived bytes (${label})`, () => {
    const create = factory();
    withRoot((root) => {
      const journal = create({ root, instance: "memory" });
      const first = recordOf(minimumMaxBytes - 1, false);
      const second = `{"n":2}`;
      journal.append(first, { maxBytes: minimumMaxBytes, maxFiles: 1 });
      journal.append(second, { maxBytes: minimumMaxBytes, maxFiles: 1 });
      expect(journal.read()).toEqual({ lines: [second], incomplete: false });
      expect(generationNames(root)).toEqual(["journal.jsonl"]);
      expect(
        lstatSync(journalCurrent(root, "memory")).size,
      ).toBeLessThanOrEqual(minimumMaxBytes);
    });
    withRoot((root) => {
      const journal = create({ root, instance: "memory" });
      const records = Array.from({ length: 6 }, (_, index) =>
        recordOf(minimumMaxBytes - 1, index % 2 === 0, String(index)),
      );
      for (const record of records) journal.append(record, policy);
      expect(journal.read()).toEqual({
        lines: records.slice(-4),
        incomplete: false,
      });
      const names = generationNames(root);
      expect(names).toHaveLength(4);
      expect(names).toContain("journal.jsonl.3");
      expect(names).not.toContain("journal.jsonl.4");
      let total = 0;
      for (const name of names) {
        const size = lstatSync(
          join(journalDirectory(root, "memory"), name),
        ).size;
        expect(size).toBeLessThanOrEqual(minimumMaxBytes);
        total += size;
      }
      expect(total).toBeLessThanOrEqual(minimumMaxBytes * 4);
    });
    withRoot((root) => {
      const journal = create({ root, instance: "memory" });
      const oversize = recordOf(minimumMaxBytes, false);
      expect(lineBytes(oversize)).toBe(minimumMaxBytes + 1);
      expect(() => journal.append(oversize, policy)).toThrow(/LIMIT_EXCEEDED/);
      expect(existsSync(journalCurrent(root, "memory"))).toBe(false);
    });
    withRoot((root) => {
      const first = `{"n":1}`;
      const second = `{"n":2}`;
      const third = `{"n":3}`;
      seedGeneration(root, "journal.jsonl", `${second}\n`);
      seedGeneration(root, "journal.jsonl.1", `${first}\n`);
      const journal = create({ root, instance: "memory" });
      journal.append(third, { maxBytes: minimumMaxBytes, maxFiles: 1 });
      expect(journal.read()).toEqual({
        lines: [second, third],
        incomplete: false,
      });
      expect(generationNames(root)).toEqual(["journal.jsonl"]);
    });
  });

  test(`journal readers never create or repair files (${label})`, () => {
    const create = factory();
    withRoot((root) => {
      const missing = join(root, "missing");
      const journal = create({ root: missing, instance: "memory" });
      expect(journal.read()).toEqual({ lines: [], incomplete: false });
      expect(existsSync(missing)).toBe(false);
    });
    withRoot((root) => {
      const first = `{"n":1}`;
      const path = seedGeneration(root, "journal.jsonl", `${first}\npartial`);
      const before = readFileSync(path);
      const journal = create({ root, instance: "memory" });
      expect(journal.read()).toEqual({ lines: [first], incomplete: true });
      expect(readFileSync(path)).toEqual(before);
      expect(readdirSync(journalDirectory(root, "memory"))).toEqual([
        "journal.jsonl",
      ]);
    });
    withRoot((root) => {
      const first = `{"n":1}`;
      const path = seedGeneration(root, "journal.jsonl", `${first}\n`);
      let raced = false;
      const journal = create({
        root,
        instance: "memory",
        afterRead(changed) {
          if (changed === path && !raced) {
            raced = true;
            appendFileSync(changed, "race");
          }
        },
      });
      expect(journal.read().incomplete).toBe(true);
      expect(raced).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(`${first}\nrace`);
    });
  });

  test(`private journal writes serialize and survive interrupted rotation (${label})`, () => {
    const create = factory();
    withRoot((root) => {
      const outerLine = `{"writer":"outer"}`;
      const innerLine = `{"writer":"inner"}`;
      let innerError: unknown;
      const journal = create({
        root,
        instance: "memory",
        insideLock() {
          try {
            create({ root, instance: "memory" }).append(innerLine, policy);
          } catch (error) {
            innerError = error;
          }
        },
      });
      journal.append(outerLine, policy);
      expect(String(innerError)).toContain("INPUT_CONFLICT");
      expect(journal.read()).toEqual({ lines: [outerLine], incomplete: false });
    });
    withRoot((root) => {
      const records = Array.from({ length: 5 }, (_, index) =>
        recordOf(minimumMaxBytes - 1, false, String(index)),
      );
      const setup = create({ root, instance: "memory" });
      for (const record of records) setup.append(record, policy);
      let rotations = 0;
      const faulted = create({
        root,
        instance: "memory",
        publish(from, to) {
          renameSync(from, to);
          rotations += 1;
          if (rotations === 1)
            throw new Error("interrupted rotation publication");
        },
      });
      const next = `{"n":"next"}`;
      expect(() => faulted.append(next, policy)).toThrow(
        /interrupted rotation publication/,
      );
      const result = faulted.read();
      expect(result.incomplete).toBe(false);
      expect(result.lines).toEqual(records.slice(2));
    });
  });

  test(`journal refuses links and nonprivate targets (${label})`, () => {
    const create = factory();
    withRoot((root) => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      const preserved = join(outside, "journal.jsonl");
      writeFileSync(preserved, `{"preserved":true}\n`);
      mkdirSync(join(root, "logs"));
      symlinkSync(outside, join(root, "logs", "memory"), "junction");
      const journal = create({ root, instance: "memory" });
      expect(() => journal.read()).toThrow(/INPUT_INVALID/);
      expect(() => journal.append(`{"n":1}`, policy)).toThrow(/INPUT_INVALID/);
      expect(readFileSync(preserved, "utf8")).toBe(`{"preserved":true}\n`);
    });
    withRoot((root) => {
      prepareDirectory(root);
      mkdirSync(journalCurrent(root, "memory"));
      const journal = create({ root, instance: "memory" });
      expect(() => journal.read()).toThrow(/INPUT_INVALID/);
      expect(() => journal.append(`{"n":1}`, policy)).toThrow(/INPUT_INVALID/);
    });
    withRoot((root) => {
      const windows = process.platform === "win32";
      const journal = create({ root, instance: "memory" });
      const line = `{"n":1}`;
      journal.append(line, policy);
      const current = journalCurrent(root, "memory");
      if (windows) protectWindows(current);
      else chmodSync(current, 0o666);
      expect(() => journal.read()).toThrow(/INPUT_INVALID|Private ACL/);
      expect(() => journal.append(line, policy)).toThrow(
        /INPUT_INVALID|Private ACL/,
      );
    });
  });
}
