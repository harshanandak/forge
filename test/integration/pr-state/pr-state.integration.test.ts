import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(60000);
const root = mkdtempSync(join(tmpdir(), "forge-pr-state-"));
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const node = Bun.which("node")!;
const git = Bun.which("git")!;
const fake = join(root, "fake");
mkdirSync(fake);
if (process.platform === "win32") {
  copyFileSync(node, join(fake, "node.exe"));
  writeFileSync(join(fake, "git.cmd"), `@"${git}" %*\r\n`);
} else {
  symlinkSync(node, join(fake, "node"));
  symlinkSync(git, join(fake, "git"));
}
mkdirSync(join(root, ".forge"));
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE)$/i.test(
      name,
    ),
  ),
);
env.PATH = fake;
env.FORGE_DEVICE_ROOT = join(root, "device");
const initialized = spawnSync(git, ["init", "--quiet", root], {
  env,
  encoding: "utf8",
  windowsHide: true,
  timeout: 10000,
});
if (initialized.status !== 0)
  throw new Error("Could not initialize isolated Git fixture");
writeFileSync(
  join(root, ".forge/config.yaml"),
  JSON.stringify({
    schemaVersion: "forge.config/1",
    blocks: {
      check: { source: { builtin: "forge/check" }, config: { commands: {} } },
    },
  }),
);
writeFileSync(join(root, "package.json"), '{"name":"pr-state-fixture"}');
copyFileSync(join(import.meta.dirname, "gh.mjs"), join(fake, "gh.mjs"));
if (process.platform === "win32")
  writeFileSync(
    join(fake, "gh.cmd"),
    `@"${node}" "${join(fake, "gh.mjs")}" %*\r\n`,
  );
else {
  writeFileSync(
    join(fake, "gh"),
    `#!/bin/sh\nexec "${node}" "${join(fake, "gh.mjs")}" "$@"\n`,
  );
  chmodSync(join(fake, "gh"), 0o755);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));
function run(since?: string, pr = 7) {
  return spawnSync(
    node,
    [bin, "pr", "state", String(pr), ...(since ? ["--since", since] : [])],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 45000 },
  );
}
function scenario(value: Record<string, unknown>) {
  writeFileSync(join(root, "fixture.json"), JSON.stringify(value));
  writeFileSync(join(root, "reads.txt"), "0");
}
type State = {
  pr: number;
  head: string;
  verdict: string;
  next: string;
  news: string[];
  end: boolean;
};
function read(since?: string): State {
  const result = run(since);
  expect(
    result.status,
    JSON.stringify({ stdout: result.stdout, stderr: result.stderr }),
  ).toBe(0);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout) as State;
}
function quiet(since: string) {
  const result = run(since);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
}

test("the fake rejects another PR in every read route", () => {
  for (const pr of [7, 23]) {
    scenario({ pr });
    const wrong = pr + 1;
    for (const args of [
      ["pr", "view", String(wrong), "--json", "headRefOid,state"],
      ["pr", "checks", String(wrong), "--json", "name,bucket"],
      [
        "api",
        `repos/org/repo/pulls/${wrong}/comments?per_page=100`,
        "--jq",
        "{}",
      ],
      ["api", "graphql", "-F", `n=${wrong}`, "--jq", "{}"],
    ]) {
      const result = spawnSync(node, [join(fake, "gh.mjs"), ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `expected pull request ${pr}, got ${wrong}`,
      );
    }
  }
});

test("built CLI reads the configured PR with its full commit head", () => {
  const head = "0123456789abcdef".repeat(2) + "01234567";
  scenario({ pr: 23, head });
  const result = run(undefined, 23);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    pr: 23,
    head,
    verdict: "ready",
    end: true,
  });
  const wrong = run(undefined, 7);
  expect(wrong.status).not.toBe(0);
  expect(wrong.stdout).not.toContain('"next"');
});
test("built CLI emits one raw state line, suppresses duplicates, and reports changed failures", () => {
  scenario({});
  const first = run();
  expect(first.status).toBe(0);
  const value = JSON.parse(first.stdout) as {
    verdict: string;
    next: string;
    news: string[];
  };
  expect(value.verdict).toBe("ready");
  expect(first.stdout.trim().split("\n")).toHaveLength(1);
  expect(value).not.toHaveProperty("result");
  const quiet = run(value.next);
  expect(quiet.status).toBe(0);
  expect(quiet.stdout).toBe("");
  writeFileSync(
    join(root, "fixture.json"),
    '{"failed":true,"merge":"BLOCKED"}',
  );
  const changed = run(value.next);
  expect(
    changed.status,
    JSON.stringify({ stdout: changed.stdout, stderr: changed.stderr }),
  ).toBe(0);
  expect(JSON.parse(changed.stdout)).toMatchObject({
    verdict: "blocked",
    news: ["check failed: test"],
  });
});

