import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

setDefaultTimeout(60000);
const root = mkdtempSync(join(tmpdir(), "forge-pr-state-"));
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const node = Bun.which("node")!;
const fake = join(root, "fake");
mkdirSync(fake);
mkdirSync(join(root, ".forge"));
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE)$/i.test(
      name,
    ),
  ),
);
env.PATH = [fake, dirname(node), dirname(Bun.which("git")!)].join(
  process.platform === "win32" ? ";" : ":",
);
env.FORGE_DEVICE_ROOT = join(root, "device");
const initialized = spawnSync(Bun.which("git")!, ["init", "--quiet", root], {
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
function run(since?: string) {
  return spawnSync(
    node,
    [bin, "pr", "state", "7", ...(since ? ["--since", since] : [])],
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
  expect(changed.status).toBe(0);
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

test("failed or incomplete reads, a head moving mid-read and invalid tokens exit nonzero without next", () => {
  for (const broken of [
    { failRead: true },
    { incomplete: true },
    { moveDuringRead: true },
    { changeMetadata: true },
  ]) {
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
