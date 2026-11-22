import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecutable } from "../../tools/git-executable.ts";

const tool = fileURLToPath(
  new URL("../../tools/ci/merge-from-main.ts", import.meta.url),
);
const reasons = ["Merge-reason: conflict", "Merge-reason: queue-rejection"];
const timeout = 10_000;

function checkMergeHistory() {
  const cwd = mkdtempSync(join(tmpdir(), "forge-main-merge-"));
  try {
    const executable = gitExecutable();
    const gitOptions = { cwd, encoding: "utf8", timeout } as const;
    const git = (...args: string[]) =>
      execFileSync(executable, args, gitOptions).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Forge Test");
    git("config", "user.email", "forge-test@example.com");
    const tree = git("write-tree");
    const commit = (message: string, ...parents: string[]) => {
      const flags = parents.flatMap((sha) => ["-p", sha]);
      return git("commit-tree", tree, "-m", message, ...flags);
    };
    const root = commit("root");
    const olderBase = commit("older main", root);
    const base = commit("latest main", olderBase);
    const topic = commit("PR head", root);
    const feature = commit("other feature", root);
    const synthetic = commit("GitHub synthetic merge", base, topic);
    git("switch", "-q", "--detach", synthetic);
    const run = (BASE_SHA: string, HEAD_SHA: string) => {
      const result = spawnSync(process.execPath, [tool], {
        ...gitOptions,
        env: { ...process.env, BASE_SHA, HEAD_SHA, BASE_REF: "main" },
      });
      if (result.error) throw result.error;
      return [result.status, (result.stdout + result.stderr).trim()] as const;
    };

    const merge = commit("Merge main\n\n::error::x", topic, base);
    const sha = merge.slice(0, 7);
    const newerBase = commit("newer main", base);
    const newerMerge = commit("Merge newer main", topic, newerBase);
    const featureWithMain = commit("feature based on newer main", newerBase);
    const followUp = (line: string) => commit(line, merge);
    const excused = reasons.map((line) =>
      commit(`Merge main\n\n${line}`, topic, base),
    );
    const accepted = [
      topic,
      commit("Merge feature", topic, feature),
      commit("No-op merge", commit("PR already based on the tip", base), base),
      commit("Merge feature containing main", topic, featureWithMain),
      commit("Squash main", topic),
      commit("Rebase PR onto main", base),
      commit(`Merge main\n\n${reasons[0]}\r`, topic, base),
      followUp(`${reasons[0]} ${sha}`),
      ...excused,
    ];
    for (const head of accepted)
      assert.deepEqual(run(base, head), [0, ""], "Allowed history must pass");

    const rejected = [
      [merge, merge],
      [commit("Reverse merge", base, topic)],
      [commit("Merge older main", topic, olderBase)],
      [commit("Octopus merge", topic, feature, base)],
      [commit("Merge main\n\nmerge-reason: Conflict", topic, base)],
      [commit("Merge main\n\nMerge-reason: queue rejection", topic, base)],
      [followUp(reasons[0]!), merge],
      [followUp(`${reasons[0]} ${base.slice(0, 7)}`), merge],
    ];
    function assertRejected(head: string, mergeSha = head) {
      const [exit, log] = run(base, head);
      assert.equal(exit, 1, log);
      assert.match(log, new RegExp(`^::error::[^\\n]*${mergeSha}`, "m"));
      for (const reason of reasons)
        assert.ok(log.includes(`${reason} ${mergeSha}`), log);
      assert.doesNotMatch(log, /::error::x/);
    }
    for (const [head, mergeSha] of rejected) assertRejected(head!, mergeSha);
    assert.deepEqual(run(base, newerMerge), [0, ""]);
    git("update-ref", "refs/remotes/origin/main", newerBase);
    assertRejected(newerMerge);

    for (const [from, to, diagnostic] of [
      ["", topic, /BASE_SHA/],
      [base, "", /HEAD_SHA/],
      [base, "0".repeat(40), /HEAD_SHA|revision|object|commit/i],
    ] as const) {
      const [exit, log] = run(from, to);
      assert.equal(exit, 1, log);
      assert.match(log, diagnostic);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("checks PR merges and fails closed", checkMergeHistory, timeout);
