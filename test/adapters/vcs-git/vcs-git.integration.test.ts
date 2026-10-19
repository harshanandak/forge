// [integration] Real git against real repositories, through the real process adapter.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import { createVcsPort } from "../../../src/adapters/vcs-git/index.ts";

const processPort = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
const baseEnv: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined) baseEnv[name] = value;
}
const identity = [
  "-c",
  "user.name=Forge Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

let work: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  }
  const found = processPort.resolve("git", env);
  if (found.kind !== "resolved") throw new Error("git is not installed");
  const result = await processPort.run(found, [...identity, ...args], {
    cwd,
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function repoPort(env: Record<string, string> = baseEnv) {
  return createVcsPort({
    process: processPort,
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  });
}

async function newRepo(name: string): Promise<string> {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-q", "-m", "first");
  return dir;
}

beforeAll(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-vcs-")));
}, 30_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
}, 30_000);

test("root finds the repository from a subfolder and refuses a folder outside any repository", async () => {
  const repo = await newRepo("root");
  mkdirSync(join(repo, "deep", "er"), { recursive: true });
  const vcs = repoPort();
  expect(await vcs.root(join(repo, "deep", "er"))).toBe(repo);
  const outside = join(work, "not-a-repo");
  mkdirSync(outside);
  expect(await vcs.root(outside)).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("not inside a git repository") as string,
  });
  expect(await vcs.root(join(work, "missing"))).toMatchObject({
    kind: "unavailable",
  });
}, 60_000);

test("revision returns the exact commit, peels tags, and reports an unknown ref", async () => {
  const repo = await newRepo("revision");
  const head = await git(repo, "rev-parse", "HEAD");
  await git(repo, "tag", "-a", "v1", "-m", "release");
  const vcs = repoPort();
  expect(await vcs.revision(repo, "HEAD")).toBe(head);
  expect(await vcs.revision(repo, "v1")).toBe(head);
  expect(await vcs.revision(repo, "no-such-branch")).toMatchObject({
    kind: "unavailable",
  });
  expect(await vcs.revision(repo, "--version")).toMatchObject({
    kind: "unavailable",
  });
}, 60_000);

test("currentBranch names the branch, including before the first commit, and is undefined when detached", async () => {
  const unborn = join(work, "unborn");
  mkdirSync(unborn);
  await git(unborn, "init", "-q", "-b", "trunk");
  const vcs = repoPort();
  expect(await vcs.currentBranch(unborn)).toBe("trunk");

  const repo = await newRepo("branch");
  await git(repo, "checkout", "-q", "-b", "feature/x");
  expect(await vcs.currentBranch(repo)).toBe("feature/x");
  await git(repo, "checkout", "-q", "--detach");
  expect(await vcs.currentBranch(repo)).toBeUndefined();
}, 60_000);

test("defaultBranch reads the fetched remote's HEAD, with the remote prefix removed", async () => {
  const origin = await newRepo("origin-source");
  await git(origin, "branch", "-M", "release/main");
  const clone = join(work, "clone");
  await git(work, "clone", "-q", origin, clone);
  const vcs = repoPort();
  expect(await vcs.defaultBranch(clone, "origin")).toBe("release/main");
  expect(await vcs.defaultBranch(clone, "upstream")).toMatchObject({
    kind: "unavailable",
  });
  expect(await vcs.defaultBranch(origin, "origin")).toMatchObject({
    kind: "unavailable",
  });
}, 60_000);

test("status lists changed, staged, renamed and untracked files with forward slashes", async () => {
  const repo = await newRepo("status");
  const vcs = repoPort();
  expect(await vcs.status(repo)).toEqual({ clean: true, changed: [] });

  mkdirSync(join(repo, "src dir"));
  writeFileSync(join(repo, "src dir", "é new.txt"), "x\n");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  await git(repo, "mv", "a.txt", "b.txt");
  writeFileSync(join(repo, "b.txt"), "changed again\n");
  const status = await vcs.status(repo);
  expect(status.clean).toBe(false);
  expect(status.changed).toEqual(["a.txt", "b.txt", "src dir/é new.txt"]);
}, 60_000);

test("status does not touch the index: reads never write", async () => {
  const repo = await newRepo("readonly");
  const index = join(repo, ".git", "index");
  const before = readFileSync(index);
  // A newer mtime with the same content is what makes a plain `git status` rewrite the index.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(repo, "a.txt"), later, later);
  const status = await repoPort().status(repo);
  expect(status.clean).toBe(true);
  expect(readFileSync(index).equals(before)).toBe(true);
}, 60_000);

test("a leaked GIT_DIR cannot redirect the adapter to another repository", async () => {
  const wanted = await newRepo("wanted");
  const other = await newRepo("other");
  const env = {
    ...baseEnv,
    GIT_DIR: join(other, ".git"),
    GIT_WORK_TREE: other,
  };
  const vcs = repoPort(env);
  expect(await vcs.root(wanted)).toBe(wanted);
  expect(await vcs.revision(wanted, "HEAD")).toBe(
    await git(wanted, "rev-parse", "HEAD"),
  );
}, 60_000);

test("a status larger than the output limit fails instead of reporting a partial tree", async () => {
  const repo = join(work, "limit-repo");
  mkdirSync(repo);
  await git(repo, "init");
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(repo, `untracked-file-${index}.txt`), "x");
  }
  const tight = createVcsPort({
    process: processPort,
    env: baseEnv,
    timeoutMs: 30_000,
    maxOutputBytes: 50,
  });
  const failure = await tight.status(repo).then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );
  expect(failure?.code).toBe("GIT_OUTPUT_LIMIT");
}, 30_000);