for (const [name, value, verdict, end] of [
  ["pending", { pending: true, merge: "BLOCKED" }, "waiting", false],
  ["never reported", { empty: true, merge: "BLOCKED" }, "blocked", false],
  ["unresolved review", { threads: true }, "blocked", false],
  ["merge queue", { queued: true }, "waiting", false],
  [
    "unknown mergeability",
    { mergeable: "UNKNOWN", merge: "UNKNOWN" },
    "waiting",
    false,
  ],
  ["conflict", { mergeable: "CONFLICTING", merge: "DIRTY" }, "blocked", false],
  ["changes requested", { review: "CHANGES_REQUESTED" }, "blocked", false],
  ["behind", { merge: "BEHIND" }, "blocked", false],
  ["draft", { draft: true }, "blocked", false],
  ["closed", { state: "CLOSED" }, "gone", true],
  ["merged", { state: "MERGED" }, "gone", true],
] as const)
  test(`built CLI reports ${name}`, () => {
    scenario(value);
    const state = read();
    expect(state).toMatchObject({ verdict, end });
    quiet(state.next);
  });

test("each new failure, comment and head cycle emits its news once", () => {
  scenario({ pending: true });
  const baseline = read();
  scenario({ failed: true, merge: "BLOCKED" });
  const failure = read(baseline.next);
  expect(failure.news).toEqual(["check failed: test"]);
  quiet(failure.next);
  const comment = {
    id: 1,
    created_at: "2026-10-27T10:00:00Z",
    user: { login: "other" },
  };
  scenario({ failed: true, merge: "BLOCKED", comments: [comment] });
  const remark = read(failure.next);
  expect(remark.news).toEqual(["1 new remarks: other"]);
  quiet(remark.next);
  scenario({ head: "b", comments: [comment] });
  const moved = read(remark.next);
  expect(moved.news).toEqual(["head moved", "required checks passed"]);
  quiet(moved.next);
});

test("all remark feeds, later pages, own comments and same-time ids retain the cursor", () => {
  const time = "2026-10-27T10:00:00Z",
    user = { login: "other" };
  const comment = { id: 1, created_at: time, user };
  scenario({
    issuePages: [[], [comment]],
    reviews: [{ id: 2, submitted_at: time, user }],
    reviewComments: [{ ...comment, id: 3 }],
  });
  const first = read();
  expect(first.news).toContain("3 new remarks: other");
  quiet(first.next);
  scenario({
    issuePages: [[], [comment, { ...comment, id: 4 }]],
    reviews: [{ id: 2, submitted_at: time, user }],
    reviewComments: [
      { ...comment, id: 3 },
      { ...comment, id: 5, user: { login: "self" } },
    ],
  });
  const next = read(first.next);
  expect(next.news).toEqual(["1 new remarks: other"]);
  quiet(next.next);
});

