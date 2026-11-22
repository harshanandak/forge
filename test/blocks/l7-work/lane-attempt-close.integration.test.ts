import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { delimiter, join } from "node:path";
import {
  laneCli,
  laneCommands,
  laneGit,
  laneRepository,
  pullFiles,
} from "./lane-repository-fixture.ts";

type Lane = {
  issue: string;
  attempt?: string;
  branch: string;
  worktree: string;
};
const brief = ".worktrees/briefs/attempt.md";
let root: string, repo: string, id: string, head: string;
let commands: Awaited<ReturnType<typeof laneCommands>> | undefined;
const git = (args: string[]) => laneGit(args, repo);
function call(op: string, input: object = {}, session = "coordinator") {
  return laneCli(
    root,
    repo,
    [...op.split("."), "--input", JSON.stringify(input)],
    session,
    {
      PATH: join(root, "bin") + delimiter + process.env.PATH,
      FORGE_DEVICE_ID: "lane-fixture",
    },
  );
}
function good(op: string, input: object = {}, session = "coordinator") {
  const r = call(op, input, session);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.exit).toBe(0);
  return r.result;
}
function configure(patch: object[]) {
  good("config.apply", { expectRevision: good("config.show").revision, patch });
}
function cap(max: number) {
  configure([{ op: "set", path: "/blocks/work/config/lanes", value: { max } }]);
}
const attempt = (n: number) => `attempt-${n}`;
const branch = (n: number) => `feat/${id}-${n}`;
const tree = (n: number) => join(repo, ".worktrees", `${id}-${attempt(n)}`);
const registry = () =>
  JSON.parse(
    readFileSync(join(repo, ".git/forge-lanes.json"), "utf8"),
  ) as Lane[];
