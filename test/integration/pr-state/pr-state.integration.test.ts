import { afterAll, expect, setDefaultTimeout, test as bunTest } from "bun:test";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { scriptFixture } from "../../script-fixture.ts";
import entry from "../../../src/blocks/check/entry.cts";
import { checkCrypto } from "../../../src/blocks/check/support.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

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
env.PATH = `${fake}${delimiter}${process.env.PATH ?? ""}`;
env.FORGE_DEVICE_ROOT = join(root, "device");
const initialized = spawnSync(git, ["init", "--quiet", root], {
  env,
  encoding: "utf8",
  windowsHide: true,
  timeout: 10000,
});
if (initialized.status !== 0)
  throw new Error("Could not initialize isolated Git fixture");
let configuredCap: number | undefined;
let cliLaunches = 0,
  mcpLaunches = 0,
  fakeChecks = 0,
  logicReads = 0,
  cases = 0;

// Label, CLI launches, in-process reads, fake-script validation cases.
const inventory: [string, number, number, number][] = [
  ["MCP initialization", 0, 0, 0],
  ["count three", 3, 0, 0],
  ["rejects review cap", 1, 0, 0],
  ["retain edited", 1, 0, 0],
  ["omit stale", 1, 0, 0],
  ["excludes pure", 0, 2, 0],
  ["leave base-only", 3, 0, 0],
  ["bot summary activity", 0, 3, 0],
  ["the fake rejects", 0, 0, 8],
  ["reads the configured", 2, 0, 0],
  ["emits one raw", 3, 0, 0],
  ["pr.state reports", 0, 2, 0],
  ["each new failure", 0, 7, 0],
  ["all remark feeds", 0, 4, 0],
  ["pending, queue", 0, 9, 0],
  ["R2-1 final", 0, 3, 0],
  ["failed or incomplete", 4, 0, 0],
  ["R2-5 required green", 0, 5, 0],
  ["optional failures", 0, 6, 0],
  ["R2-5 inline", 0, 4, 0],
  ["large bodies", 0, 3, 0],
];

// Per-case deltas remain exact when Bun selects a subset with -t.
function test(name: string, body: () => unknown) {
  cases++;
  const counts = inventory.find(([label]) => name.includes(label));
  if (!counts) throw new Error(`Missing launch inventory: ${name}`);
  const [, ...expected] = counts;
  bunTest(name, async () => {
    const before = [cliLaunches, logicReads, fakeChecks];
    const beforeMcp = mcpLaunches;
    const expectedMcp = name.startsWith("MCP initialization")
      ? 1
      : name.includes("CLI and MCP")
        ? Number(!mcpClients.has(undefined)) +
          (name.includes("count three") ? Number(!mcpClients.has(3)) : 0)
        : 0;
    await body();
    expect(
      [cliLaunches, logicReads, fakeChecks].map((n, i) => n - before[i]!),
    ).toEqual(expected);
    expect(mcpLaunches - beforeMcp).toBe(expectedMcp);
  });
}

