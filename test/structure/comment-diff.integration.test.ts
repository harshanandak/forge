import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as childProcess from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const nativeChildProcess = { ...childProcess };
const nativeExecFileSync = nativeChildProcess.execFileSync;
const spawns: unknown[] = [];
const roots: string[] = [];

interface SnapshotFile {
  readonly text: string;
  readonly added: ReadonlySet<number>;
}
interface Snapshot {
  readonly head: string;
  readonly files: Map<string, SnapshotFile>;
  readonly currentHead: () => string;
}
interface CommentDiffModule {
  readonly commentDiff: (
    root: string,
    base: string,
    roots?: readonly string[],
  ) => Snapshot;
  readonly readCommittedTexts?: (
    root: string,
    head: string,
    files: readonly string[],
  ) => Map<string, string>;
  readonly parseCatFileBatch?: (
    output: Buffer,
    oids: readonly string[],
  ) => Buffer[];
  readonly parseLsTree?: (output: string) => Map<string, string>;
  readonly resolveBlobIds?: (
    files: readonly string[],
    blobs: ReadonlyMap<string, string>,
  ) => string[];
}

let tested: CommentDiffModule | undefined;
function api(): CommentDiffModule {
  if (!tested) throw new Error("The comment-diff module did not load");
  return tested;
}
function git(root: string, ...args: string[]): string {
  return nativeExecFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe",
  }).trim();
}
function put(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
function repository(headFiles: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "forge-comment-diff-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  put(root, ".gitattributes", "* -text\n");
  put(root, "src/base.ts", "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "base");
  for (const [file, text] of Object.entries(headFiles)) put(root, file, text);
  git(root, "add", ".");
  git(root, "commit", "-qm", "head");
  return root;
}
function symlinkRepository(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-comment-diff-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  put(root, ".gitattributes", "* -text\n");
  put(root, "src/base.ts", "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "base");
  put(root, "target.ts", "export const target = 1;\n");
  const blob = git(root, "hash-object", "-w", "target.ts");
  rmSync(join(root, "target.ts"));
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${blob},src/link.ts`,
  );
  git(root, "commit", "-qm", "symlink");
  return { root, head: git(root, "rev-parse", "HEAD") };
}
function subcommandOf(entry: unknown): string {
  if (!Array.isArray(entry)) return "";
  const command: unknown = entry[3];
  return typeof command === "string" ? command : "";
}
function blobSubcommands(): string[] {
  return spawns
    .map(subcommandOf)
    .filter(
      (command) =>
        command === "show" || command === "cat-file" || command === "ls-tree",
    );
}
function frame(oid: string, kind: string, body?: string): Buffer {
  if (kind === "missing") return Buffer.from(`${oid} missing\n`, "latin1");
  const content = body === undefined ? "" : body;
  return Buffer.concat([
    Buffer.from(`${oid} ${kind} ${Buffer.byteLength(content)}\n`, "latin1"),
    Buffer.from(content, "utf8"),
    Buffer.from("\n", "latin1"),
  ]);
}
function parse(): (output: Buffer, oids: readonly string[]) => Buffer[] {
  const parseFrames = api().parseCatFileBatch;
  if (typeof parseFrames !== "function")
    throw new Error("The batch frame parser is unavailable");
  return parseFrames;
}
function parseTree(): (output: string) => Map<string, string> {
  const parseListing = api().parseLsTree;
  if (typeof parseListing !== "function")
    throw new Error("The tree listing parser is unavailable");
  return parseListing;
}
function blobIds(): (
  files: readonly string[],
  blobs: ReadonlyMap<string, string>,
) => string[] {
  const resolve = api().resolveBlobIds;
  if (typeof resolve !== "function")
    throw new Error("The blob resolver is unavailable");
  return resolve;
}
function readTexts(): (
  root: string,
  head: string,
  files: readonly string[],
) => Map<string, string> {
  const read = api().readCommittedTexts;
  if (typeof read !== "function")
    throw new Error("The batch blob reader is unavailable");
  return read;
}

const byteFiles: Record<string, string> = {
  "src/with space.ts": "const first = 1;\r\nconst second = 2;\r\n",
  "src/ünicode-😀.ts": 'export const smile = "😀";\n',
  "src/glob[x]{a,b}.ts": "\uFEFFconst bom = 1;\r\nconst feed = 2;\n",
};
const twoFiles: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 2;\n",
};
const twentyFiles: Record<string, string> = {};
for (let index = 0; index < 20; index++)
  twentyFiles[`src/file-${index}.ts`] =
    `export const value${index} = ${index};\n`;

let byteRoot = "";
let smallRoot = "";
let bigRoot = "";
beforeAll(async () => {
  byteRoot = repository(byteFiles);
  smallRoot = repository(twoFiles);
  bigRoot = repository(twentyFiles);
  await mock.module("node:child_process", () => ({
    ...nativeChildProcess,
    execFileSync: (...args: never[]) => {
      spawns.push(args[1]);
      const result: unknown = Reflect.apply(
        nativeChildProcess.execFileSync,
        undefined,
        args,
      );
      return result;
    },
    spawnSync: (...args: never[]) => {
      spawns.push(args[1]);
      const result: unknown = Reflect.apply(
        nativeChildProcess.spawnSync,
        undefined,
        args,
      );
      return result;
    },
  }));
  tested =
    (await import("../../tools/checks/comment-diff.ts")) as unknown as CommentDiffModule;
}, 120_000);
afterAll(() => {
  mock.restore();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("committed text stays byte-identical across literal names and newlines", () => {
  const snapshot = api().commentDiff(byteRoot, "base");
  for (const [file, text] of Object.entries(byteFiles))
    expect(snapshot.files.get(file)?.text).toBe(text);
  expect(snapshot.files.size).toBe(Object.keys(byteFiles).length);
}, 30_000);

test("committed reads use one list and one batch process for any file count", () => {
  const read = readTexts();
  const smallHead = git(smallRoot, "rev-parse", "HEAD");
  spawns.length = 0;
  const smallTexts = read(smallRoot, smallHead, Object.keys(twoFiles));
  const smallSpawns = spawns.length;
  expect(smallTexts.get("src/a.ts")).toBe(twoFiles["src/a.ts"]);
  expect(smallTexts.get("src/b.ts")).toBe(twoFiles["src/b.ts"]);
  const bigHead = git(bigRoot, "rev-parse", "HEAD");
  spawns.length = 0;
  const bigTexts = read(bigRoot, bigHead, Object.keys(twentyFiles));
  const bigSpawns = spawns.length;
  expect(bigTexts.size).toBe(20);
  expect(bigTexts.get("src/file-19.ts")).toBe(twentyFiles["src/file-19.ts"]);
  expect(bigSpawns).toBe(smallSpawns);
  expect(smallSpawns).toBe(2);
}, 30_000);

test("the comment snapshot reads blobs without one process per file", () => {
  spawns.length = 0;
  const small = api().commentDiff(smallRoot, "base");
  const smallBlob = blobSubcommands();
  spawns.length = 0;
  const big = api().commentDiff(bigRoot, "base");
  const bigBlob = blobSubcommands();
  expect(bigBlob).toEqual(smallBlob);
  expect(smallBlob.filter((command) => command === "show")).toHaveLength(0);
  expect(smallBlob.filter((command) => command === "cat-file")).toHaveLength(1);
  expect(smallBlob.filter((command) => command === "ls-tree")).toHaveLength(1);
  expect(small.files.size).toBe(2);
  expect(big.files.size).toBe(20);
}, 30_000);

test("batch frames decode after framing and keep every byte", () => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const bodies = ["line one\r\nline two\r\n", "\uFEFFprefix\nsuffix\n"];
  const output = Buffer.concat([
    frame(first, "blob", bodies[0]),
    frame(second, "blob", bodies[1]),
  ]);
  const parsed = parse()(output, [first, second]);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]?.equals(Buffer.from(bodies[0] ?? "", "utf8"))).toBe(true);
  expect(parsed[1]?.equals(Buffer.from(bodies[1] ?? "", "utf8"))).toBe(true);
  expect(parse()(Buffer.alloc(0), [])).toHaveLength(0);
}, 30_000);

test("the tree parser rejects non-source modes", () => {
  const oid = "c".repeat(40);
  expect(() => parseTree()(`120000 blob ${oid}\tsrc/link.ts\0`)).toThrow();
  expect(() => parseTree()(`160000 commit ${oid}\tsrc/sub.ts\0`)).toThrow();
}, 30_000);

test("a committed symlink is rejected instead of read as source", () => {
  const link = symlinkRepository();
  try {
    expect(() => readTexts()(link.root, link.head, ["src/link.ts"])).toThrow();
  } finally {
    rmSync(link.root, { recursive: true, force: true });
  }
}, 30_000);

test("blob resolution requires exactly the requested path set", () => {
  const resolve = blobIds();
  const oidA = "a".repeat(40);
  const oidB = "b".repeat(40);
  expect(resolve(["src/a.ts"], new Map([["src/a.ts", oidA]]))).toEqual([oidA]);
  expect(() => resolve(["src/a.ts"], new Map())).toThrow();
  expect(() =>
    resolve(
      ["src/a.ts"],
      new Map([
        ["src/a.ts", oidA],
        ["src/unrequested.ts", oidB],
      ]),
    ),
  ).toThrow();
}, 30_000);

test("both parsers accept a 64-character object id", () => {
  const oid = "e".repeat(64);
  const body = "export const sha = 256;\n";
  const parsed = parse()(frame(oid, "blob", body), [oid]);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.toString("utf8")).toBe(body);
  expect(
    parseTree()(`100644 blob ${oid}\tsrc/sha.ts\0`).get("src/sha.ts"),
  ).toBe(oid);
}, 30_000);

test("batch frames fail closed on missing, wrong or short output", () => {
  const oid = "c".repeat(40);
  const other = "d".repeat(40);
  expect(() => parse()(frame(oid, "missing"), [oid])).toThrow();
  expect(() => parse()(frame(oid, "commit", "data"), [oid])).toThrow();
  expect(() =>
    parse()(
      Buffer.concat([
        Buffer.from(`${oid} blob 16\n`, "latin1"),
        Buffer.from("short", "utf8"),
        Buffer.from("\n", "latin1"),
      ]),
      [oid],
    ),
  ).toThrow();
  expect(() =>
    parse()(Buffer.from("not a frame\n", "latin1"), [oid]),
  ).toThrow();
  expect(() => parse()(frame(other, "blob", "x"), [oid])).toThrow();
  expect(() =>
    parse()(Buffer.concat([frame(oid, "blob", "x"), Buffer.from("x")]), [oid]),
  ).toThrow();
  expect(() =>
    parse()(
      Buffer.concat([
        Buffer.from(`${oid} blob 16777217\n`, "latin1"),
        Buffer.from("\n", "latin1"),
      ]),
      [oid],
    ),
  ).toThrow();
  expect(() => parse()(frame(oid, "blob", "x"), [])).toThrow();
}, 30_000);

function lsTreePathCalls(): string[][] {
  const calls: string[][] = [];
  for (const entry of spawns) {
    if (!Array.isArray(entry)) continue;
    const args = entry as unknown[];
    if (!args.includes("ls-tree")) continue;
    const sep = args.indexOf("--");
    if (sep < 0) continue;
    const paths = args
      .slice(sep + 1)
      .filter((part): part is string => typeof part === "string");
    calls.push(paths);
  }
  return calls;
}
function lsTreePathCost(paths: readonly string[]): number {
  return paths.reduce((sum, path) => sum + path.length + 1, 0);
}

test("ls-tree calls stay under the path budget and grow with total length", () => {
  const read = readTexts();
  const smallHead = git(smallRoot, "rev-parse", "HEAD");
  spawns.length = 0;
  read(smallRoot, smallHead, Object.keys(twoFiles));
  const smallCalls = lsTreePathCalls();
  expect(smallCalls).toHaveLength(1);
  expect(lsTreePathCost(smallCalls[0] ?? [])).toBeLessThanOrEqual(8000);
  const manyFiles: Record<string, string> = {};
  for (let index = 0; index < 30; index++) {
    const dir = "d".repeat(200);
    const file = `src/${dir}/${dir}/${dir}/${dir}/file-${String(index).padStart(2, "0")}.ts`;
    manyFiles[file] = `export const value${index} = ${index};\n`;
  }
  const names = Object.keys(manyFiles);
  const total = names.reduce((sum, name) => sum + name.length + 1, 0);
  expect(total).toBeGreaterThan(20000);
  expect(total).toBeLessThan(30000);
  const manyRoot = repository(manyFiles);
  const manyHead = git(manyRoot, "rev-parse", "HEAD");
  spawns.length = 0;
  const texts = read(manyRoot, manyHead, names);
  expect(texts.size).toBe(names.length);
  const calls = lsTreePathCalls();
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(calls.length).toBeLessThanOrEqual(4);
  for (const paths of calls)
    expect(lsTreePathCost(paths)).toBeLessThanOrEqual(8000);
}, 60_000);

test("a few hundred long-named files are all read with the right text", () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 300; index++) {
    const name = `src/long-name-${String(index).padStart(3, "0")}-${"x".repeat(40)}.ts`;
    files[name] = `export const wide${index} = ${index};\n`;
  }
  const total = Object.keys(files).reduce(
    (sum, name) => sum + name.length + 1,
    0,
  );
  expect(total).toBeGreaterThan(8000);
  const root = repository(files);
  const head = git(root, "rev-parse", "HEAD");
  spawns.length = 0;
  const texts = readTexts()(root, head, Object.keys(files));
  expect(texts.size).toBe(300);
  for (const [file, body] of Object.entries(files))
    expect(texts.get(file)).toBe(body);
}, 60_000);

test("one path longer than the budget is read in a chunk of its own", () => {
  const module = api() as unknown as {
    readonly chunkPathsForLsTree?: (files: readonly string[]) => string[][];
  };
  const chunk = module.chunkPathsForLsTree;
  if (typeof chunk !== "function")
    throw new Error("The ls-tree chunker is unavailable");
  const longPath = `src/${"a".repeat(8000)}.ts`;
  expect(longPath.length).toBeGreaterThan(8000);
  const chunks = chunk(["src/a.ts", longPath, "src/b.ts"]);
  expect(chunks.find((part) => part.includes(longPath))).toEqual([longPath]);
}, 30_000);
