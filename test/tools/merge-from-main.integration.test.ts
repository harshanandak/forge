import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecutable } from "../../tools/git-executable.ts";

const tool = fileURLToPath(
  new URL("../../tools/ci/merge-from-main.ts", import.meta.url),
);
const reasons = [
  "Merge-reason: conflict",
  "Merge-reason: queue-rejection",
] as const;
const timeout = 10_000;

function createHistory(cwd: string) {
  const executable = gitExecutable();
  const options = { cwd, encoding: "utf8", timeout } as const;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Forge Test",
    GIT_AUTHOR_EMAIL: "forge-test@example.com",
    GIT_COMMITTER_NAME: "Forge Test",
    GIT_COMMITTER_EMAIL: "forge-test@example.com",
  };
  const git = (...args: string[]) =>
    execFileSync(executable, args, { ...options, env }).trim();
  git("init", "-q", "-b", "main");
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
  git("switch", "-q", "--detach", commit("Synthetic merge", base, topic));

  const merge = commit("Merge main\n\n::error::x", topic, base);
  const newerBase = commit("newer main", base);
  git("update-ref", "refs/remotes/origin/main", newerBase);
  const newerMerge = commit("Merge newer main", topic, newerBase);
  const featureWithMain = commit("feature based on newer main", newerBase);
  const followUp = (line: string) => commit(line, merge);

  const linear = [
    topic,
    commit("Squash main", topic),
    commit("Rebase PR onto main", base),
  ];
  const unrelated = [
    commit("Merge feature", topic, feature),
    commit("No-op merge", commit("PR already based on the tip", base), base),
    commit("Merge feature containing main", topic, featureWithMain),
  ];
  const excused = [
    ...reasons.map((line) => commit(`Merge main\n\n${line}`, topic, base)),
    commit(`Merge main\n\n${reasons[0]}\r`, topic, base),
    followUp(`${reasons[0]} ${merge.slice(0, 7)}`),
  ];
  const unexcused = [
    merge,
    commit("Reverse merge", base, topic),
    commit("Merge older main", topic, olderBase),
    commit("Octopus merge", topic, feature, base),
  ];
  const badReasons: [head: string, mergeSha?: string][] = [
    [commit("Merge main\n\nmerge-reason: Conflict", topic, base)],
    [commit("Merge main\n\nMerge-reason: queue rejection", topic, base)],
    [followUp(reasons[0]), merge],
    [followUp(`${reasons[0]} ${base}`), merge],
  ];

  const run = (BASE_SHA: string, HEAD_SHA: string, BASE_REF = "unfetched") => {
    const result = spawnSync(process.execPath, [tool], {
      ...options,
      env: { ...process.env, BASE_SHA, HEAD_SHA, BASE_REF },
    });
    if (result.error) throw result.error;
    return [result.status, (result.stdout + result.stderr).trim()] as const;
  };
  return {
    base,
    topic,
    newerMerge,
    linear,
    unrelated,
    excused,
    unexcused,
    badReasons,
    run,
  };
}

let cwd: string | undefined;
let history: ReturnType<typeof createHistory>;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "forge-main-merge-"));
  history = createHistory(cwd);
}, timeout);

afterAll(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
}, timeout);

function assertAllowed(heads: readonly string[], baseRef?: string) {
  for (const head of heads)
    assert.deepEqual(history.run(history.base, head, baseRef), [0, ""]);
}

function assertRejected(head: string, mergeSha = head, baseRef?: string) {
  const [exit, log] = history.run(history.base, head, baseRef);
  assert.equal(exit, 1, log);
  assert.match(log, new RegExp(`^::error::[^\\n]*${mergeSha}`, "m"));
  for (const reason of reasons)
    assert.ok(log.includes(`${reason} ${mergeSha}`), log);
  assert.doesNotMatch(log, /::error::x/);
}

test(
  "linear PR history passes from a synthetic checkout",
  () => {
    assertAllowed(history.linear);
  },
  timeout,
);

test(
  "feature and no-op merges pass with a fetched base tip",
  () => {
    assertAllowed(history.unrelated, "main");
  },
  timeout,
);

test(
  "exact reasons on a merge or in a follow-up commit pass",
  () => {
    assertAllowed(history.excused);
  },
  timeout,
);

test(
  "unexcused base merges fail without a fetched base tip",
  () => {
    for (const head of history.unexcused) assertRejected(head);
  },
  timeout,
);

test(
  "wrong reason forms and SHA prefixes fail",
  () => {
    for (const [head, mergeSha] of history.badReasons)
      assertRejected(head, mergeSha);
  },
  timeout,
);

test(
  "a fetched base tip catches a merge newer than the event base",
  () => {
    assertAllowed([history.newerMerge]);
    assertRejected(history.newerMerge, history.newerMerge, "main");
  },
  timeout,
);

test(
  "missing and unknown SHAs fail closed",
  () => {
    const { base, topic, run } = history;
    for (const [from, to, diagnostic] of [
      ["", topic, /BASE_SHA/],
      [base, "", /HEAD_SHA/],
      [base, "0".repeat(40), /HEAD_SHA|revision|object|commit/i],
    ] as const) {
      const [exit, log] = run(from, to);
      assert.equal(exit, 1, log);
      assert.match(log, diagnostic);
    }
  },
  timeout,
);
