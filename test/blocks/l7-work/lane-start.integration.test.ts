import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
let root: string;
let repo: string;
let origin: string;
let sequence = 0;
const brief = ".worktrees/briefs/lane.md";
const text = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
]
  .map((name) => `## ${name}\nConcrete content.\n`)
  .join("\n");
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
function cli(args: string[], cwd = repo) {
  const result = spawnSync("node", [bin, ...args], {
    cwd,
    env: {
      ...process.env,
      FORGE_DEVICE_ROOT: join(root, "device"),
      FORGE_SESSION: "lane-acceptance",
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
  return cli([...op.split("."), "--input", JSON.stringify(input)]);
}
function issue() {
  const created = call("issue.create", { title: `Lane ${++sequence}` });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  return String(created.result.id);
}
function start(id: string, extra = {}) {
  return call("lane.start", { id, branch: `feat/${id}`, brief, ...extra });
}
function configure(max: number, base?: string) {
  const current = cli(["config", "show"]);
  const result = call("config.apply", {
    expectRevision: current.result.revision,
    patch: [
      {
        op: "set",
        path: "/blocks/work/config/lanes",
        value: { max, ...(base ? { base } : {}) },
      },
    ],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-lane-cli-")));
  origin = join(root, "origin.git");
  repo = join(root, "project");
  git(["init", "--bare", "--initial-branch=main", origin], root);
  git(["clone", origin, repo], root);
  git(["config", "user.name", "Lane test"]);
  git(["config", "user.email", "lane@example.test"]);
  writeFileSync(join(repo, "tracked"), "base\n");
  git(["add", "tracked"]);
  git(["commit", "-m", "base"]);
  git(["push", "origin", "main"]);
  git(["remote", "set-head", "origin", "main"]);
  mkdirSync(join(repo, ".forge"));
  writeFileSync(
    join(repo, ".forge/config.yaml"),
    "schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample }\n",
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(join(repo, brief), text);
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }), 30000);

test("lane CLI starts and shows a recorded worktree and deduplicates the issue", () => {
  const id = issue();
  const started = start(id);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(started.result).toMatchObject({
    issue: id,
    branch: `feat/${id}`,
    base: git(["rev-parse", "HEAD"]),
  });
  expect(call("lane.show", { id }).result).toMatchObject(started.result);
  expect(start(id).result).toMatchObject(started.result);
  expect(start(id, { branch: "feat/different" }).error?.code).toBe(
    "INPUT_CONFLICT",
  );
  const registry = JSON.parse(
    readFileSync(join(repo, ".git/forge-lanes.json"), "utf8"),
  ) as unknown[];
  expect(registry).toHaveLength(1);
  if (process.platform === "win32") {
    writeFileSync(
      join(repo, ".git/forge-lanes.json"),
      JSON.stringify([
        {
          ...started.result,
          worktree: String(started.result.worktree).toUpperCase(),
        },
      ]),
    );
    expect(start(id).ok).toBe(true);
  }
}, 30000);

test("lane CLI enforces the active lane cap", () => {
  configure(1);
  expect(start(issue()).error?.code).toBe("LIMIT_REACHED");
  configure(3);
}, 30000);

test("lane CLI rejects missing paths and incomplete briefs", () => {
  const id = issue();
  expect(start(id, { brief: ".worktrees/briefs/missing.md" }).error?.code).toBe(
    "INPUT_INVALID",
  );
  writeFileSync(
    join(repo, ".worktrees/briefs/bad.md"),
    "## Goal\nOnly one section\n",
  );
  expect(start(id, { brief: ".worktrees/briefs/bad.md" }).error?.code).toBe(
    "INPUT_INVALID",
  );
  expect(git(["branch", "--list", `feat/${id}`])).toBe("");
}, 30000);

test("lane CLI refuses a closed issue", () => {
  const id = issue();
  expect(call("issue.claim", { id }).ok).toBe(true);
  expect(
    call("issue.close", { id, withoutReceipt: "Acceptance fixture" }).ok,
  ).toBe(true);
  expect(start(id).error?.code).toBe("INPUT_CONFLICT");
}, 30000);

test("lane CLI follows an origin master default", () => {
  git(["branch", "master"]);
  git(["push", "origin", "master"]);
  git(["remote", "set-head", "origin", "master"]);
  const result = start(issue());
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.result.base).toBe(git(["rev-parse", "master"]));
  git(["remote", "set-head", "origin", "main"]);
}, 30000);

test("lane CLI uses FETCH_HEAD with a restricted refspec", () => {
  git([
    "config",
    "remote.origin.fetch",
    "+refs/heads/master:refs/remotes/origin/master",
  ]);
  writeFileSync(join(repo, "tracked"), "new remote head\n");
  git(["commit", "-am", "advance"]);
  git(["push", "origin", "HEAD:main"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
  const result = start(issue());
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.result.base).toBe(head);
  expect(git(["rev-parse", "HEAD"], String(result.result.worktree))).toBe(head);
  git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
}, 30000);

test("lane CLI refuses a held registry lock without creating a branch", () => {
  const id = issue();
  const lock = join(repo, ".git/forge-lanes-registry.lock");
  writeFileSync(lock, "held", { flag: "wx" });
  try {
    const result = start(id);
    expect(result.error?.code).toBe("INPUT_CONFLICT");
    expect(result.error?.message).toContain("forge-lanes-registry.lock");
    expect(git(["branch", "--list", `feat/${id}`])).toBe("");
  } finally {
    rmSync(lock);
  }
}, 30000);

// The publication lock injects failure after checkout, without changing the block.
test("lane CLI preserves and adopts work after registry publication fails", () => {
  configure(4);
  const id = issue();
  const lock = join(repo, ".git/forge-lanes.json.lock");
  writeFileSync(lock, "held", { flag: "wx" });
  try {
    const failed = start(id);
    expect(failed.error?.code).toBe("INPUT_CONFLICT");
    expect(failed.error?.message).toContain("Worktree preserved");
    expect(git(["branch", "--list", `feat/${id}`])).toContain(id);
    writeFileSync(join(repo, ".worktrees", id, "kept"), "user work");
  } finally {
    rmSync(lock);
  }
  const adopted = start(id);
  expect(adopted.ok, JSON.stringify(adopted)).toBe(true);
  expect(
    readFileSync(join(String(adopted.result.worktree), "kept"), "utf8"),
  ).toBe("user work");
  expect(call("lane.show", { id }).result).toMatchObject(adopted.result);
}, 30000);
