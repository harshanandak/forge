import {
  acceptanceCases,
  acceptancePassCases,
  acceptanceTable,
} from "./lane-brief-fixture.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { processStartTime } from "../../../src/adapters/process/index.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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
  .map(
    (name) =>
      `## ${name}\nConcrete content.\n${name === "Acceptance test" ? acceptanceTable : ""}\n`,
  )
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
function cli(args: string[], cwd = repo, session = "lane-acceptance") {
  const result = spawnSync("node", [bin, ...args], {
    cwd,
    env: {
      ...process.env,
      FORGE_DEVICE_ROOT: join(root, "device"),
      FORGE_SESSION: session,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  expect(result.error).toBeUndefined();
  return Object.assign(JSON.parse(result.stdout), { exit: result.status }) as {
    exit: number;
    ok: boolean;
    result: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}
function helper(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../../../tools/lane.ts"), ...args],
    {
      cwd: repo,
      env: {
        ...process.env,
        PATH: join(root, "bin") + delimiter + process.env.PATH,
        FORGE_DEVICE_ROOT: join(root, "device"),
        FORGE_SESSION: "lane-acceptance",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    },
  );
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout) as {
    verdict: string;
    lanes: { issue: string }[];
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
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/forge"),
    `#!/bin/sh\nexec node "${bin.replaceAll("\\", "/")}" "$@"\n`,
  );
  chmodSync(join(root, "bin/forge"), 0o755);
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
  expect(helper(["list"]).lanes.map((lane) => lane.issue)).toEqual([id]);
  expect(
    helper([
      "start",
      issue(),
      "--branch",
      "feat/helper",
      "--brief",
      join(repo, brief),
      "--max",
      "1",
    ]).verdict,
  ).toBe("refused");
  expect(helper(["list"]).lanes.map((lane) => lane.issue)).toEqual([id]);
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

test("lane CLI refuses a recorded checkout on a different branch or detached HEAD", () => {
  configure(5);
  const id = issue(),
    lane = start(id);
  expect(lane.ok, JSON.stringify(lane)).toBe(true);
  const cwd = String(lane.result.worktree);
  git(["switch", "--detach"], cwd);
  expect(start(id).error?.code).toBe("INPUT_CONFLICT");
  git(["switch", "-c", "feat/other"], cwd);
  expect(start(id).error?.code).toBe("INPUT_CONFLICT");
  git(["switch", `feat/${id}`], cwd);
}, 30000);

test("lane CLI excludes a missing locked checkout from the active cap", () => {
  const lanes = JSON.parse(
    readFileSync(join(repo, ".git/forge-lanes.json"), "utf8"),
  ) as { worktree: string }[];
  const missing = lanes.at(-1)!.worktree;
  git(["worktree", "lock", missing]);
  rmSync(missing, { recursive: true, force: true });
  expect(git(["worktree", "list", "--porcelain"])).toContain(missing);
  const result = start(issue());
  expect(result.ok, JSON.stringify(result)).toBe(true);
}, 30000);

test("lane fetch uses its own ref despite another fetch replacing FETCH_HEAD", async () => {
  const globals = globalThis as Record<string, unknown>,
    previous = globals.fail;
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  try {
    const operations = require("../../../src/blocks/work/entry.cts") as Record<
      string,
      (call: unknown) => Promise<{ base: string }>
    >;
    const recorded: string[][] = [];
    let held = false,
      pinned: string | undefined,
      checkout: string | undefined;
    const services = {
      state: {
        acquire() {},
        lease() {},
        get: () => ({ value: { id: "work-1", status: "open", dependsOn: [] } }),
      },
      files: {
        root: "/project",
        read: (path: string) =>
          path === "forge-lanes.json" ? undefined : text,
        write() {},
        // Only the registry lock matters here; the call's own ref lock does not.
        lock: ([name]: string[]) => {
          if (!name?.includes("registry")) return { release() {} };
          held = true;
          return {
            release: () => {
              held = false;
            },
          };
        },
      },
      environment: { platform: "linux", select: () => ({}) },
      crypto: { randomUUID: () => "invocation-1" },
      process: {
        resolve: () => ({ kind: "resolved", path: "git" }),
        run: (_git: unknown, args: string[]) => {
          recorded.push(args);
          let stdout = "";
          if (args[0] === "fetch") {
            expect(held).toBe(false);
            pinned = args[2]!.split(":")[1];
          }
          if (args[0] === "check-ref-format") stdout = "feat/test";
          if (args[0] === "rev-parse")
            stdout =
              args[2] === pinned + "^{commit}"
                ? "a".repeat(40)
                : "b".repeat(40);
          if (args[0] === "worktree" && args[1] === "list")
            stdout = "worktree /project\0branch refs/heads/main\0\0";
          if (args[0] === "worktree" && args[1] === "add")
            checkout = args.at(-1);
          return Promise.resolve({
            exitCode: 0,
            stdout,
            stderr: "",
            timedOut: false,
            truncated: false,
          });
        },
      },
    };
    const result = await operations["lane.start"]!({
      input: { id: "work-1", branch: "feat/test", brief: "brief.md" },
      config: { lanes: { base: "main" } },
      services,
      signal: new AbortController().signal,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    expect(result.base).toBe("a".repeat(40));
    expect(checkout).toBe(result.base);
    expect(recorded).toContainEqual([
      "update-ref",
      "-d",
      pinned!,
      "--no-deref",
    ]);
    expect(
      recorded.some((args) => args.some((arg) => arg.includes("FETCH_HEAD"))),
    ).toBe(false);
  } finally {
    if (previous === undefined) delete globals.fail;
    else globals.fail = previous;
  }
}, 30000);

test("lane CLI recovers a registry lock left by a dead helper owner", () => {
  configure(6);
  const source = resolve(
    import.meta.dirname,
    "../../../tools/lane-registry.ts",
  );
  const crashed = spawnSync(
    process.execPath,
    [
      "-e",
      `const {lockLaneRegistry}=require(${JSON.stringify(source)});lockLaneRegistry(${JSON.stringify(repo)},${JSON.stringify(join(repo, ".git"))});process.exit(0);`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  expect(crashed.status, crashed.stderr).toBe(0);
  const lock = join(repo, ".git/forge-lanes-registry.lock");
  const marker = readdirSync(lock)[0]!;
  const record = JSON.parse(readFileSync(join(lock, marker), "utf8")) as {
    startTime?: unknown;
  };
  expect(typeof record.startTime).toBe("string");
  expect(record.startTime).not.toBe("");
  const result = start(issue());
  expect(result.ok, JSON.stringify(result)).toBe(true);
}, 30000);

function currentStartTime(): string {
  const value = processStartTime(process.pid);
  expect(value).toBeDefined();
  return value!;
}

test("registry owner identity stays stable across caller timezones", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "EST5";
    const first = currentStartTime();
    process.env.TZ = "JST-9";
    expect(currentStartTime()).toBe(first);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}, 30000);

test.each([
  "matching",
  "different",
  "different format",
  "unparsable",
  "untagged",
])(
  "lane CLI checks a live registry owner's %s start time",
  (identity) => {
    configure(30);
    const id = issue();
    const lock = join(repo, ".git/forge-lanes-registry.lock");
    const marker = `owner-${process.pid}-${randomUUID()}`;
    const startTime = currentStartTime();
    const separator = startTime.indexOf(":"),
      format = startTime.slice(0, separator),
      value = startTime.slice(separator + 1);
    const different =
      format === "darwin-lstart-utc-v1"
        ? `${format}:${new Date(Date.parse(value) - 60000).toISOString()}`
        : `${format}:${BigInt(value) + 1n}`;
    const stored =
      identity === "matching"
        ? startTime
        : identity === "different"
          ? different
          : identity === "different format"
            ? "other-format-v1:123"
            : identity === "untagged"
              ? value
              : `${format}:unparsable`;
    mkdirSync(lock);
    writeFileSync(
      join(lock, marker),
      JSON.stringify({
        startTime: stored,
      }),
    );
    try {
      const result = start(id);
      if (identity !== "different") {
        expect(result.error?.code, JSON.stringify(result)).toBe(
          "INPUT_CONFLICT",
        );
        expect(git(["branch", "--list", `feat/${id}`])).toBe("");
        expect(readdirSync(lock)).toEqual([marker]);
      } else {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  },
  30000,
);

test("lane CLI reclaims a legacy registry marker with a dead PID", () => {
  configure(30);
  const deadPid = 2147483647;
  expect(() => process.kill(deadPid, 0)).toThrow(/ESRCH/);
  const lock = join(repo, ".git/forge-lanes-registry.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${deadPid}-${randomUUID()}`), "");
  try {
    const result = start(issue());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}, 30000);

function closeFixture() {
  configure(30);
  const id = issue();
  const closeRecord = start(id).result;
  expect(call("issue.claim", { id }).ok).toBe(true);
  const head = git(["rev-parse", "HEAD"], String(closeRecord.worktree));
  const pull = {
    state: "MERGED",
    headRefName: closeRecord.branch,
    baseRefName: "main",
    headRefOid: head,
    mergeCommit: { oid: head },
    url: "https://github.com/example/project/pull/42",
  };
  writeFileSync(join(root, "pull.json"), JSON.stringify(pull));
  writeFileSync(
    join(root, "bin/gh.cjs"),
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(root, "pull.json"))}, 'utf8'));`,
  );
  writeFileSync(
    join(root, "bin/gh"),
    `#!/bin/sh\nexec node "${join(root, "bin/gh.cjs").replaceAll("\\", "/")}" "$@"\n`,
  );
  chmodSync(join(root, "bin/gh"), 0o755);
  writeFileSync(
    join(root, "bin/gh.cmd"),
    `@echo off\r\nnode "${join(root, "bin/gh.cjs")}" %*\r\n`,
  );
  return { id, lane: closeRecord, head, pull };
}
function close(
  id: string,
  extra: Record<string, unknown>,
  cwd = repo,
  session = "lane-acceptance",
) {
  const result = spawnSync(
    "node",
    [bin, "lane", "close", "--input", JSON.stringify({ id, pr: 42, ...extra })],
    {
      cwd,
      env: {
        ...process.env,
        PATH: join(root, "bin") + delimiter + process.env.PATH,
        FORGE_DEVICE_ROOT: join(root, "device"),
        FORGE_SESSION: session,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    },
  );
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout) as ReturnType<typeof cli>;
}

test("lane close drops a clean no-PR lane at base and records the reason", () => {
  const { id, lane } = closeFixture();
  const result = close(id, {
    pr: undefined,
    noPr: true,
    dropped: "Abandoned before PR",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(existsSync(String(lane.worktree))).toBe(false);
  expect(git(["branch", "--list", String(lane.branch)])).toBe("");
  expect(call("issue.show", { id }).result.status).toBe("open");
  expect(JSON.stringify(call("issue.comments", { id }).result)).toContain(
    "Abandoned before PR",
  );
}, 30000);

test.each(["no-pr", "merged keep-open"])(
  "a repeated %s close cannot bypass a different session's lease",
  (mode) => {
    const { id } = closeFixture();
    const input =
      mode === "no-pr"
        ? { pr: undefined, noPr: true, dropped: "Paused work" }
        : { receipt: receipt(), keepOpen: true };
    expect(close(id, input).ok).toBe(true);
    expect(call("issue.release", { id }).ok).toBe(true);
    expect(cli(["issue", "claim", id], repo, "lane-second").ok).toBe(true);
    const { result: secondCheckout } = start(id);
    const before = git(["rev-parse", String(secondCheckout.branch)]);
    expect(close(id, input).ok).toBe(false);
    expect(existsSync(String(secondCheckout.worktree))).toBe(true);
    expect(git(["rev-parse", String(secondCheckout.branch)])).toBe(before);
    expect(close(id, input, repo, "lane-second").ok).toBe(true);
    if (mode === "no-pr") {
      const directory = join(repo, ".git/forge-lane-runs", id);
      const archives = readdirSync(directory).filter((name) =>
        name.startsWith("close-no-pr-"),
      );
      expect(archives).toHaveLength(2);
      for (const name of archives)
        expect(
          JSON.parse(readFileSync(join(directory, name), "utf8")),
        ).toMatchObject({ dropped: "Paused work" });
    }
  },
  30000,
);

test("no-PR close explains how to repair a legacy lane without a recorded base", () => {
  const { id, lane } = closeFixture();
  writeFileSync(
    join(repo, ".git/forge-lanes.json"),
    JSON.stringify(registry().map(({ base: _base, ...row }) => row)),
  );
  const result = close(id, {
    pr: undefined,
    noPr: true,
    dropped: "Legacy lane",
  });
  expect(result.error?.message).toContain(
    "Re-record its verified starting commit",
  );
  expect(result.error?.message).toContain("--pr instead of --no-pr");
  expect(existsSync(String(lane.worktree))).toBe(true);
  expect(git(["branch", "--list", String(lane.branch)])).toContain(
    String(lane.branch),
  );
}, 30000);

test("lane close refuses a dirty no-PR drop and preserves ahead commits", () => {
  const { id, lane } = closeFixture(),
    laneDirectory = String(lane.worktree);
  writeFileSync(join(laneDirectory, "unfinished"), "keep");
  const input = { pr: undefined, noPr: true, dropped: "Paused work" };
  expect(close(id, input).error?.code).toBe("INPUT_CONFLICT");
  expect(existsSync(laneDirectory)).toBe(true);
  git(["add", "unfinished"], laneDirectory);
  git(["commit", "-m", "preserve this work"], laneDirectory);
  const head = git(["rev-parse", "HEAD"], laneDirectory);
  const result = close(id, input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(existsSync(laneDirectory)).toBe(false);
  expect(git(["rev-parse", String(lane.branch)])).toBe(head);
  const notes = JSON.stringify(call("issue.comments", { id }).result);
  expect(notes).toContain(head);
  expect(notes).toContain("preserve this work");
}, 30000);

test("lane close invoked inside the lane finishes post-removal cleanup", () => {
  const { id, lane } = closeFixture();
  const proof = receipt(),
    laneDirectory = String(lane.worktree);
  mkdirSync(join(laneDirectory, ".forge"));
  writeFileSync(
    join(laneDirectory, ".forge/config.yaml"),
    readFileSync(join(repo, ".forge/config.yaml")),
  );
  writeFileSync(join(repo, ".git/info/exclude"), ".worktrees/\n.forge/\n");
  const result = close(
    id,
    { receipt: proof, discardIgnored: true },
    laneDirectory,
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(existsSync(String(lane.worktree))).toBe(false);
  expect(git(["branch", "--list", String(lane.branch)])).toBe("");
  expect(registry().some((row) => row.issue === id)).toBe(false);
}, 30000);

function receipt() {
  const current = cli(["config", "show"]);
  expect(
    call("config.apply", {
      expectRevision: current.result.revision,
      patch: [
        {
          op: "set",
          path: "/blocks/check",
          value: {
            source: { builtin: "forge/check" },
            bind: { state: "core" },
            config: {
              commands: {
                acceptance: { argv: ["node", "-e", "process.exit(0)"] },
              },
            },
          },
        },
      ],
    }).ok,
  ).toBe(true);
  const result = call("check.run", { checks: ["acceptance"] });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return String(result.result.id);
}
function registry() {
  return JSON.parse(
    readFileSync(join(repo, ".git/forge-lanes.json"), "utf8"),
  ) as Record<string, unknown>[];
}

test("lane close CLI removes a merged lane with a verified receipt", () => {
  const { id, lane } = closeFixture(),
    proof = receipt();
  expect(close(id, { receipt: "missing" }).error?.code).toBe("RECEIPT_INVALID");
  expect(existsSync(join(repo, `.git/forge-lane-close-${id}.json`))).toBe(
    false,
  );
  const contender = `
const fs = require('node:fs');
const staged = fs.mkdtempSync(${JSON.stringify(join(root, "contender-"))});
fs.writeFileSync(staged + '/owner', 'held');
try { fs.renameSync(staged, ${JSON.stringify(join(repo, `.git/forge-lane-${id}.lock`))}); fs.writeFileSync(${JSON.stringify(join(root, "contender"))}, 'entered'); }
catch { fs.writeFileSync(${JSON.stringify(join(root, "contender"))}, 'excluded'); }
finally { fs.rmSync(staged, { recursive: true, force: true }); }
`;
  const ghScript = join(root, "bin/gh.cjs");
  writeFileSync(ghScript, contender + readFileSync(ghScript, "utf8"));
  const result = close(id, { receipt: proof });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(readFileSync(join(root, "contender"), "utf8")).toBe("excluded");
  expect(result.result).toMatchObject({
    issue: id,
    status: "closed",
    removed: true,
  });
  expect(call("issue.show", { id }).result).toMatchObject({
    status: "closed",
    receipt: proof,
  });
  expect(existsSync(String(lane.worktree))).toBe(false);
  expect(git(["branch", "--list", String(lane.branch)])).toBe("");
  expect(registry().some((row) => row.issue === id)).toBe(false);
}, 30000);

test("lane close CLI drops a closed unmerged PR and keeps the issue and branch", () => {
  const { id, lane, pull } = closeFixture();
  git(["config", "user.name", "Lane test"], origin);
  git(["config", "user.email", "lane@example.test"], origin);
  const remoteHead = git(["commit-tree", "HEAD^{tree}", "-p", "HEAD"], origin);
  git(["--git-dir", origin, "update-ref", "refs/pull/42/head", remoteHead]);
  writeFileSync(
    join(root, "pull.json"),
    JSON.stringify({
      ...pull,
      headRefOid: remoteHead,
      state: "CLOSED",
      mergeCommit: null,
    }),
  );
  const result = close(id, { dropped: "Replaced by another approach" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(call("issue.show", { id }).result.status).toBe("open");
  expect(existsSync(String(lane.worktree))).toBe(false);
  expect(git(["branch", "--list", String(lane.branch)])).toContain(
    String(lane.branch),
  );
  const records = call("issue.comments", { id }).result.records as {
    value: { body: string };
  }[];
  expect(
    records.filter((row) =>
      row.value.body.includes("Replaced by another approach"),
    ),
  ).toHaveLength(1);
}, 30000);

test("lane close CLI refuses a receipt for another merged PR on the same issue", () => {
  const { id, lane, pull } = closeFixture();
  const otherUrl = "https://github.com/example/project/pull/43";
  git(["switch", "--detach"]);
  let proof: string, otherHead: string;
  try {
    git(["commit", "--allow-empty", "-m", "other merged PR"]);
    otherHead = git(["rev-parse", "HEAD"]);
    proof = receipt();
  } finally {
    git(["switch", "main"]);
  }
  expect(otherHead).not.toBe(pull.mergeCommit.oid);
  for (const url of [pull.url, otherUrl])
    expect(call("issue.link", { id, relation: "delivers", url }).ok).toBe(true);
  writeFileSync(
    join(root, "pull-43.json"),
    JSON.stringify({
      ...pull,
      url: otherUrl,
      headRefOid: otherHead,
      mergeCommit: { oid: otherHead },
    }),
  );
  writeFileSync(
    join(root, "bin/gh.cjs"),
    `const file = process.argv[4].endsWith('/43') ? 'pull-43.json' : 'pull.json';
process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(root)} + '/' + file, 'utf8'));`,
  );
  const result = close(id, { receipt: proof });
  expect(result.error?.code, JSON.stringify(result)).toBe(
    "RECEIPT_HEAD_MISMATCH",
  );
  expect(call("issue.show", { id }).result.status).toBe("open");
  expect(existsSync(String(lane.worktree))).toBe(true);
  expect(existsSync(join(repo, `.git/forge-lane-close-${id}.json`))).toBe(
    false,
  );
  const correct = close(id, { receipt: receipt() });
  expect(correct.ok, JSON.stringify(correct)).toBe(true);
  expect(existsSync(String(lane.worktree))).toBe(false);
}, 30000);

test("lane close CLI retries failed cleanup without another close event or comment", () => {
  const { id, lane } = closeFixture(),
    proof = receipt();
  expect(call("issue.release", { id }).ok).toBe(true);
  expect(close(id, { receipt: proof }).error?.code).toBe("CONTEXT_MISSING");
  expect(call("issue.claim", { id }).ok).toBe(true);
  const lock = join(repo, ".git/forge-lanes.json.lock");
  writeFileSync(lock, "held", { flag: "wx" });
  try {
    const failed = close(id, { receipt: proof });
    expect(failed.error?.code, JSON.stringify(failed)).toBe("INPUT_CONFLICT");
  } finally {
    rmSync(lock);
  }
  const accepted = call("issue.show", { id }).result;
  expect(accepted).toMatchObject({ status: "closed", receipt: proof });
  expect(existsSync(String(lane.worktree))).toBe(false);
  expect(call("issue.release", { id }).ok).toBe(true);
  const released = call("issue.show", { id }).result;
  expect(released.lease).toBeUndefined();
  const beforeEvents = call("issue.events", { id }).result.events;
  const beforeComments = call("issue.comments", { id }).result.records;
  expect(beforeComments).toHaveLength(1);
  const result = close(id, { receipt: proof });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(call("issue.show", { id }).result).toEqual(released);
  expect(call("issue.events", { id }).result.events).toEqual(beforeEvents);
  expect(call("issue.comments", { id }).result.records).toEqual(beforeComments);
  expect(existsSync(join(repo, `.git/forge-lane-close-${id}.json`))).toBe(
    false,
  );
}, 30000);

test("lane close CLI refuses a nonempty run lock", () => {
  const { id, lane } = closeFixture(),
    lock = join(repo, `.git/forge-lane-${id}.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "held");
  try {
    const result = close(id, { receipt: "unused" });
    expect(result.error?.code).toBe("INPUT_CONFLICT");
    expect(result.error?.message).toContain("run lock");
    expect(existsSync(String(lane.worktree))).toBe(true);
  } finally {
    rmSync(lock, { recursive: true });
  }
}, 30000);

test("lane close CLI refuses an unmerged PR before tracker or checkout changes", () => {
  const { id, lane, pull } = closeFixture();
  writeFileSync(
    join(root, "pull.json"),
    JSON.stringify({ ...pull, state: "OPEN", mergeCommit: null }),
  );
  expect(close(id, { receipt: "unused" }).error?.code).toBe("PR_NOT_MERGED");
  expect(call("issue.show", { id }).result.status).toBe("open");
  expect(existsSync(String(lane.worktree))).toBe(true);
}, 30000);

test("lane close CLI resumes the helper journal after registry removal without duplicate comments", () => {
  const { id, lane, head, pull } = closeFixture(),
    proof = receipt();
  // Match the old helper's note by body, even when its comment id was not journaled.
  const body = `PR #42 landed: ${pull.url}\nMerge commit: ${head}\nReceipt: ${proof}\nChecks: acceptance: PASS`;
  expect(call("issue.comment", { id, body }).ok).toBe(true);
  const journal = join(repo, `.git/forge-lane-close-${id}.json`);
  writeFileSync(
    journal,
    JSON.stringify({
      pr: 42,
      receipt: proof,
      keepOpen: false,
      dropped: "",
      branch: lane.branch,
      worktree: lane.worktree,
      head,
      mergeCommit: head,
      claimed: true,
    }),
  );
  writeFileSync(
    join(repo, ".git/forge-lanes.json"),
    JSON.stringify(registry().filter((row) => row.issue !== id)),
  );
  expect(close(id, { receipt: proof }).ok).toBe(true);
  const records = call("issue.comments", { id }).result.records as {
    value: { body: string };
  }[];
  expect(records.filter((row) => row.value.body === body)).toHaveLength(1);
  expect(existsSync(journal)).toBe(false);
  expect(existsSync(String(lane.worktree))).toBe(false);
}, 30000);

test("lane registry survives a reverted display prefix for show, start and close", () => {
  configure(30);
  const id = issue();
  const setPrefix = (value: string) => {
    const current = cli(["config", "show"]);
    expect(
      call("config.apply", {
        expectRevision: current.result.revision,
        patch: [{ op: "set", path: "/blocks/work/config/idPrefix", value }],
      }).ok,
    ).toBe(true);
  };
  setPrefix("temporary");
  const temporary = id.replace(/^sample-/, "temporary-"),
    lane = start(temporary).result;
  setPrefix("sample");
  expect(call("lane.show", { id }).ok).toBe(true);
  expect(start(id, { branch: lane.branch }).ok).toBe(true);
  expect(start(issue()).ok).toBe(true);
  // Slice 1 and helper records have no stable-id field. They must remain readable too.
  const old = registry().map(({ issueId: _identity, ...row }) => row);
  writeFileSync(join(repo, ".git/forge-lanes.json"), JSON.stringify(old));
  expect(call("lane.show", { id }).ok).toBe(true);
  expect(call("issue.claim", { id }).ok).toBe(true);
  const head = git(["rev-parse", "HEAD"], String(lane.worktree));
  writeFileSync(
    join(root, "pull.json"),
    JSON.stringify({
      state: "CLOSED",
      headRefName: lane.branch,
      headRefOid: head,
      mergeCommit: null,
      url: "https://github.com/example/project/pull/42",
    }),
  );
  expect(close(id, { dropped: "Prefix recovery" }).ok).toBe(true);
}, 30000);

for (const [name, body, problem] of acceptanceCases) {
  test(`lane acceptance table refuses ${name} without creating anything`, () => {
    configure(100);
    const id = issue(),
      file = `.worktrees/briefs/${id}.md`;
    writeFileSync(join(repo, file), text.replaceAll(acceptanceTable, body));
    const registry = join(repo, ".git/forge-lanes.json");
    const before = existsSync(registry) ? readFileSync(registry, "utf8") : null;
    const trees = git(["worktree", "list", "--porcelain"]);
    const run = start(id, { brief: file });
    expect(run).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID", message: problem },
    });
    expect(run.exit).toBe(6);
    expect(git(["branch", "--list", `feat/${id}`])).toBe("");
    expect(git(["worktree", "list", "--porcelain"])).toBe(trees);
    expect(existsSync(join(repo, ".worktrees", id))).toBe(false);
    expect(existsSync(registry) ? readFileSync(registry, "utf8") : null).toBe(
      before,
    );
  }, 30000);
}

for (const [name, table] of [
  [
    "reordered mixed headers and extra columns",
    "| Extra | eLiGiBiLiTy | EXIT | Status | Input | Case | Unchanged |\n|---|:---|---:|---|---|---|---|\n| extra | lane | 0 | OK | brief | sample | existing |",
  ],
  ...acceptancePassCases,
] as const) {
  test(`lane acceptance table accepts ${name}`, () => {
    configure(100);
    const id = issue(),
      file = `.worktrees/briefs/${id}.md`;
    writeFileSync(join(repo, file), text.replaceAll(acceptanceTable, table));
    const run = start(id, { brief: file });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    expect(run.exit).toBe(0);
    expect(existsSync(String(run.result.worktree))).toBe(true);
    expect(call("lane.show", { id }).result).toMatchObject(run.result);
  }, 30000);
}

test("stored lane briefs without tables keep show and next output", () => {
  configure(100);
  const id = issue(),
    file = `.worktrees/briefs/${id}.md`;
  writeFileSync(join(repo, file), text);
  const started = start(id, { brief: file });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const shown = call("lane.show", { id });
  const next = call("lane.next", { id });
  expect(next.ok, JSON.stringify(next)).toBe(true);
  writeFileSync(
    join(repo, file),
    text.replaceAll(acceptanceTable, "Concrete prose only."),
  );
  expect(call("lane.show", { id })).toEqual(shown);
  expect(call("lane.next", { id })).toEqual(next);
}, 30000);
