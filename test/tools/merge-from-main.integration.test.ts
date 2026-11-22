import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitExecutable } from "../../tools/git-executable.ts";

const tool = fileURLToPath(
  new URL("../../tools/ci/merge-from-main.ts", import.meta.url),
);
const conflict = "Merge-reason: conflict";
const reasons = [conflict, "Merge-reason: queue-rejection"];
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
    commit(`Merge main\n\n${conflict}\r`, topic, base),
    followUp(`${conflict} ${merge.slice(0, 7)}`),
  ];
  const unexcused = [
    merge,
    commit("Reverse merge", base, topic),
    commit("Merge older main", topic, olderBase),
    commit("Octopus merge", topic, feature, base),
  ];
  const untagged = followUp(conflict);
  const shallow = join(cwd, "shallow");
  git("branch", "base", base);
  git("branch", "topic", untagged);
  const source = pathToFileURL(cwd).href;
  git("clone", "-q", "--depth=1", "--no-single-branch", source, shallow);
  const badReasons: [head: string, mergeSha?: string][] = [
    [commit("Merge main\n\nmerge-reason: Conflict", topic, base)],
    [commit("Merge main\n\nMerge-reason: queue rejection", topic, base)],
    [untagged, merge],
    [followUp(`${conflict} ${base}`), merge],
  ];

  const run = (
    base: string,
    head: string,
    ref = "unfetched",
    dir = cwd,
    trace?: string,
  ) => {
    const result = spawnSync(process.execPath, [tool], {
      ...options,
      cwd: dir,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: head,
        BASE_REF: ref,
        ...(trace && { GIT_TRACE2_EVENT: trace }),
      },
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
    runShallow: () => run(base, untagged, "unfetched", shallow),
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
  for (const dir of metadataDirs) rmSync(dir, { recursive: true, force: true });
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

test(
  "refuses shallow history",
  () => {
    const [exit, log] = history.runShallow();
    assert.equal(exit, 1, log);
    assert.match(log, /^::error::Cannot inspect PR merge commits\./);
  },
  timeout,
);

const metadataDirs: string[] = [];

function metadataCheckout(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), "forge merge metadata "));
  metadataDirs.push(dir);
  const executable = gitExecutable();
  const options = { cwd: dir, encoding: "utf8", timeout } as const;
  const git = (...args: string[]) =>
    execFileSync(executable, args, options).trim();
  if (scenario !== "outside a Git repository")
    git("clone", "-q", "--local", "--no-hardlinks", cwd!, ".");
  const merge = history.unexcused[0]!;
  const grafts = join(dir, ".git", "info", "grafts");
  const checkout =
    scenario === "linked worktree" ? join(dir, "linked checkout") : dir;
  if (checkout !== dir)
    git("worktree", "add", "-q", "--detach", checkout, merge);
  return { dir, git, merge, grafts, checkout };
}

function inspectMetadata(dir: string) {
  return history.run(history.base, history.topic, "unfetched", dir);
}

const replacementError =
  /^::error::.*refs\/replace\/.*(?:git replace -d|fresh checkout)/;
const graftError =
  /^::error::.*info\/grafts.*(?:Delete|Remove|fresh checkout)/i;
const dirtyCases = [
  ["replacement", "merge"],
  ["replacement", "unrelated target"],
  ["replacement", "packed ref"],
  ["replacement", "unknown objects"],
  ["replacement", "cross-worktree no-echo"],
  ["graft", "merge"],
  ["graft", "linked worktree"],
  ["graft", "empty graft file"],
  ["both", "merge"],
] as const;

test.each(dirtyCases)(
  "refuses %s metadata with %s before reading history",
  (kind, scenario) => {
    const { dir, git, merge, grafts, checkout } = metadataCheckout(scenario);
    const { topic, newerMerge, unrelated, excused } = history;
    const annotation = scenario === "cross-worktree no-echo";
    const alternate = scenario === "unrelated target" || annotation;
    const ref = `refs/replace/${alternate ? newerMerge : merge}`;
    if (alternate) git("update-ref", ref, unrelated[0]!);
    else if (kind !== "graft") git("replace", merge, topic);
    if (kind !== "replacement")
      writeFileSync(
        grafts,
        scenario === "empty graft file" ? "" : `${merge}\n`,
      );
    if (scenario === "packed ref") {
      git("pack-refs", "--all");
      const packed = readFileSync(join(dir, ".git", "packed-refs"), "utf8");
      assert.ok(packed.split(/\r?\n/).includes(`${topic} ${ref}`));
      assert.equal(existsSync(join(dir, ".git", ref)), false);
    }
    let head = topic;
    if (scenario === "merge" || scenario === "linked worktree") head = merge;
    if (scenario === "unknown objects") head = "0".repeat(40);
    if (annotation) head = excused[3]!;

    const trace = join(dir, "git-trace.jsonl");
    const base = scenario === "unknown objects" ? "f".repeat(40) : history.base;
    const [exit, log] = history.run(base, head, "unfetched", checkout, trace);
    const diagnostics = log.split(/\r?\n/);
    if (kind !== "graft") assert.match(diagnostics[0]!, replacementError);
    if (kind !== "replacement") assert.match(diagnostics.at(-1)!, graftError);
    assert.equal(diagnostics.length, kind === "both" ? 2 : 1, log);
    assert.equal(exit, 1, log);
    assert.doesNotMatch(log, /::error::x|without a recorded reason/);
    assert.ok(!log.includes(ref));
    const events = readFileSync(trace, "utf8").trim().split("\n");
    const commands = events
      .map((line) => JSON.parse(line) as { event: string; argv: string[] })
      .filter(({ event }) => event === "start")
      .map(({ argv }) => argv.slice(1));
    assert.deepEqual(commands, [
      ["for-each-ref", "--count=1", "--format=%(refname)", "refs/replace/"],
      ["rev-parse", "--git-path", "info/grafts"],
    ]);
  },
  timeout,
);

const cleanCases = [
  "clone",
  "linked worktree",
  "refs/heads/replace",
  "refs/heads/replace/x",
  "refs/tags/replace/x",
  "refs/replaces/x",
];
test.each(cleanCases)(
  "allows clean %s",
  (scenario) => {
    const { git, checkout } = metadataCheckout(scenario);
    if (scenario.startsWith("refs/"))
      git("update-ref", scenario, history.topic);
    assert.deepEqual(inspectMetadata(checkout), [0, ""]);
  },
  timeout,
);

test.each([
  "outside a Git repository",
  "when the graft path cannot be inspected",
])(
  "fails closed %s",
  (scenario) => {
    const { dir } = metadataCheckout(scenario);
    if (scenario !== "outside a Git repository") {
      const info = join(dir, ".git", "info");
      rmSync(info, { recursive: true });
      writeFileSync(info, "");
    }
    const [exit, log] = inspectMetadata(dir);
    assert.match(log, /^::error::Cannot inspect PR merge commits\./);
    assert.equal(exit, 1, log);
  },
  timeout,
);