function snapshot() {
  return {
    lanes: registry(),
    trees: git(["worktree", "list", "--porcelain"]),
    branches: git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]),
    issue: good("issue.show", { id }),
  };
}
function select() {
  good("attempt.evidence", { id, attempt: attempt(2), sha: head }, "builder-2");
  good("attempt.select", {
    id,
    attempt: attempt(2),
    reason: "Choose the second attempt",
  });
}
function pull(n: number, merged: boolean) {
  writeFileSync(
    join(root, "bin/pull.json"),
    JSON.stringify({
      state: merged ? "MERGED" : "CLOSED",
      headRefName: branch(n),
      baseRefName: "main",
      headRefOid: head,
      mergeCommit: merged ? { oid: head } : null,
      url: `https://github.com/example/project/pull/${n}`,
    }),
  );
}
function receipt() {
  return String(good("check.run", { checks: ["acceptance"] }).id);
}
const closeInput = (n: number, extra: object) => ({
  id,
  attempt: attempt(n),
  pr: n,
  ...extra,
});
function close(n: number, extra: object) {
  return call("lane.close", closeInput(n, extra));
}
function refusedClose(n: number, extra: object, code: string) {
  const before = snapshot();
  const r = close(n, extra);
  expect(r.error?.code, JSON.stringify(r)).toBe(code);
  expect(r.exit).toBe(code === "INPUT_CONFLICT" ? 4 : 1);
  expect(snapshot()).toEqual(before);
  return r;
}
function retained(n: number) {
  expect(git(["rev-parse", `refs/heads/${branch(n)}`])).toBe(head);
}
function removed(n: number) {
  expect(existsSync(tree(n))).toBe(false);
  expect(
    registry().some((lane) => lane.issue === id && lane.attempt === attempt(n)),
  ).toBe(false);
  retained(n);
}
function releaseAttempts() {
  for (const n of [1, 2])
    good("attempt.release", { id, attempt: attempt(n) }, `builder-${n}`);
}
function newLane() {
  const next = String(good("issue.create", { title: "Next lane" }).id);
  return { id: next, branch: `feat/${next}`, brief };
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-attempt-close-")));
  repo = laneRepository(root, brief, {
    ignore: ".forge/\n.worktrees/\nprivate/\n",
    base: "main",
    checkExit: 0,
  }).repo;
  head = git(["rev-parse", "HEAD"]);
  pullFiles(root);
  commands = await laneCommands(root, repo);
  id = String(
    (
      await commands.good("issue.create", {
        title: "Competing attempt cleanup",
      })
    ).id,
  );
  await commands.good("issue.claim", { id });
  await commands.good("attempt.slots", { id, count: 2 });
  for (const n of [1, 2]) {
    const builder = `builder-${n}`;
    await commands.good("attempt.reserve", { id }, builder);
    await commands.good(
      "lane.attempt",
      { id, attempt: attempt(n), branch: branch(n), brief },
      builder,
    );
  }
}, 30000);
afterEach(async () => {
  try {
    await commands?.dispose();
  } finally {
    commands = undefined;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("closing the selected merged attempt removes only its tree and keeps both branches", () => {
  select();
  pull(2, true);
  const r = close(2, { receipt: receipt() });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.exit).toBe(0);
  expect(r.result).toMatchObject({ removed: true, status: "closed" });
  removed(2);
  expect(good("issue.show", { id }).status).toBe("closed");
  expect(existsSync(tree(1))).toBe(true);
  retained(1);
  expect(
    registry()
      .filter((lane) => lane.issue === id)
      .map((lane) => lane.attempt),
  ).toEqual([attempt(1)]);
}, 30000);

for (const closed of [false, true]) {
  test(`dropping an unselected attempt preserves the ${closed ? "closed" : "open"} issue`, () => {
    select();
    if (closed) good("issue.close", { id, withoutReceipt: "Closed by hand" });
    const before = good("issue.show", { id });
    pull(1, false);
    const r = close(1, { dropped: "superseded" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.exit).toBe(0);
    removed(1);
    expect(good("issue.show", { id })).toEqual(before);
    expect(existsSync(tree(2))).toBe(true);
    retained(2);
  }, 30000);
}

test("release removes a released attempt registry row after its tree was removed by hand", () => {
  good("attempt.release", { id, attempt: attempt(1) }, "builder-1");
  git(["worktree", "remove", tree(1)]);
  const before = good("issue.show", { id });
  good("lane.release", { id, attempt: attempt(1) });
  removed(1);
  expect(good("issue.show", { id })).toEqual(before);
  expect(existsSync(tree(2))).toBe(true);
  retained(2);
}, 30000);

test("release refuses a live attempt lease and keeps its work", () => {
  const before = snapshot();
  const r = call("lane.release", { id, attempt: attempt(1) });
  expect(r.error?.code, JSON.stringify(r)).toBe("INPUT_CONFLICT");
  expect(r.exit).toBe(4);
  expect(snapshot()).toEqual(before);
}, 30000);

for (const op of ["lane.close", "lane.release"]) {
  test(`${op} refuses dirty attempt work with the normal lane refusal`, () => {
    select();
    pull(1, false);
    if (op === "lane.release") releaseAttempts();
    writeFileSync(join(tree(1), "tracked"), "keep this edit\n");
    const before = snapshot();
    const r = call(op, {
      id,
      attempt: attempt(1),
      ...(op === "lane.close" ? { pr: 1, dropped: "superseded" } : {}),
    });
    expect(r.error?.code, JSON.stringify(r)).toBe("INPUT_CONFLICT");
    expect(r.exit).toBe(4);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(tree(1), "tracked"), "utf8")).toBe(
      "keep this edit\n",
    );
  }, 30000);
}

test("ignored attempt work requires explicit permission to discard", () => {
  select();
  pull(1, false);
  mkdirSync(join(tree(1), "private"));
  writeFileSync(join(tree(1), "private/kept"), "keep me\n");
  refusedClose(1, { dropped: "superseded" }, "INPUT_CONFLICT");
  expect(readFileSync(join(tree(1), "private/kept"), "utf8")).toBe("keep me\n");
  const r = close(1, { dropped: "superseded", discardIgnored: true });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.exit).toBe(0);
  removed(1);
  expect(existsSync(tree(2))).toBe(true);
}, 30000);

