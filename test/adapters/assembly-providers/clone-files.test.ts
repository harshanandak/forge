import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCloneFiles,
  digestCloneFiles,
} from "../../../src/adapters/fs/clone-files.ts";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(write = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-clone-files-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  const gitDirectory = join(root, "common", "worktrees", "linked");
  const commonDirectory = join(root, "common");
  mkdirSync(projectRoot);
  mkdirSync(gitDirectory, { recursive: true });
  const controller = new AbortController();
  const options = {
    projectRoot,
    gitDirectory,
    commonDirectory,
    read: true,
    write,
    signal: controller.signal,
  };
  const files = createCloneFiles(options);
  return {
    root,
    projectRoot,
    gitDirectory,
    commonDirectory,
    files,
    controller,
    options,
  };
}

test("linked worktree areas are independent and missing reads create nothing", () => {
  const { files, projectRoot, gitDirectory, commonDirectory } = fixture();
  expect(files.read("nested/config", 100)).toBeUndefined();
  expect(readdirSync(projectRoot)).toEqual([]);
  for (const area of ["project", "git", "common"] as const)
    files.write("config", area, { area });
  expect(readFileSync(join(projectRoot, "config"), "utf8")).toBe("project");
  expect(readFileSync(join(gitDirectory, "config"), "utf8")).toBe("git");
  expect(readFileSync(join(commonDirectory, "config"), "utf8")).toBe("common");
  files.remove("config", { expected: "project" });
  expect(files.read("config", 100)).toBeUndefined();
  expect(files.read("config", 100, "git")).toBe("git");
});

test("write authority and cancellation are enforced before creating directories", () => {
  const denied = fixture(false);
  expect(() => denied.files.write("nested/config", "x")).toThrow(
    /EFFECT_UNDECLARED/,
  );
  expect(() => denied.files.remove("nested/config")).toThrow(
    /EFFECT_UNDECLARED/,
  );
  expect(readdirSync(denied.projectRoot)).toEqual([]);
  const cancelled = fixture();
  cancelled.controller.abort();
  expect(() => cancelled.files.read("config", 100)).toThrow();
  expect(() => cancelled.files.write("nested/config", "x")).toThrow();
  expect(readdirSync(cancelled.projectRoot)).toEqual([]);
});

test("strict relative paths reject traversal, platform aliases and root access", () => {
  const { files, projectRoot } = fixture();
  for (const path of [
    "",
    ".",
    "..",
    "../escape",
    "a/../escape",
    "/escape",
    "C:/escape",
    "a\\escape",
    "a//b",
    "a/./b",
    "config:stream",
    "NUL",
    "a.",
    "a ",
    "a\0b",
  ]) {
    expect(() => files.read(path, 100)).toThrow(/INPUT_INVALID/);
    expect(() => files.write(path, "bad")).toThrow(/INPUT_INVALID/);
    expect(() => files.remove(path)).toThrow(/INPUT_INVALID/);
  }
  expect(readdirSync(projectRoot)).toEqual([]);
});

test("symlinked parents, roots and final components cannot escape or alias", () => {
  const { root, files, projectRoot, gitDirectory, commonDirectory } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "config"), "preserved");
  symlinkSync(outside, join(projectRoot, "alias"), "junction");
  for (const path of ["alias/config", "alias/new/deep"]) {
    expect(() => files.read(path, 100)).toThrow(/INPUT_INVALID/);
    expect(() => files.write(path, "bad")).toThrow(/INPUT_INVALID/);
    expect(() => files.remove(path)).toThrow(/INPUT_INVALID/);
  }
  expect(() => files.read("alias", 100)).toThrow(/INPUT_INVALID/);
  expect(() =>
    createCloneFiles({
      projectRoot: join(projectRoot, "alias"),
      gitDirectory,
      commonDirectory,
      read: true,
      write: true,
      signal: new AbortController().signal,
    }),
  ).toThrow(/INPUT_INVALID/);
  expect(readFileSync(join(outside, "config"), "utf8")).toBe("preserved");
  expect(readdirSync(outside)).toEqual(["config"]);
});

test("regular files only: directories and hard links are refused", () => {
  const { files, projectRoot, root } = fixture();
  mkdirSync(join(projectRoot, "directory"));
  writeFileSync(join(root, "outside"), "preserved");
  linkSync(join(root, "outside"), join(projectRoot, "hardlink"));
  for (const path of ["directory", "hardlink"]) {
    expect(() => files.read(path, 100)).toThrow(/INPUT_INVALID/);
    expect(() => files.write(path, "bad")).toThrow(/INPUT_INVALID/);
    expect(() => files.remove(path)).toThrow(/INPUT_INVALID/);
  }
  expect(readFileSync(join(root, "outside"), "utf8")).toBe("preserved");
});

