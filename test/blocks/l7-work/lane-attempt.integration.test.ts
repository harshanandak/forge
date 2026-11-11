import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Lane = {
  issue: string;
  attempt?: string;
  branch: string;
  worktree: string;
};
type Reply = {
  ok: boolean;
  result: Record<string, unknown>;
  error?: { code: string; message: string };
};
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const brief = ".worktrees/briefs/lane.md";
let root: string,
  repo: string,
  sequence = 0;
function git(args: string[], cwd = repo) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}
function call(op: string, input: object = {}, session = "A"): Reply {
  const r = spawnSync(
    "node",
    [bin, ...op.split("."), "--input", JSON.stringify(input)],
    {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
      env: {
        ...process.env,
        FORGE_DEVICE_ROOT: join(root, "device"),
        FORGE_SESSION: session,
      },
    },
  );
  expect(r.error).toBeUndefined();
  return JSON.parse(r.stdout) as Reply;
}
function good(op: string, input: object = {}, session = "A") {
  const r = call(op, input, session);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.result;
}
const branchAt = (cwd: string) => git(["branch", "--show-current"], cwd);
const lanesFor = (id: string) => registry().filter((lane) => lane.issue === id);
const registry = () =>
  JSON.parse(
    readFileSync(join(repo, ".git/forge-lanes.json"), "utf8"),
  ) as Lane[];
function cap(max: number) {
  good("config.apply", {
    expectRevision: good("config.show").revision,
    patch: [{ op: "set", path: "/blocks/work/config/lanes", value: { max } }],
  });
}
function team() {
  cap(50);
  const id = String(
    good("issue.create", { title: `Attempts ${++sequence}` }).id,
  );
  good("issue.claim", { id });
  good("attempt.slots", { id, count: 2 });
  for (const session of ["B", "C"]) good("attempt.reserve", { id }, session);
  return id;
}
const args = (id: string, n: number, extra = {}) => ({
  id,
  attempt: `attempt-${n}`,
  branch: `feat/${id}-${n}`,
  brief,
  ...extra,
});
const path = (id: string, n: number) =>
  join(repo, ".worktrees", `${id}-attempt-${n}`);
function snapshot() {
  return {
    registry: existsSync(join(repo, ".git/forge-lanes.json")) ? registry() : [],
    branches: git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]),
    trees: git(["worktree", "list", "--porcelain"]),
  };
}
function refused(code: string, input: object, session = "B") {
  const before = snapshot();
  expect(call("lane.attempt", input, session).error?.code).toBe(code);
  expect(snapshot()).toEqual(before);
}
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-attempt-lanes-")));
  repo = join(root, "project");
  const origin = join(root, "origin.git");
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
  writeFileSync(
    join(repo, brief),
    "Goal|Acceptance test|Files|Forbidden actions|Stop point|Prior art"
      .split("|")
      .map((name) => `## ${name}\nConcrete content.\n`)
      .join("\n"),
  );
  writeFileSync(
    join(repo, ".worktrees/briefs/other.md"),
    readFileSync(join(repo, brief)),
  );
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }), 30000);

test("a prefix alias cannot adopt an attempt checkout as a legacy lane", () => {
  const id = team();
  good("lane.attempt", args(id, 1), "B");
  const config = join(repo, ".forge/config.yaml"),
    previous = readFileSync(config, "utf8");
  try {
    writeFileSync(
      config,
      previous.replace("idPrefix: sample", `idPrefix: ${id}-attempt`),
    );
    const before = snapshot();
    expect(
      call("lane.start", {
        id: `${id}-attempt-1`,
        branch: args(id, 1).branch,
        brief,
      }).error?.code,
    ).toBe("INPUT_CONFLICT");
    expect(snapshot()).toEqual(before);
  } finally {
    writeFileSync(config, previous);
  }
}, 30000);

test("attempt holders create separate lanes, retry once and count against the shared cap", () => {
  const id = team();
  const before = existsSync(join(repo, ".git/forge-lanes.json"))
    ? registry().length
    : 0;
  for (const [index, session] of ["B", "C"].entries()) {
    const n = index + 1;
    const lane = good("lane.attempt", args(id, n), session);
    expect(lane).toMatchObject({
      issue: id,
      attempt: `attempt-${n}`,
      branch: args(id, n).branch,
    });
    expect(realpathSync(String(lane.worktree))).toBe(realpathSync(path(id, n)));
    expect(branchAt(path(id, n))).toBe(args(id, n).branch);
    expect(good("lane.attempt", args(id, n), session)).toEqual(lane);
  }
  expect(registry()).toHaveLength(before + 2);
  expect(lanesFor(id).map((lane) => lane.attempt)).toEqual([
    "attempt-1",
    "attempt-2",
  ]);
  cap(registry().length);
  const next = String(good("issue.create", { title: "Capped" }).id);
  expect(
    call("lane.start", { id: next, branch: "feat/capped", brief }).error?.code,
  ).toBe("LIMIT_REACHED");
  expect(git(["branch", "--list", "feat/capped"])).toBe("");
  refused("INPUT_CONFLICT", args(id, 1, { branch: "feat/different" }));
  refused(
    "INPUT_CONFLICT",
    args(id, 1, { brief: ".worktrees/briefs/other.md" }),
  );
}, 30000);