test("an attempt run lock prevents closing its worktree", () => {
  select();
  pull(1, false);
  const lock = join(repo, `.git/forge-lane-${id}.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "held");
  refusedClose(1, { dropped: "superseded" }, "INPUT_CONFLICT");
  expect(readFileSync(join(lock, "owner"), "utf8")).toBe("held");
}, 30000);

test("a selected attempt with an unmerged PR cannot be closed with a receipt", () => {
  select();
  pull(2, false);
  refusedClose(2, { receipt: receipt() }, "PR_NOT_MERGED");
}, 30000);

test("an invalid selected-attempt receipt preserves both attempts", () => {
  select();
  pull(2, true);
  refusedClose(2, { receipt: "missing" }, "RECEIPT_INVALID");
}, 30000);

test("two explicitly closed attempts free the cap alongside a live normal lane", async () => {
  const { call, good } = commands!;
  const nextLane = async () => {
    const next = String(
      (await good("issue.create", { title: "Next lane" })).id,
    );
    return { id: next, branch: `feat/${next}`, brief };
  };
  await good(
    "attempt.evidence",
    { id, attempt: attempt(2), sha: head },
    "builder-2",
  );
  await good("attempt.select", {
    id,
    attempt: attempt(2),
    reason: "Choose the second attempt",
  });
  const live = await nextLane();
  await good("lane.start", live);
  pull(1, false);
  expect(
    (await call("lane.close", closeInput(1, { dropped: "superseded" }))).ok,
  ).toBe(true);
  pull(2, true);
  const receipt = String(
    (await good("check.run", { checks: ["acceptance"] })).id,
  );
  expect((await call("lane.close", closeInput(2, { receipt }))).ok).toBe(true);
  expect(registry().map((lane) => lane.issue)).toEqual([live.id]);
  const status = await good("lane.status");
  expect((status.lanes as { id: string }[]).map((lane) => lane.id)).toEqual([
    live.id,
  ]);
  expect(status.hold ?? "").not.toContain("lane cap");
  await good("lane.start", await nextLane());
  removed(1);
  removed(2);
}, 30000);

test("released attempts with missing worktrees stop holding the cap and disappear from status", () => {
  const live = newLane();
  good("lane.start", live);
  releaseAttempts();
  for (const n of [1, 2]) git(["worktree", "remove", tree(n)]);
  const status = good("lane.status");
  expect(status.hold ?? "").not.toContain("lane cap");
  expect(
    (status.lanes as { id: string; attempt?: string }[]).map((lane) => lane.id),
  ).toEqual([live.id]);
  good("lane.start", newLane());
  retained(1);
  retained(2);
}, 30000);

test("released attempts with existing worktrees continue holding the shared cap", () => {
  good("lane.start", newLane());
  releaseAttempts();
  const before = snapshot();
  const r = call("lane.start", newLane());
  expect(r.error?.code, JSON.stringify(r)).toBe("LIMIT_REACHED");
  expect(r.exit).toBe(1);
  expect(good("lane.status").hold).toContain("lane cap 3 reached");
  expect(registry()).toEqual(before.lanes);
  expect(existsSync(tree(1))).toBe(true);
  expect(existsSync(tree(2))).toBe(true);
}, 30000);

test("three live attempts or normal lanes still hold the shared cap", () => {
  good("lane.start", newLane());
  const before = snapshot();
  const r = call("lane.start", newLane());
  expect(r.error?.code, JSON.stringify(r)).toBe("LIMIT_REACHED");
  expect(r.exit).toBe(1);
  expect(good("lane.status").hold).toContain("lane cap 3 reached");
  expect(registry()).toEqual(before.lanes);
}, 30000);

test("a merged unselected attempt cannot close the issue with a receipt", () => {
  select();
  pull(1, true);
  refusedClose(1, { receipt: receipt() }, "INPUT_CONFLICT");
}, 30000);

test("a selected attempt cannot be discarded as an unselected PR", () => {
  select();
  pull(2, false);
  refusedClose(2, { dropped: "superseded" }, "INPUT_CONFLICT");
}, 30000);

test("release removes a clean released attempt without closing its open issue", () => {
  good("attempt.release", { id, attempt: attempt(1) }, "builder-1");
  const before = good("issue.show", { id });
  good("lane.release", { id, attempt: attempt(1) });
  removed(1);
  expect(good("issue.show", { id })).toEqual(before);
  expect(existsSync(tree(2))).toBe(true);
  retained(2);
}, 30000);

test("closing one attempt preserves the other attempt's pending close journal", () => {
  select();
  pull(1, false);
  const journal = join(repo, `.git/forge-attempt-close-${id}-attempt-2.json`);
  const content = JSON.stringify({
    branch: branch(2),
    worktree: tree(2),
    pr: 2,
  });
  writeFileSync(journal, content);
  const r = close(1, { dropped: "superseded" });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.exit).toBe(0);
  removed(1);
  expect(readFileSync(journal, "utf8")).toBe(content);
  expect(existsSync(tree(2))).toBe(true);
  retained(2);
}, 30000);

test("an attempt cannot be dropped before the coordinator records a selection", () => {
  pull(1, false);
  refusedClose(1, { dropped: "superseded" }, "INPUT_CONFLICT");
}, 30000);

test("a released attempt with pruned registration and remaining files stays visible and registered", () => {
  good("lane.start", newLane());
  good("attempt.release", { id, attempt: attempt(1) }, "builder-1");
  rmSync(join(tree(1), ".git"));
  git(["worktree", "prune", "--expire", "now"]);
  expect(
    git(["worktree", "list", "--porcelain"]).replaceAll("\\", "/"),
  ).not.toContain(tree(1).replaceAll("\\", "/"));
  const kept = join(tree(1), "kept");
  writeFileSync(kept, "preserve this work\n");
  const before = registry();
  const row = before.find(
    (lane) => lane.issue === id && lane.attempt === attempt(1),
  );
  if (!row) throw new Error("Fixture attempt lane is missing");
  const status = good("lane.status");
  expect(status.hold).toContain("lane cap 3 reached");
  expect(status.lanes).toContainEqual(
    expect.objectContaining({ id, attempt: attempt(1) }),
  );
  expect(call("lane.start", newLane()).error?.code).toBe("LIMIT_REACHED");
  expect(registry()).toEqual(before);
  cap(4);
  good("lane.start", newLane());
  expect(registry()).toContainEqual(row);
  expect(readFileSync(kept, "utf8")).toBe("preserve this work\n");
  retained(1);
}, 30000);