function configure(rounds?: number) {
  configuredCap = rounds;
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        check: {
          source: { builtin: "forge/check" },
          config: {
            commands: {},
            ...(rounds === undefined ? {} : { review: { rounds } }),
          },
        },
      },
      mcp: { expose: ["pr"] },
    }),
  );
}
configure();
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
const mcpClients = new Map<number | undefined, ReturnType<typeof startMcp>>();
async function closeMcpClients(
  clients: Iterable<Promise<{ close(): Promise<void> }>>,
  directory: string,
) {
  const results = await Promise.allSettled(
    Array.from(clients, async (client) => (await client).close()),
  );
  rmSync(directory, { recursive: true, force: true });
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}
afterAll(async () => {
  await closeMcpClients(mcpClients.values(), root);
  console.log(
    JSON.stringify({
      file: "pr-state",
      launches: 1 + cliLaunches + mcpLaunches,
      fakeChecks,
      logicReads,
    }),
  );
});
function run(since?: string, pr = 7) {
  cliLaunches++;
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
  reviewRounds?: number;
  nextSteps?: string[];
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

async function mcpRead(): Promise<State> {
  if (!mcpClients.has(configuredCap)) mcpClients.set(configuredCap, startMcp());
  return (await mcpClients.get(configuredCap)!).read();
}
async function startMcp(
  initialize?: () => Promise<unknown>,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
) {
  mcpLaunches++;
  const child = spawn(node, [bin, "--mcp"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  onSpawn?.(child);
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  async function close() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  let sequence = 0,
    buffer = "",
    errors = "";
  const pending = new Map<number, (value: unknown) => void>();
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (message.id !== undefined)
        pending.get(message.id)?.(
          message.error ? { error: message.error } : message.result,
        );
    }
  });
  async function rpc(method: string, params: object) {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, resolve);
      timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out: ${errors}`)),
        20000,
      );
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    try {
      return await response;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  try {
    await (initialize
      ? initialize()
      : rpc("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "pr-state-integration", version: "1" },
        }));
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async read(): Promise<State> {
      const result = (await rpc("tools/call", {
        name: "pr_state",
        arguments: { pr: 7 },
      })) as {
        content: { text: string }[];
        structuredContent: { ok: boolean; result: State };
      };
      expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
        ok: true,
      });
      expect(JSON.parse(result.content[0]!.text)).toEqual(
        result.structuredContent,
      );
      return result.structuredContent.result;
    },
    close,
  };
}

test("MCP initialization failure closes the child and teardown drains every client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-pr-state-init-failure-"));
  const failure = new Error("Injected initialization failure");
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = 0;
  const startup = startMcp(
    () => Promise.reject(failure),
    (value) => {
      child = value;
    },
  );
  try {
    await expect(
      closeMcpClients(
        [
          startup,
          Promise.resolve({
            close: () => {
              closed++;
              return Promise.reject(new Error("Injected close failure"));
            },
          }),
          Promise.resolve({
            close: () => {
              closed++;
              return Promise.resolve();
            },
          }),
        ],
        directory,
      ),
    ).rejects.toBe(failure);
    expect(child!.stdin.writableEnded).toBe(true);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(closed).toBe(2);
    expect(existsSync(directory)).toBe(false);
  } finally {
    child?.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

function reviewedCycles() {
  const commits = Array.from({ length: 4 }, (_, index) => ({
    sha: String(index + 1).repeat(40),
    time: `2026-10-27T${index * 2 + 10}:00:00Z`,
    parents: index ? [String(index).repeat(40)] : [],
    message: "fix: review feedback",
  }));
  const user = { login: "reviewer" };
  return {
    head: commits[3]!.sha,
    commitPages: [commits.slice(0, 2), commits.slice(2)],
    reviewPages: [
      [],
      [
        {
          id: 1,
          user,
          commit_id: commits[0]!.sha,
          submitted_at: "2026-10-27T11:00:00Z",
          state: "CHANGES_REQUESTED",
        },
      ],
    ],
    inlinePages: [
      [],
      [
        {
          id: 2,
          user,
          original_commit_id: commits[1]!.sha,
          created_at: "2026-10-27T13:00:00Z",
        },
      ],
    ],
    issuePages: [
      [],
      [
        {
          id: 3,
          user: { login: "reviewer[bot]", type: "Bot" },
          body: `Review findings for ${commits[2]!.sha.slice(0, 8)}: approved`,
          created_at: "2026-10-27T15:00:00Z",
        },
      ],
    ],
    commits,
  };
}

test("built CLI and MCP count three completed reviews and honor the configured cap", async () => {
  const history = reviewedCycles();
  scenario(history);
  const prompt =
    "Round 3 exceeds the review cap (2). Write a three-line threat model, then choose ship, simplify or park; do not patch the same design again.";
  const cli = read(),
    mcp = await mcpRead();
  for (const state of [cli, mcp])
    expect(state).toMatchObject({
      reviewRounds: 3,
      nextSteps: [prompt],
      verdict: "ready",
    });
  configure(3);
  try {
    const changed = read(cli.next);
    for (const state of [changed, await mcpRead()]) {
      expect(state.reviewRounds).toBe(3);
      expect(state).not.toHaveProperty("nextSteps");
    }
    quiet(changed.next);
  } finally {
    configure();
  }
  console.log(
    JSON.stringify({
      scenario: "completed reviews",
      cli: { reviewRounds: cli.reviewRounds, nextSteps: cli.nextSteps },
      mcp: { reviewRounds: mcp.reviewRounds, nextSteps: mcp.nextSteps },
      configuredCap: 3,
    }),
  );
});

for (const cap of [0, 11, 1e100])
  test(`built CLI rejects review cap ${cap}`, () => {
    try {
      configure(cap);
      scenario({});
      const result = run();
      expect(result.status, `cap ${cap}`).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID", reconcileWith: "config.show" },
      });
      expect(result.stdout).toContain("blocks.check.config.review.rounds");
      expect(result.stdout).toContain(
        cap === 0 ? "must be at least 1" : "must be at most 10",
      );
    } finally {
      configure();
    }
  });

test("built CLI and MCP retain edited bot review events across a fix and base-only merge", async () => {
  const reviewed = "719a3a0" + "1".repeat(33),
    fixed = "18a5727" + "2".repeat(33),
    merged = "9".repeat(40);
  scenario({
    head: merged,
    commits: [
      {
        sha: reviewed,
        time: "2026-10-28T21:58:00Z",
        parents: [],
        message: "fix: first",
      },
      {
        sha: fixed,
        time: "2026-10-28T22:11:00Z",
        parents: [reviewed],
        message: "fix: feedback",
      },
      {
        sha: merged,
        time: "2026-10-28T22:14:00Z",
        parents: [fixed, "b".repeat(40)],
        message: "Merge branch 'main' into feature",
      },
    ],
    issuePages: [
      [],
      [
        {
          id: 131,
          user: { login: "reviewer[bot]", type: "Bot" },
          body: "Review findings for the current revision",
          created_at: "2026-10-28T21:57:00Z",
          updated_at: "2026-10-28T22:12:00Z",
          editPages: [
            Array.from({ length: 100 }, () => ({
              editedAt: "2026-10-28T22:12:00Z",
              diff: "+Review completed",
            })),
            [{ editedAt: "2026-10-28T22:00:00Z", diff: "+Review findings" }],
          ],
        },
      ],
    ],
  });
  for (const state of [read(), await mcpRead()])
    expect(state.reviewRounds).toBe(1);
});

test("built CLI and MCP omit stale review advisory on a final head race", async () => {
  for (const readState of [() => Promise.resolve(read()), mcpRead]) {
    scenario({ ...reviewedCycles(), afterHead: "a" });
    const value = await readState();
    expect(value).toMatchObject({ verdict: "waiting", end: false });
    expect(value).not.toHaveProperty("reviewRounds");
    expect(value).not.toHaveProperty("nextSteps");
  }
});

test("pr.state excludes pure running edits and retains substantive summary edits", async () => {
  const history = reviewedCycles();
  for (const [diff, count] of [
    ["+Review running", 0],
    ["+Review findings: issue found; review running", 1],
  ] as const) {
    scenario({
      head: history.head,
      commits: history.commits,
      comments: [
        {
          id: 1,
          user: { login: "reviewer[bot]", type: "Bot" },
          body: "Review findings",
          created_at: "2026-10-27T11:00:00Z",
          editPages: [[{ editedAt: "2026-10-27T11:00:00Z", diff }]],
        },
      ],
    });
    expect((await stateRead()).reviewRounds).toBe(count);
  }
});

test("built CLI and MCP leave base-only updates and in-progress review at zero", async () => {
  const history = reviewedCycles();
  const reviewed = history.commits[0]!;
  for (const update of [false, true]) {
    const sha = "9".repeat(40),
      base = "b".repeat(40);
    scenario({
      head: sha,
      commits: [
        reviewed,
        {
          sha,
          time: "2026-10-27T18:00:00Z",
          parents: [reviewed.sha, base],
          message: update
            ? "Merge branch 'main' into feature"
            : "Merge upstream",
        },
      ],
      reviewPages: history.reviewPages,
      baseParents: update ? [] : [base],
    });
    for (const state of [read(), await mcpRead()]) {
      expect(state.reviewRounds).toBe(0);
      expect(state).not.toHaveProperty("nextSteps");
    }
  }
  scenario({
    head: reviewed.sha,
    commits: [reviewed],
    reviewPages: history.reviewPages,
  });
  for (const state of [read(), await mcpRead()])
    expect(state.reviewRounds).toBe(0);
});

test("bot summary activity ignores hash references and duplicate evidence counts once", async () => {
  const history = reviewedCycles(),
    sha = history.commits[0]!.sha,
    time = "2026-10-27T11:00:00Z";
  scenario({
    head: history.head,
    commits: history.commits,
    comments: [
      {
        id: 1,
        user: { login: "person" },
        body: `Review findings ${sha}`,
        created_at: time,
      },
      {
        id: 2,
        user: { login: "person" },
        body: `Review findings z${sha}z`,
        created_at: time,
      },
    ],
  });
  expect((await stateRead()).reviewRounds).toBe(0);
  scenario({
    head: history.head,
    commits: history.commits,
    comments: [
      {
        id: 1,
        user: { login: "reviewer[bot]", type: "Bot" },
        body: `Review findings ${sha}`,
        created_at: time,
        updated_at: "2026-10-27T18:00:00Z",
      },
    ],
  });
  expect((await stateRead()).reviewRounds).toBe(1);
  scenario({
    head: history.head,
    commits: history.commits,
    reviewPages: [history.reviewPages[1], history.reviewPages[1]],
  });
  expect((await stateRead()).reviewRounds).toBe(1);
});

const fakeGh = scriptFixture(join(import.meta.dirname, "gh.mjs"));

async function stateRead(since?: string): Promise<State> {
  const value = await stateValue(since);
  expect(value).not.toBeNull();
  return value!;
}
async function stateQuiet(since: string) {
  expect(await stateValue(since)).toBeNull();
}
async function stateValue(since?: string): Promise<State | null> {
  logicReads++;
  const processPort: ProcessPort = {
    capability: "forge.process/v1",
    resolve: (path) => ({ kind: "resolved", path }),
    run(_executable, args) {
      const result = fakeGh("", [...args], env, root);
      return Promise.resolve({
        ...result,
        exitCode: result.status,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 0,
      });
    },
  };
  return (
    entry as unknown as Record<string, (args: unknown) => Promise<State | null>>
  )["pr.state"]!({
    input: { pr: 7, ...(since ? { since } : {}) },
    config: { environment: [], review: { rounds: configuredCap ?? 2 } },
    signal: new AbortController().signal,
    deadline: Date.now() + 45000,
    services: {
      process: processPort,
      files: { root },
      environment: { select: () => env },
      crypto: checkCrypto,
    },
  });
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
      fakeChecks++;
      const result = fakeGh("", args, env, root);
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
  test(`pr.state reports ${name}`, async () => {
    scenario(value);
    const state = await stateRead();
    expect(state).toMatchObject({ verdict, end });
    await stateQuiet(state.next);
  });

test("each new failure, comment and head cycle emits its news once", async () => {
  scenario({ pending: true });
  const baseline = await stateRead();
  scenario({ failed: true, merge: "BLOCKED" });
  const failure = await stateRead(baseline.next);
  expect(failure.news).toEqual(["check failed: test"]);
  await stateQuiet(failure.next);
  const comment = {
    id: 1,
    created_at: "2026-10-27T10:00:00Z",
    user: { login: "other" },
  };
  scenario({ failed: true, merge: "BLOCKED", comments: [comment] });
  const remark = await stateRead(failure.next);
  expect(remark.news).toEqual(["1 new remarks: other"]);
  await stateQuiet(remark.next);
  scenario({ head: "b", comments: [comment] });
  const moved = await stateRead(remark.next);
  expect(moved.news).toEqual(["head moved", "required checks passed"]);
  await stateQuiet(moved.next);
});

test("all remark feeds, later pages, own comments and same-time ids retain the cursor", async () => {
  const time = "2026-10-27T10:00:00Z",
    user = { login: "other" };
  const comment = { id: 1, created_at: time, user };
  scenario({
    issuePages: [[], [comment]],
    reviews: [{ id: 2, submitted_at: time, user }],
    reviewComments: [{ ...comment, id: 3 }],
  });
  const first = await stateRead();
  expect(first.news).toContain("3 new remarks: other");
  await stateQuiet(first.next);
  scenario({
    issuePages: [[], [comment, { ...comment, id: 4 }]],
    reviews: [{ id: 2, submitted_at: time, user }],
    reviewComments: [
      { ...comment, id: 3 },
      { ...comment, id: 5, user: { login: "self" } },
    ],
  });
  const next = await stateRead(first.next);
  expect(next.news).toEqual(["1 new remarks: other"]);
  await stateQuiet(next.next);
});

test("pending, queue and thread resolutions wake terminal readiness without a head move", async () => {
  for (const blocked of [
    { pending: true },
    { queued: true },
    { threads: true },
  ]) {
    scenario(blocked);
    const first = await stateRead();
    scenario({});
    const ready = await stateRead(first.next);
    expect(ready).toMatchObject({ verdict: "ready", end: true });
    expect(ready.news.length).toBeGreaterThan(0);
    await stateQuiet(ready.next);
  }
});

for (const [name, value, head] of [
  ["head", { afterHead: "b" }, "b"],
  ["state", { state: "CLOSED", afterState: "OPEN" }, "a"],
] as const)
  test(`R2-1 final ${name} race waits and does not latch stale passing checks`, async () => {
    scenario(value);
    const changed = await stateRead();
    expect(changed).toMatchObject({
      head: head.repeat(40),
      verdict: "waiting",
      end: false,
    });
    expect(changed.news).not.toContain("required checks passed");
    const stable = await stateRead(changed.next);
    expect(stable).toMatchObject({
      head: head.repeat(40),
      verdict: "ready",
      end: true,
    });
    expect(stable.news).toContain("required checks passed");
    await stateQuiet(stable.next);
  });

test("failed or incomplete reads and invalid tokens exit nonzero without next", () => {
  for (const broken of [
    { failRead: true },
    { incomplete: true },
    { incompleteSummaries: true },
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
test("R2-5 required green, failed and green checks announce passing once per head", async () => {
  scenario({});
  const first = await stateRead();
  expect(first.news).toContain("required checks passed");
  scenario({ failed: true, merge: "BLOCKED" });
  const failed = await stateRead(first.next);
  expect(failed.verdict).toBe("blocked");
  expect(failed.news).toEqual(["check failed: test"]);
  await stateQuiet(failed.next);
  scenario({});
  const restored = await stateRead(failed.next);
  expect(restored).toMatchObject({ verdict: "ready", end: true });
  expect(restored.news).not.toContain("required checks passed");
  await stateQuiet(restored.next);
});

test("optional failures block while missing checks and GitHub BLOCKED do not announce passing", async () => {
  scenario({});
  const first = await stateRead();
  scenario({ optionalFailed: true });
  const failed = await stateRead(first.next);
  expect(failed.verdict).toBe("blocked");
  expect(failed.news).toContain("check failed: optional");
  scenario({});
  const restored = await stateRead(failed.next);
  expect(restored.news).not.toContain("required checks passed");
  await stateQuiet(restored.next);
  scenario({ merge: "BLOCKED" });
  expect((await stateRead()).news).not.toContain("required checks passed");
  scenario({ empty: true });
  expect(await stateRead()).toMatchObject({
    verdict: "waiting",
    reasons: ["no checks reported"],
  });
});
test("R2-5 inline page two emits a new same-time remark exactly once", async () => {
  const comments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    created_at: "2026-10-27T10:00:00Z",
    user: { login: "other" },
  }));
  scenario({ reviewComments: comments });
  const first = await stateRead();
  expect(first.news).toContain("100 new remarks: other");
  await stateQuiet(first.next);
  scenario({ reviewComments: [...comments, { ...comments[0], id: 101 }] });
  const second = await stateRead(first.next);
  expect(second.news).toEqual(["1 new remarks: other"]);
  await stateQuiet(second.next);
});

test("large bodies stay outside captured metadata and one thousand threads keep a compact token", async () => {
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
  const remarks = await stateRead();
  expect(remarks.news).toContain("3 new remarks: other");
  expect(remarks.next.length).toBeLessThan(2000);
  scenario({ threadCount: 1000 });
  const threads = await stateRead();
  expect(threads.news).toContain("1000 new unresolved threads");
  expect(threads.next.length).toBeLessThan(1000);
  await stateQuiet(threads.next);
});

// Registration includes all loop cases even in focused runs.
if (cases !== 34) throw new Error(`Expected 34 pr-state cases, got ${cases}`);
