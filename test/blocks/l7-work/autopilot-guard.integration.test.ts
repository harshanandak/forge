import { acceptanceTable } from "./lane-brief-fixture.ts";
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(180_000);
type Action = { lane: string; kind: string };
type Status = { stopped: boolean; lanes: unknown[] };
// A fresh process per call, against the real store: only the on-disk state survives.
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
let root: string;
let repo: string;
type Envelope = {
  ok: boolean;
  result: Record<string, unknown>;
  error?: { code: string; message: string };
};
function git(args: string[], cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function call(op: string, input: unknown, session: string): Envelope {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.FORGE_DEVICE_ROOT = join(root, "device");
  env.FORGE_SESSION = session;
  const result = spawnSync(
    "node",
    [bin, ...op.split("."), "--input", JSON.stringify(input)],
    { cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 90000 },
  );
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout) as Envelope;
}
const brief = ".worktrees/briefs/guard.md";
function prepare() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-guard-")));
  const origin = join(root, "origin.git");
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
    "schemaVersion: forge.config/1\nblocks:\n  work:\n    source: { builtin: forge/work }\n    bind: { state: core }\n    config: { idPrefix: sample, lanes: { autopilot: { receiptChecks: [typecheck] } } }\n",
  );
  mkdirSync(join(repo, ".worktrees/briefs"), { recursive: true });
  writeFileSync(
    join(repo, brief),
    [
      "Goal",
      "Acceptance test",
      "Files",
      "Forbidden actions",
      "Stop point",
      "Prior art",
    ]
      .map(
        (name) =>
          `## ${name}\nConcrete content.\n${name === "Acceptance test" ? acceptanceTable : ""}\n`,
      )
      .join("\n"),
  );
}
test("a stop survives restarts, and resume needs a relayed owner approval", () => {
  prepare();
  try {
    const lanes: string[] = [];
    for (const title of ["One", "Two"]) {
      const created = call("issue.create", { title }, "first");
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const id = String(created.result.id);
      const started = call(
        "lane.start",
        { id, branch: `feat/${id}`, brief },
        "first",
      );
      expect(started.ok, JSON.stringify(started)).toBe(true);
      lanes.push(id);
    }
    const stopped = call("lane.stop", { all: true }, "first");
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);

    const next = call("lane.next", { all: true }, "second");
    expect(next.ok, JSON.stringify(next)).toBe(true);
    const actions = next.result.actions as Action[];
    expect(actions.map((action) => action.kind)).toEqual(["pause", "pause"]);
    expect(actions.map((action) => action.lane).toSorted()).toEqual(
      lanes.toSorted(),
    );

    const bare = call("lane.resume", { all: true }, "second");
    expect(bare.ok).toBe(false);
    expect(bare.error?.code).toBe("APPROVAL_REQUIRED");
    const request = (bare.result as { request?: { id?: string } }).request;
    expect(request?.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      (call("lane.status", {}, "third").result as unknown as Status).stopped,
    ).toBe(true);

    const approval = {
      request: request!.id,
      quote: "yes, resume the lanes",
      source: { harness: "codex", thread: "owner-chat", message: "m1" },
    };
    const resumed = call("lane.resume", { all: true, approval }, "second");
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    const status = call("lane.status", {}, "third").result as unknown as Status;
    expect(status.stopped).toBe(false);
    expect(status.lanes).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