test("bounded reads and writes reject invalid limits and oversized content", () => {
  const { files, projectRoot } = fixture();
  writeFileSync(join(projectRoot, "config"), "éé");
  expect(files.read("config", 4)).toBe("éé");
  expect(() => files.read("config", 3)).toThrow(/LIMIT_EXCEEDED/);
  for (const max of [0, -1, 1.5, Number.NaN, 1_048_577])
    expect(() => files.read("config", max)).toThrow(/INPUT_INVALID/);
  expect(() => files.write("large", "x".repeat(1_048_577))).toThrow(
    /LIMIT_EXCEEDED/,
  );
  expect(existsSync(join(projectRoot, "large"))).toBe(false);
});

test("expected content is checked under an exclusive lock for writes and removes", () => {
  const { files, projectRoot } = fixture();
  files.write("config", "one", { expected: null });
  expect(() => files.write("config", "bad", { expected: null })).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(() => files.write("config", "bad", { expected: "stale" })).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(() => files.remove("config", { expected: "stale" })).toThrow(
    /INPUT_CONFLICT/,
  );
  files.write("config", "two", { expected: "one" });
  writeFileSync(join(projectRoot, "config.lock"), "owned elsewhere");
  expect(() => files.write("config", "bad", { expected: "two" })).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(() => files.remove("config")).toThrow(/INPUT_CONFLICT/);
  expect(readFileSync(join(projectRoot, "config.lock"), "utf8")).toBe(
    "owned elsewhere",
  );
  rmSync(join(projectRoot, "config.lock"));
  expect(files.read("config", 100)).toBe("two");
  expect(readdirSync(projectRoot)).toEqual(["config"]);
  files.remove("config", { expected: "two" });
  expect(readdirSync(projectRoot)).toEqual([]);
});

test("atomic private files can be executable and leave no lock behind", () => {
  const { files, projectRoot } = fixture();
  files.write("nested/router", "script", { executable: true });
  expect(files.read("nested/router", 100)).toBe("script");
  if (process.platform !== "win32") {
    expect(statSync(join(projectRoot, "nested/router")).mode & 0o777).toBe(
      0o700,
    );
    expect(statSync(join(projectRoot, "nested")).mode & 0o777).toBe(0o700);
  }
  expect(readdirSync(join(projectRoot, "nested"))).toEqual(["router"]);
});

test("read authority also gates inspection and digest without disabling authorized writes", () => {
  const { options, projectRoot } = fixture();
  const denied = { ...options, read: false };
  const files = createCloneFiles(denied);
  expect(() => files.read("missing", 100)).toThrow(/EFFECT_UNDECLARED/);
  expect(() => files.inspect("missing")).toThrow(/EFFECT_UNDECLARED/);
  expect(() => digestCloneFiles(denied, [], 100)).toThrow(/EFFECT_UNDECLARED/);
  files.write("config", "authorized", { expected: null });
  expect(readFileSync(join(projectRoot, "config"), "utf8")).toBe("authorized");
});

test("deadline checks expire synchronous methods and metadata without waiting for a timer", () => {
  const { options, projectRoot } = fixture();
  const current = Date.now();
  const timed = { ...options, deadline: current + 60_000 };
  const files = createCloneFiles(timed);
  timed.deadline = current - 1;
  for (const operation of [
    () => files.root,
    () => files.roots,
    () => files.read("missing", 100),
    () => files.inspect("missing"),
    () => files.write("nested/config", "bad"),
    () => files.remove("missing"),
    () => digestCloneFiles(timed, [], 100),
  ])
    expect(operation).toThrow(/INVOCATION_TIMEOUT/);
  expect(readdirSync(projectRoot)).toEqual([]);
});

test("inspection does not follow final links and reports executable private files", () => {
  const { files, projectRoot, root } = fixture();
  expect(files.inspect("missing")).toBeUndefined();
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(projectRoot, "link"), "junction");
  expect(files.inspect("link")?.regular).toBe(false);
  expect(files.inspect("link")?.executable).toBe(false);
  files.write("router", "text", { executable: true });
  expect(files.inspect("router")).toEqual({
    regular: true,
    executable: true,
    size: 4,
  });
  files.write("router", "text", { executable: false });
  if (process.platform !== "win32")
    expect(files.inspect("router")?.executable).toBe(false);
});

test("text reads preserve BOMs and refuse invalid UTF-8 while digests use exact binary bytes", () => {
  const { files, options, projectRoot } = fixture();
  files.write("bom", "\ufefftext");
  expect(files.read("bom", 100)).toBe("\ufefftext");
  writeFileSync(join(projectRoot, "binary"), Buffer.from([0xff, 0x00]));
  expect(() => files.read("binary", 100)).toThrow(/INPUT_INVALID/);
  const before = digestCloneFiles(options, ["binary"], 2);
  writeFileSync(join(projectRoot, "binary"), Buffer.from([0xfe, 0x00]));
  expect(digestCloneFiles(options, ["binary"], 2)).not.toBe(before);
  expect(() => files.write("bad", "\ud800")).toThrow(/INPUT_INVALID/);
});