test("pending, queue and thread resolutions wake terminal readiness without a head move", () => {
  for (const blocked of [
    { pending: true },
    { queued: true },
    { threads: true },
  ]) {
    scenario(blocked);
    const first = read();
    scenario({});
    const ready = read(first.next);
    expect(ready).toMatchObject({ verdict: "ready", end: true });
    expect(ready.news.length).toBeGreaterThan(0);
    quiet(ready.next);
  }
});

for (const [name, value, head] of [
  ["head", { afterHead: "b" }, "b"],
  ["state", { state: "CLOSED", afterState: "OPEN" }, "a"],
] as const)
  test(`R2-1 final ${name} race waits and does not latch stale passing checks`, () => {
    scenario(value);
    const changed = read();
    expect(changed).toMatchObject({
      head: head.repeat(40),
      verdict: "waiting",
      end: false,
    });
    expect(changed.news).not.toContain("required checks passed");
    const stable = read(changed.next);
    expect(stable).toMatchObject({
      head: head.repeat(40),
      verdict: "ready",
      end: true,
    });
    expect(stable.news).toContain("required checks passed");
    quiet(stable.next);
  });

test("failed or incomplete reads and invalid tokens exit nonzero without next", () => {
  for (const broken of [{ failRead: true }, { incomplete: true }]) {
    scenario(broken);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('"next"');
  }
  scenario({});
  const result = run("invalid");
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('"next"');
});
test("R2-5 required green, failed and green checks announce passing once per head", () => {
  scenario({});
  const first = read();
  expect(first.news).toContain("required checks passed");
  scenario({ failed: true, merge: "BLOCKED" });
  const failed = read(first.next);
  expect(failed.verdict).toBe("blocked");
  expect(failed.news).toEqual(["check failed: test"]);
  quiet(failed.next);
  scenario({});
  const restored = read(failed.next);
  expect(restored).toMatchObject({ verdict: "ready", end: true });
  expect(restored.news).not.toContain("required checks passed");
  quiet(restored.next);
});

test("optional failures block while missing checks and GitHub BLOCKED do not announce passing", () => {
  scenario({});
  const first = read();
  scenario({ optionalFailed: true });
  const failed = read(first.next);
  expect(failed.verdict).toBe("blocked");
  expect(failed.news).toContain("check failed: optional");
  scenario({});
  const restored = read(failed.next);
  expect(restored.news).not.toContain("required checks passed");
  quiet(restored.next);
  scenario({ merge: "BLOCKED" });
  expect(read().news).not.toContain("required checks passed");
  scenario({ empty: true });
  expect(read()).toMatchObject({
    verdict: "waiting",
    reasons: ["no checks reported"],
  });
});
test("R2-5 inline page two emits a new same-time remark exactly once", () => {
  const comments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    created_at: "2026-10-27T10:00:00Z",
    user: { login: "other" },
  }));
  scenario({ reviewComments: comments });
  const first = read();
  expect(first.news).toContain("100 new remarks: other");
  quiet(first.next);
  scenario({ reviewComments: [...comments, { ...comments[0], id: 101 }] });
  const second = read(first.next);
  expect(second.news).toEqual(["1 new remarks: other"]);
  quiet(second.next);
});

test("large bodies stay outside captured metadata and one thousand threads keep a compact token", () => {
  const item = {
    id: 1,
    created_at: "2026-10-27T10:00:00Z",
    user: { login: "other" },
    body: "x".repeat(300000),
  };
  scenario({
    comments: [item],
    reviews: [{ ...item, submitted_at: item.created_at }],
    reviewComments: [item],
  });
  const remarks = read();
  expect(remarks.news).toContain("3 new remarks: other");
  expect(remarks.next.length).toBeLessThan(2000);
  scenario({ threadCount: 1000 });
  const threads = read();
  expect(threads.news).toContain("1000 new unresolved threads");
  expect(threads.next.length).toBeLessThan(1000);
  quiet(threads.next);
});
