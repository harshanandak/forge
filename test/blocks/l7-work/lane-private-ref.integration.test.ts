import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const brief = ".worktrees/briefs/lane.md";
const briefText = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
]
  .map((name) => `## ${name}\nConcrete content.\n`)
  .join("\n");
let root: string, repo: string, origin: string, other: string;
let sequence = 0;

function git(args: string[], cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function forge(args: string[]) {
  const result = spawnSync("node", [bin, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: join(root, "bin") + delimiter + process.env.PATH,
      FORGE_DEVICE_ROOT: join(root, "device"),
      FORGE_SESSION: "lane-private-ref",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout) as {
    ok: boolean;
    result: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}
function call(op: string, input: unknown) {
  return forge([...op.split("."), "--input", JSON.stringify(input)]);
}
function newIssue() {
  const created = call("issue.create", { title: `Lane ${++sequence}` });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  return String(created.result.id);
}
function start(id: string) {
  return call("lane.start", { id, branch: `feat/${id}`, brief });
}
/** What a fetch may touch besides the private ref: tracking refs, tags and the private namespace. */
const tracked = () =>
  git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/remotes",
    "refs/tags",
  ]);
const privateRefs = () =>
  git(["for-each-ref", "--format=%(refname)", "refs/forge/"]);
/** A new main commit and tag on origin, so a leaking fetch has something to update. */
function advanceOrigin() {
  const tag = `v${++sequence}`;
  git(["pull", "--ff-only", "origin", "main"], other);
  writeFileSync(join(other, "tracked"), `${tag}\n`);
  git(["commit", "-am", tag], other);
  git(["tag", tag], other);
  git(["push", "origin", "main", tag], other);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-private-ref-")));
  origin = join(root, "origin.git");
  repo = join(root, "project");
  other = join(root, "other");
  git(["init", "--bare", "--initial-branch=main", origin], root);
  git(["clone", origin, repo], root);
  git(["config", "user.name", "Lane test"]);
  git(["config", "user.email", "lane@example.test"]);
  writeFileSync(join(repo, "tracked"), "base\n");
  git(["add", "tracked"]);
  git(["commit", "-m", "base"]);
  git(["push", "origin", "main"]);
  git(["remote", "set-head", "origin", "main"]);
  git(["clone", origin, other], root);
  git(["config", "user.name", "Lane test"], other);
  git(["config", "user.email", "lane@example.test"], other);
  mkdirSync(join(repo, ".forge"));
  writeFileSync(
    join(repo, ".forge/config.yaml"),
    "schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample, lanes: { max: 30 } }\n",
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(join(repo, brief), briefText);
  mkdirSync(join(root, "bin"));
  const gh = join(root, "bin/gh.cjs");
  writeFileSync(
    gh,
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(root, "pull.json"))}, 'utf8'));`,
  );
  writeFileSync(
    join(root, "bin/gh"),
    `#!/bin/sh\nexec node "${gh.replaceAll("\\", "/")}" "$@"\n`,
  );
  chmodSync(join(root, "bin/gh"), 0o755);
  writeFileSync(join(root, "bin/gh.cmd"), `@echo off\r\nnode "${gh}" %*\r\n`);
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }), 30000);

/** A started lane whose PR claims a merge commit that is not on main. */
function offMainLane() {
  const id = newIssue(),
    lane = start(id).result;
  expect(call("issue.claim", { id }).ok).toBe(true);
  const worktree = String(lane.worktree);
  git(["commit", "--allow-empty", "-m", "lane work"], worktree);
  const head = git(["rev-parse", "HEAD"], worktree);
  writeFileSync(
    join(root, "pull.json"),
    JSON.stringify({
      state: "MERGED",
      headRefName: lane.branch,
      baseRefName: "main",
      headRefOid: head,
      mergeCommit: { oid: head },
      url: "https://github.com/example/project/pull/42",
    }),
  );
  return id;
}
const closeLane = (id: string) =>
  call("lane.close", { id, pr: 42, receipt: "unused" });

test("lane start's base fetch leaves tracking refs and tags alone and leaves no private ref", () => {
  advanceOrigin();
  const before = tracked();
  const started = start(newIssue());
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(tracked()).toBe(before);
  expect(privateRefs()).toBe("");
}, 30000);

test("a refused lane close leaves tracking refs and tags alone and leaves no private ref", () => {
  const id = offMainLane();
  advanceOrigin();
  const before = tracked();
  expect(closeLane(id).error?.code).toBe("PR_NOT_MERGED");
  expect(tracked()).toBe(before);
  expect(privateRefs()).toBe("");
}, 30000);

test("the next lane close removes a stale private ref and keeps a fresh one", () => {
  const id = offMainLane(),
    commit = git(["rev-parse", "HEAD"]),
    fresh = `refs/forge/lane-close/${Date.now()}-fresh`;
  git(["update-ref", "refs/forge/lane-close/1-stale", commit]);
  git(["update-ref", "refs/forge/lane-base/1-stale", commit]);
  git(["update-ref", fresh, commit]);
  expect(closeLane(id).error?.code).toBe("PR_NOT_MERGED");
  expect(privateRefs()).toBe(fresh);
  git(["update-ref", "-d", fresh]);
}, 30000);

test("the next lane start removes a stale private ref", () => {
  git([
    "update-ref",
    "refs/forge/lane-base/1-stale",
    git(["rev-parse", "HEAD"]),
  ]);
  const started = start(newIssue());
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(privateRefs()).toBe("");
}, 30000);