test("digests frame ordered paths, absent files and empty files without writing", () => {
  const { options, projectRoot, files } = fixture();
  const missing = digestCloneFiles(options, ["one", "two"], 10);
  expect(readdirSync(projectRoot)).toEqual([]);
  files.write("one", "");
  const empty = digestCloneFiles(options, ["one", "two"], 10);
  expect(empty).not.toBe(missing);
  files.write("one", "abc");
  files.write("two", "de");
  const selected = digestCloneFiles(options, ["one", "two"], 5);
  expect(selected).toMatch(/^[a-f0-9]{64}$/);
  expect(digestCloneFiles(options, ["one", "two"], 5)).toBe(selected);
  expect(digestCloneFiles(options, ["two", "one"], 5)).not.toBe(selected);
  expect(() => digestCloneFiles(options, ["one", "two"], 4)).toThrow(
    /LIMIT_EXCEEDED/,
  );
  expect(() => digestCloneFiles(options, ["one", "one"], 100)).toThrow(
    /INPUT_INVALID/,
  );
  expect(() => digestCloneFiles(options, ["../escape"], 100)).toThrow(
    /INPUT_INVALID/,
  );
  expect(() =>
    digestCloneFiles(
      options,
      Array.from({ length: 1025 }, (_, index) => String(index)),
      100,
    ),
  ).toThrow(/LIMIT_EXCEEDED/);
  for (const limit of [0, -1, Number.NaN, 1.5, 1_073_741_825])
    expect(() => digestCloneFiles(options, [], limit)).toThrow(/INPUT_INVALID/);
});

test("configured per-file bounds apply to reads, writes and byte digests", () => {
  const { options, projectRoot } = fixture();
  const small = { ...options, maxBytes: 3 };
  const files = createCloneFiles(small);
  files.write("file", "abc");
  expect(files.read("file", 3)).toBe("abc");
  expect(() => files.read("file", 4)).toThrow(/INPUT_INVALID/);
  expect(() => files.write("file", "abcd")).toThrow(/LIMIT_EXCEEDED/);
  writeFileSync(join(projectRoot, "file"), "abcd");
  expect(() => digestCloneFiles(small, ["file"], 100)).toThrow(
    /LIMIT_EXCEEDED/,
  );
});

test("conditional write and remove preserve an editor replacement made while the advisory lock is held", () => {
  for (const action of ["write", "remove"] as const) {
    const { options, projectRoot } = fixture();
    writeFileSync(join(projectRoot, "config"), "expected");
    const files = createCloneFiles(options, {
      beforeCommit() {
        writeFileSync(join(projectRoot, "replacement"), "editor replacement");
        renameSync(
          join(projectRoot, "replacement"),
          join(projectRoot, "config"),
        );
      },
    });
    expect(() =>
      action === "write"
        ? files.write("config", "new", { expected: "expected" })
        : files.remove("config", { expected: "expected" }),
    ).toThrow(/INPUT_CONFLICT/);
    expect(readFileSync(join(projectRoot, "config"), "utf8")).toBe(
      "editor replacement",
    );
    expect(readdirSync(projectRoot)).toEqual(["config"]);
  }
});

test("conditional create does not overwrite a file appearing after the initial absence check", () => {
  const { options, projectRoot } = fixture();
  const files = createCloneFiles(options, {
    beforeCommit() {
      writeFileSync(join(projectRoot, "config"), "concurrent create");
    },
  });
  expect(() => files.write("config", "new", { expected: null })).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(readFileSync(join(projectRoot, "config"), "utf8")).toBe(
    "concurrent create",
  );
  expect(readdirSync(projectRoot)).toEqual(["config"]);
});

test("conditional mutations refuse a replacement inode even when its bytes match the original", () => {
  const { options, projectRoot } = fixture();
  writeFileSync(join(projectRoot, "config"), "expected");
  const files = createCloneFiles(options, {
    beforeCommit() {
      writeFileSync(join(projectRoot, "replacement"), "expected");
      renameSync(join(projectRoot, "replacement"), join(projectRoot, "config"));
    },
  });
  expect(() => files.remove("config", { expected: "expected" })).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(readFileSync(join(projectRoot, "config"), "utf8")).toBe("expected");
});

test("conditional publication preserves a new target and retains the claimed original for reconciliation", () => {
  const { options, projectRoot } = fixture();
  writeFileSync(join(projectRoot, "config"), "expected");
  const files = createCloneFiles(options, {
    afterClaim() {
      writeFileSync(join(projectRoot, "config"), "new editor target");
    },
  });
  expect(() => files.write("config", "new", { expected: "expected" })).toThrow(
    /INPUT_CONFLICT/,
  );
  expect(readFileSync(join(projectRoot, "config"), "utf8")).toBe(
    "new editor target",
  );
  const backup = readdirSync(projectRoot).find((name) =>
    name.startsWith(".forge-restore-"),
  );
  expect(backup).toBeDefined();
  if (backup === undefined) throw new Error("Missing reconciliation backup");
  expect(readFileSync(join(projectRoot, backup, "original"), "utf8")).toBe(
    "expected",
  );
  expect(existsSync(join(projectRoot, "config.lock"))).toBe(false);
});
