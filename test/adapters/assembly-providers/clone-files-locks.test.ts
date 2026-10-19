import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloneFilesLease } from "../../../src/adapters/fs/clone-files.ts";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(read = true, write = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-file-locks-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  const commonDirectory = join(root, "common");
  const gitDirectory = join(commonDirectory, "worktrees", "linked");
  mkdirSync(projectRoot);
  mkdirSync(gitDirectory, { recursive: true });
  const controller = new AbortController();
  const options = {
    projectRoot,
    commonDirectory,
    gitDirectory,
    read,
    write,
    signal: controller.signal,
    deadline: Date.now() + 60_000,
  };
  const lease = createCloneFilesLease(options);
  return {
    root,
    projectRoot,
    commonDirectory,
    gitDirectory,
    options,
    controller,
    lease,
    files: lease.service,
  };
}

test("list reads sorted entries in the selected area and permits root '.' only there", () => {
  const { files, projectRoot, gitDirectory, lease } = fixture();
  writeFileSync(join(projectRoot, "z"), "z");
  writeFileSync(join(projectRoot, "a"), "a");
  mkdirSync(join(projectRoot, "empty"));
  writeFileSync(join(gitDirectory, "HEAD"), "head");
  expect(files.list(".", 3)).toEqual(["a", "empty", "z"]);
  expect(files.list("empty", 1)).toEqual([]);
  expect(files.list(".", 1, "git")).toEqual(["HEAD"]);
  expect(() => files.read(".", 10)).toThrow(/INPUT_INVALID/);
  expect(() => files.write(".", "bad")).toThrow(/INPUT_INVALID/);
  lease.close();
});

test("list rejects over-limit directories, invalid caps, non-directories and linked parents", () => {
  const { files, projectRoot, root, lease } = fixture();
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(projectRoot, "alias"), "junction");
  writeFileSync(join(projectRoot, "file"), "x");
  expect(() => files.list(".", 1)).toThrow(/LIMIT_EXCEEDED/);
  for (const path of ["file", "missing", "../outside", "alias", "alias/nested"])
    expect(() => files.list(path, 10)).toThrow(/INPUT_INVALID/);
  for (const cap of [0, -1, 1.5, Number.NaN, 1025])
    expect(() => files.list(".", cap)).toThrow(/INPUT_INVALID/);
  lease.close();
});

test("lock uses native exclusive paths under common and linked-worktree metadata", () => {
  const { files, commonDirectory, gitDirectory, lease } = fixture();
  const paths = [
    join(gitDirectory, "HEAD.lock"),
    join(gitDirectory, "index.lock"),
    join(commonDirectory, "refs", "heads", "main.lock"),
  ];
  const held = files.lock(paths);
  for (const path of paths) expect(existsSync(path)).toBe(true);
  expect(() => files.lock(["fourth.lock"])).toThrow(/LIMIT_EXCEEDED/);
  held.release();
  held.release();
  for (const path of paths) expect(existsSync(path)).toBe(false);
  const relative = files.lock(["relative.lock"]);
  expect(existsSync(join(commonDirectory, "relative.lock"))).toBe(true);
  relative.release();
  lease.close();
});

test("lock validates all authority, suffix, count and uniqueness constraints before side effects", () => {
  const { files, commonDirectory, projectRoot, root, lease } = fixture();
  for (const paths of [
    [join(root, "outside.lock")],
    [join(projectRoot, "project.lock")],
    ["nested/no-suffix"],
    ["../escape.lock"],
    ["same.lock", "same.lock"],
    ["a.lock", "b.lock", "c.lock", "d.lock"],
    ["valid.lock", join(root, "outside.lock")],
  ])
    expect(() => files.lock(paths)).toThrow(/INPUT_INVALID|LIMIT_EXCEEDED/);
  expect(readdirSync(commonDirectory)).toEqual(["worktrees"]);
  lease.close();
});

