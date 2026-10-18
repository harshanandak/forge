import { expect, test } from "bun:test";
import {
  createVcsPort,
  GitCommandError,
} from "../../../src/adapters/vcs-git/index.ts";
import { fakeProcess } from "../process/fake-process.ts";

const base = { env: { PATH: "/bin" }, timeoutMs: 1000, maxOutputBytes: 1000 };

test("git runs with an argument array, a pinned environment and no location variables", async () => {
  const process = fakeProcess(["git"], () => ({ stdout: "/repo\n" }));
  const vcs = createVcsPort({
    ...base,
    process,
    env: {
      PATH: "/bin",
      GIT_DIR: "/elsewhere/.git",
      git_work_tree: "/elsewhere",
      GIT_AUTHOR_NAME: "kept",
    },
  });
  await vcs.root("/repo/sub");
  const run = process.runs[0];
  expect(run?.args).toEqual(["rev-parse", "--show-toplevel"]);
  expect(run?.options.cwd).toBe("/repo/sub");
  expect(run?.options.env).toEqual({
    PATH: "/bin",
    GIT_AUTHOR_NAME: "kept",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  });
}, 30_000);

test("a missing git is Unavailable from value-returning reads and a typed error from the rest", async () => {
  const vcs = createVcsPort({ ...base, process: fakeProcess([]) });
  const root = await vcs.root("/x");
  expect(root).toMatchObject({ kind: "unavailable" });
  expect(await vcs.revision("/x", "HEAD")).toMatchObject({
    kind: "unavailable",
  });
  expect(await vcs.defaultBranch("/x", "origin")).toMatchObject({
    kind: "unavailable",
  });
  const failure = await vcs.status("/x").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(GitCommandError);
  expect((failure as GitCommandError).code).toBe("GIT_UNAVAILABLE");
  const branch = await vcs.currentBranch("/x").catch((error: unknown) => error);
  expect((branch as GitCommandError).code).toBe("GIT_UNAVAILABLE");
}, 30_000);

test("failures are classified from git's own message", async () => {
  const cases: Array<[string, RegExp]> = [
    [
      "fatal: not a git repository (or any parent)",
      /not inside a git repository/,
    ],
    ["fatal: detected dubious ownership in repository", /safe\.directory/],
    ["fatal: something else entirely", /something else entirely/],
  ];
  for (const [stderr, expected] of cases) {
    const vcs = createVcsPort({
      ...base,
      process: fakeProcess(["git"], () => ({ exitCode: 128, stderr })),
    });
    const root = await vcs.root("/x");
    expect(root).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(root)).toMatch(expected);
  }
}, 30_000);

test("a timeout is reported, not mistaken for 'no such ref'", async () => {
  const vcs = createVcsPort({
    ...base,
    process: fakeProcess(["git"], () => ({ exitCode: null, timedOut: true })),
  });
  expect(await vcs.revision("/x", "main")).toMatchObject({
    kind: "unavailable",
    reason: "git did not finish in time",
  });
}, 30_000);

test("a ref is passed after --end-of-options so it can never be read as a flag", async () => {
  const process = fakeProcess(["git"], () => ({ stdout: "abc123\n" }));
  const vcs = createVcsPort({ ...base, process });
  expect(await vcs.revision("/r", "--upload-pack=evil")).toBe("abc123");
  expect(process.runs[0]?.args).toEqual([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    "--upload-pack=evil^{commit}",
  ]);
  expect(await vcs.revision("/r", "bad\nref")).toMatchObject({
    kind: "unavailable",
  });
  expect(await vcs.revision("/r", "")).toMatchObject({ kind: "unavailable" });
}, 30_000);

test("a remote name that could be an option or a path trick is refused", async () => {
  const vcs = createVcsPort({ ...base, process: fakeProcess(["git"]) });
  for (const remote of ["", "-x", "a b", "../x", "a\nb"]) {
    expect(await vcs.defaultBranch("/r", remote)).toMatchObject({
      kind: "unavailable",
    });
  }
}, 30_000);

test("porcelain output is parsed with renames reporting both paths", async () => {
  const vcs = createVcsPort({
    ...base,
    process: fakeProcess(["git"], () => ({
      stdout: " M src/a.ts\0R  new name.ts\0old name.ts\0?? dir/file é.txt\0",
    })),
  });
  expect(await vcs.status("/r")).toEqual({
    clean: false,
    changed: ["dir/file é.txt", "new name.ts", "old name.ts", "src/a.ts"],
  });
  const clean = createVcsPort({ ...base, process: fakeProcess(["git"]) });
  expect(await clean.status("/r")).toEqual({ clean: true, changed: [] });
}, 30_000);