test("attempt authority refusals create no branch, worktree or registry row", async () => {
  const id = team();
  refused("LEASE_NOT_HELD", args(id, 2));
  refused("NOT_FOUND", args(id, 99));
  good("attempt.release", { id, attempt: "attempt-1" }, "B");
  refused("LEASE_NOT_HELD", args(id, 1));
  const reserved = good("attempt.reserve", { id, ttlSeconds: 1 }, "B");
  await Bun.sleep(1100);
  refused("LEASE_EXPIRED", { ...args(id, 3), attempt: reserved.id });
  for (const n of [1, 2, 3, 99]) expect(existsSync(path(id, n))).toBe(false);
  good("issue.close", { id, withoutReceipt: "Fixture closed" });
  refused("INPUT_CONFLICT", args(id, 2), "C");
}, 30000);

test("a failed registry write preserves work and retries adopt only their own checkout", () => {
  const id = team();
  const other = good("lane.attempt", args(id, 2), "C");
  const before = registry();
  const lock = join(repo, ".git/forge-lanes.json.lock");
  writeFileSync(lock, "held", { flag: "wx" });
  try {
    const failed = call("lane.attempt", args(id, 1), "B");
    expect(failed.error?.code).toBe("INPUT_CONFLICT");
    expect(failed.error?.message).toContain("same arguments");
    expect(existsSync(path(id, 1))).toBe(true);
    expect(registry()).toEqual(before);
    writeFileSync(join(path(id, 1), "kept"), "user work");
  } finally {
    rmSync(lock);
  }
  const adopted = good("lane.attempt", args(id, 1), "B");
  expect(readFileSync(join(path(id, 1), "kept"), "utf8")).toBe("user work");
  expect(good("lane.attempt", args(id, 1), "B")).toEqual(adopted);
  const { lease: _lease, ...record } = adopted;
  expect([...before, record]).toEqual(registry());
  expect(branchAt(String(other.worktree))).toBe(other.branch as string);
}, 30000);

test("adoption refuses a checkout owned by a different branch", () => {
  const id = team();
  git(["worktree", "add", "-b", "feat/foreign", path(id, 1), "HEAD"]);
  refused("INPUT_CONFLICT", args(id, 1));
  expect(branchAt(path(id, 1))).toBe("feat/foreign");
}, 30000);

test("legacy show, start, close and release preserve both attempt lanes and status rows", () => {
  const id = team();
  good("lane.attempt", args(id, 1), "B");
  expect(call("lane.show", { id }).error?.code).toBe("NOT_FOUND");
  const input = { id, branch: `feat/${id}-legacy`, brief };
  const legacy = good("lane.start", input);
  expect(realpathSync(String(legacy.worktree))).toBe(
    realpathSync(join(repo, ".worktrees", id)),
  );
  expect(good("lane.show", { id })).toMatchObject(legacy);
  expect(good("lane.start", input)).toEqual(legacy);
  const status = () =>
    good("lane.status").lanes as { id: string; attempt?: string }[];
  const previous = status().find(
    (row) => row.id === id && row.attempt === undefined,
  );
  good("lane.attempt", args(id, 2), "C");
  const rows = (
    good("lane.status").lanes as { id: string; attempt?: string }[]
  ).filter((row) => row.id === id);
  expect(
    rows
      .filter((row) => row.attempt)
      .map((row) => row.attempt)
      .sort(),
  ).toEqual(["attempt-1", "attempt-2"]);
  const legacyRow = rows.find((row) => row.attempt === undefined);
  expect(legacyRow).toBeDefined();
  expect(legacyRow).toEqual(previous);
  const attempts = lanesFor(id).filter((lane) => lane.attempt);
  expect(call("lane.release", { id }).error?.code).toBe("INPUT_CONFLICT");
  good("lane.close", { id, noPr: true, dropped: "Fixture finished" });
  expect(lanesFor(id)).toEqual(attempts);
  for (const lane of attempts)
    expect(branchAt(lane.worktree)).toBe(lane.branch);
  expect(existsSync(String(legacy.worktree))).toBe(false);
}, 30000);

test("legacy release preserves both attempt lanes after a hand close", () => {
  // A hand-closed legacy lane can be released without touching attempt lanes.
  const next = team();
  for (const [n, session] of ["B", "C"].entries())
    good("lane.attempt", args(next, n + 1), session);
  const release = good("lane.start", {
    id: next,
    branch: `feat/${next}-legacy`,
    brief,
  });
  good("issue.close", { id: next, withoutReceipt: "Fixture hand closed" });
  good("issue.release", { id: next });
  const kept = lanesFor(next).filter((lane) => lane.attempt);
  good("lane.release", { id: next });
  expect(lanesFor(next)).toEqual(kept);
  expect(existsSync(String(release.worktree))).toBe(false);
  for (const lane of kept) expect(branchAt(lane.worktree)).toBe(lane.branch);
}, 30000);