test("partial lock acquisition rolls back own files and preserves a pre-existing lock", () => {
  const { files, commonDirectory, lease } = fixture();
  writeFileSync(join(commonDirectory, "index.lock"), "existing owner");
  expect(() => files.lock(["HEAD.lock", "index.lock"])).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(false);
  expect(readFileSync(join(commonDirectory, "index.lock"), "utf8")).toBe(
    "existing owner",
  );
  const held = files.lock(["HEAD.lock"]);
  held.release();
  lease.close();
});

test("release preserves a replacement inode even when its content copies the owned nonce", () => {
  const { files, commonDirectory, lease } = fixture();
  const path = join(commonDirectory, "HEAD.lock");
  const held = files.lock(["HEAD.lock"]);
  const nonce = readFileSync(path, "utf8");
  renameSync(path, join(commonDirectory, "moved.lock"));
  writeFileSync(path, nonce);
  held.release();
  expect(readFileSync(path, "utf8")).toBe(nonce);
  lease.close();
});

test("release preserves the original inode if another owner rewrites its nonce", () => {
  const { files, commonDirectory, lease } = fixture();
  const held = files.lock(["HEAD.lock"]);
  writeFileSync(join(commonDirectory, "HEAD.lock"), "replacement owner");
  held.release();
  expect(readFileSync(join(commonDirectory, "HEAD.lock"), "utf8")).toBe(
    "replacement owner",
  );
  lease.close();
});

test("release and lease close clean owned locks after cancellation and synchronous expiry", () => {
  const { files, commonDirectory, controller, options, lease } = fixture();
  const held = files.lock(["HEAD.lock"]);
  files.lock(["index.lock"]);
  options.deadline = Date.now() - 1;
  controller.abort();
  held.release();
  lease.close();
  lease.close();
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(false);
  expect(existsSync(join(commonDirectory, "index.lock"))).toBe(false);
});

test("lease close revokes retained methods and releases locks without requiring abort", () => {
  const { files, commonDirectory, lease } = fixture();
  files.lock(["HEAD.lock"]);
  lease.close();
  for (const operation of [
    () => files.root,
    () => files.read("file", 10),
    () => files.list(".", 10),
    () => files.lock(["index.lock"]),
  ])
    expect(operation).toThrow(/SERVICE_EXPIRED/);
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(false);
});

test("list and lock require their individual effects before touching the clone", () => {
  const { files, commonDirectory, projectRoot, lease } = fixture(false, false);
  expect(() => files.list(".", 10)).toThrow(/EFFECT_UNDECLARED/);
  expect(() => files.lock(["new/HEAD.lock"])).toThrow(/EFFECT_UNDECLARED/);
  expect(readdirSync(commonDirectory)).toEqual(["worktrees"]);
  expect(readdirSync(projectRoot)).toEqual([]);
  lease.close();
});

test("lock refuses linked metadata parents and preserves final replacement links", () => {
  const { files, commonDirectory, root, lease } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(commonDirectory, "alias"), "junction");
  expect(() => files.lock(["alias/HEAD.lock"])).toThrow(/INPUT_INVALID/);
  const held = files.lock(["HEAD.lock"]);
  rmSync(join(commonDirectory, "HEAD.lock"));
  symlinkSync(outside, join(commonDirectory, "HEAD.lock"), "junction");
  held.release();
  expect(existsSync(join(commonDirectory, "HEAD.lock"))).toBe(true);
  expect(readdirSync(outside)).toEqual([]);
  lease.close();
});

test("absolute lock aliases resolve to canonical metadata before confinement, including missing suffixes", () => {
  const { files, commonDirectory, root, lease } = fixture();
  const alias = join(root, "metadata-alias");
  symlinkSync(commonDirectory, alias, "junction");
  const held = files.lock([join(alias, "new", "branch.lock")]);
  expect(existsSync(join(commonDirectory, "new", "branch.lock"))).toBe(true);
  held.release();
  expect(existsSync(join(commonDirectory, "new", "branch.lock"))).toBe(false);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const escape = join(commonDirectory, "escape");
  symlinkSync(outside, escape, "junction");
  expect(() => files.lock([join(escape, "HEAD.lock")])).toThrow(
    /INPUT_INVALID/,
  );
  expect(readdirSync(outside)).toEqual([]);
  lease.close();
});
