import { expect, setDefaultTimeout, test } from "bun:test";
import {
  readWorkMap,
  WORK_MAP_LIMITS,
} from "../../src/assembly/work-map-read.ts";
import { resolveFileOverlap } from "../../src/blocks/work/file-overlap.ts";
import type { ProcessResult } from "../../src/ports/process.ts";

setDefaultTimeout(5000);

type Ports = Parameters<typeof readWorkMap>[0];
type Issue = Awaited<ReturnType<Ports["issues"]>>["items"][number];

const now = "2026-11-27T13:01:00.000Z";
const future = "2026-11-27T13:30:00.000Z";
const defaultSha = "a".repeat(40);
const defaultRef = "refs/remotes/origin/main";
const config = "schemaVersion: forge.config/1\nblocks: {}\n";
const tracked = "src/ui/ask.rs\0src/other.ts\0";
const pullUrl = (n: number) => `https://github.com/owner/project/pull/${n}`;

function issue(id: string, fields: Partial<Issue> = {}): Issue {
  return {
    id,
    title: id,
    status: "open",
    dependsOn: [],
    expectedFiles: [],
    ...fields,
  };
}

function output(
  stdout: string,
  fields: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 0,
    ...fields,
  };
}

function fixture(items: readonly Issue[] = []) {
  const gitCalls: string[][] = [];
  const gitOutputs: Partial<Record<string, ProcessResult>> = {
    "rev-parse": output(`${defaultSha}\n`),
    "ls-tree": output(tracked),
    "cat-file": output(config),
  };
  const ports: Ports = {
    now: () => Date.parse(now),
    issues: () => ({ items, truncated: false }),
    deliveries: () => ({ items: [], truncated: false }),
    pull: () => ({ state: "CLOSED" }),
    process: {
      resolve: () => ({ kind: "resolved", path: "git" }),
      run: (_git, args) => {
        gitCalls.push([...args]);
        return Promise.resolve(
          gitOutputs[args[1] ?? ""] ?? output("", { exitCode: 1 }),
        );
      },
    },
  };
  return {
    ports,
    gitCalls,
    gitOutputs,
    read: () =>
      readWorkMap(ports, {
        cwd: "/project",
        env: {},
        timeoutMs: 5000,
        defaultRef,
      }),
  };
}

test("a released builder's open delivered pull still holds its shared file", async () => {
  const incumbent = issue("work-1", {
    expectedFiles: ["src/ui/*.rs"],
    lease: { expiresAt: future, releasedAt: now },
  });
  const candidate = issue("work-2", { expectedFiles: ["src/ui/ask.rs"] });
  const f = fixture([incumbent, candidate]);
  f.ports.deliveries = (id) => ({
    items: id === incumbent.id ? [pullUrl(1)] : [],
    truncated: false,
  });
  f.ports.pull = () => ({ state: "OPEN", branch: "feat/incumbent" });
  const result = await f.read();
  expect(result.complete).toBe(true);
  expect(result.literalPaths).toEqual(["src/ui/ask.rs"]);
  expect(result.holders).toEqual([
    {
      issue: incumbent,
      openPulls: [{ url: pullUrl(1), branch: "feat/incumbent" }],
    },
  ]);
  expect(
    resolveFileOverlap({
      left: result.holders[0]!.issue,
      right: candidate,
      trackedPaths: result.trackedPaths,
      generatedFiles: result.generatedFiles,
    }).overlaps,
  ).toEqual([
    {
      path: "src/ui/ask.rs",
      leftPattern: "src/ui/*.rs",
      rightPattern: "src/ui/ask.rs",
    },
  ]);
});

test("all delivered links are checked, including after finding an open pull", async () => {
  const incumbent = issue("work-1", { lease: { expiresAt: future } });
  const f = fixture([incumbent]);
  const links = [pullUrl(1), pullUrl(2), pullUrl(3)];
  const observed: string[] = [];
  f.ports.deliveries = () => ({ items: links, truncated: false });
  f.ports.pull = (url) => {
    observed.push(url);
    return { state: url === pullUrl(1) ? "MERGED" : "OPEN" };
  };
  const result = await f.read();
  expect(observed).toEqual(links);
  expect(result.holders).toEqual([
    {
      issue: incumbent,
      leaseExpiresAt: future,
      openPulls: [{ url: pullUrl(2) }, { url: pullUrl(3) }],
    },
  ]);
});

test("expired, exactly expired, released and closed work do not hold files without an open pull", async () => {
  const f = fixture([
    issue("expired", { lease: { expiresAt: "2026-11-27T13:00:59.999Z" } }),
    issue("edge", { lease: { expiresAt: now } }),
    issue("released", { lease: { expiresAt: future, releasedAt: now } }),
    issue("closed", { status: "closed", lease: { expiresAt: future } }),
    issue("unclaimed"),
  ]);
  const observed: string[] = [];
  f.ports.deliveries = (id) => {
    observed.push(id);
    return { items: id === "released" ? [pullUrl(1)] : [], truncated: false };
  };
  const result = await f.read();
  expect(observed).toEqual(["expired", "edge", "released", "unclaimed"]);
  expect(result).toMatchObject({ complete: true, reasons: [], holders: [] });
});

test("a pull-host outage cannot certify an empty snapshot", async () => {
  const f = fixture([issue("work-1")]);
  f.ports.deliveries = () => ({ items: [pullUrl(1)], truncated: false });
  f.ports.pull = () => {
    throw new Error("host unreachable");
  };
  expect(await f.read()).toMatchObject({
    complete: false,
    holders: [],
    reasons: [{ kind: "pull-unavailable", issue: "work-1" }],
  });
});

test("an unavailable issue authority is incomplete", async () => {
  const f = fixture();
  f.ports.issues = () => {
    throw new Error("authority unavailable");
  };
  expect(await f.read()).toMatchObject({
    complete: false,
    reasons: [{ kind: "issues-unavailable" }],
  });
});

test("an unparseable lease expiry makes the snapshot incomplete", async () => {
  const healthy = issue("work-1", { lease: { expiresAt: future } });
  const damaged = issue("work-2", { lease: { expiresAt: "unreadable" } });
  expect(await fixture([healthy, damaged]).read()).toMatchObject({
    complete: false,
    holders: [{ issue: healthy, leaseExpiresAt: future }],
    reasons: [{ kind: "issues-unavailable", issue: damaged.id }],
  });
});

test("issue truncation preserves the visible holders and is incomplete", async () => {
  const incumbent = issue("work-1", { lease: { expiresAt: future } });
  const f = fixture([incumbent]);
  f.ports.issues = ({ limit, maxBytes }) => {
    expect(limit).toBe(WORK_MAP_LIMITS.issues);
    expect(maxBytes).toBe(WORK_MAP_LIMITS.outputBytes);
    return { items: [incumbent], truncated: true };
  };
  expect(await f.read()).toMatchObject({
    complete: false,
    holders: [{ issue: incumbent }],
    reasons: [{ kind: "issues-truncated" }],
  });
});

test("truncated deliveries and unavailable delivery reads are reported by issue", async () => {
  const f = fixture([issue("work-1"), issue("work-2")]);
  f.ports.deliveries = (id, { limit }) => {
    expect(limit).toBe(WORK_MAP_LIMITS.linksPerIssue);
    if (id === "work-2") throw new Error("links unavailable");
    return { items: [], truncated: true };
  };
  expect(await f.read()).toMatchObject({
    complete: false,
    reasons: [
      { kind: "deliveries-truncated", issue: "work-1" },
      { kind: "deliveries-unavailable", issue: "work-2" },
    ],
  });
});

test("Git tree failure cannot certify a complete snapshot", async () => {
  const f = fixture();
  f.gitOutputs["ls-tree"] = output("", { exitCode: 128 });
  expect(await f.read()).toMatchObject({
    complete: false,
    reasons: [{ kind: "git-unavailable", source: "tracked-paths" }],
  });
});

test("invalid generated rules and a missing policy blob are unreadable", async () => {
  for (const policy of [
    output(
      "blocks: {work: {source: {builtin: forge/work}, config: {generatedFiles: [invalid]}}}",
    ),
    output("blocks: ["),
    output("", { exitCode: 128 }),
  ]) {
    const f = fixture();
    f.gitOutputs["cat-file"] = policy;
    expect(await f.read()).toMatchObject({
      complete: false,
      reasons: [{ kind: "policy-unreadable" }],
      generatedFiles: [],
    });
  }
});

test("paths and generated rules share the pinned default SHA, read once", async () => {
  const f = fixture();
  f.gitOutputs["cat-file"] = output(
    "blocks: {work: {source: {builtin: forge/work}, config: {generatedFiles: [{glob: 'src/generated/**', regenerate: {argv: [gen]}}]}}}",
  );
  expect(await f.read()).toMatchObject({
    complete: true,
    observedAt: now,
    defaultSha,
    trackedPaths: ["src/ui/ask.rs", "src/other.ts"],
    generatedFiles: [
      { glob: "src/generated/**", regenerate: { argv: ["gen"] } },
    ],
  });
  const commands = [
    `rev-parse --verify --end-of-options ${defaultRef}^{commit}`,
    `ls-tree -rz --name-only --full-tree ${defaultSha}`,
    `cat-file blob ${defaultSha}:.forge/config.yaml`,
  ];
  expect(f.gitCalls).toEqual(
    commands.map((command) => ["--no-replace-objects", ...command.split(" ")]),
  );
});

test("learned paths on open issues satisfy a holder's glob, but closed issues cannot", async () => {
  const incumbent = issue("work-1", {
    lease: { expiresAt: future },
    expectedFiles: ["new/*.ts"],
  });
  const futureFile = issue("work-2", { actualFiles: ["new/file.ts"] });
  expect(await fixture([incumbent, futureFile]).read()).toMatchObject({
    complete: true,
    literalPaths: ["new/file.ts"],
  });
  expect(
    await fixture([incumbent, { ...futureFile, status: "closed" }]).read(),
  ).toMatchObject({
    complete: false,
    reasons: [
      { kind: "unmatched-pattern", issue: incumbent.id, pattern: "new/*.ts" },
    ],
  });
});

test("an active issue with learned files and no expected declaration is incomplete", async () => {
  const { expectedFiles: _omitted, ...incumbent } = issue("work-1", {
    lease: { expiresAt: future },
    actualFiles: ["src/ui/ask.rs"],
  });
  expect(await fixture([incumbent]).read()).toMatchObject({
    complete: false,
    holders: [{ issue: incumbent }],
    reasons: [{ kind: "undeclared", issue: incumbent.id }],
  });
});

test("issue output is bounded before delivery or declaration processing", async () => {
  const f = fixture(
    Array.from({ length: 300 }, (_, index) =>
      issue(`work-${index}`, { expectedFiles: Array(8).fill("x".repeat(512)) }),
    ),
  );
  f.ports.deliveries = () => {
    throw new Error("over-budget issues must never be processed");
  };
  expect(await f.read()).toMatchObject({
    complete: false,
    holders: [],
    reasons: [{ kind: "output-budget", source: "issues" }],
  });
});

test.each(["process", "output"] as const)(
  "cached open deliveries survive the %s budget cut",
  async (budget) => {
    const f = fixture([issue("work-1"), issue("work-2")]);
    const cached = pullUrl(1);
    const oversized = pullUrl(100);
    const unread = pullUrl(101);
    const processLimited = budget === "process";
    const count = processLimited ? WORK_MAP_LIMITS.processes - 3 : 1;
    const first = Array.from({ length: count }, (_, n) => pullUrl(n + 1));
    const second = processLimited
      ? [unread, cached]
      : [oversized, unread, cached];
    f.ports.deliveries = (id) => ({
      items: id === "work-1" ? first : second,
      truncated: false,
    });
    const observed: string[] = [];
    f.ports.pull = (url, { maxBytes }) => {
      expect(maxBytes).toBeGreaterThan(0);
      expect(maxBytes).toBeLessThan(WORK_MAP_LIMITS.outputBytes);
      observed.push(url);
      if (url === oversized)
        return { state: "OPEN", branch: "x".repeat(maxBytes) };
      return { state: url === cached ? "OPEN" : "CLOSED" };
    };
    const result = await f.read();
    expect(observed).toEqual(processLimited ? first : [cached, oversized]);
    expect(result.complete).toBe(false);
    expect(result.reasons).toContainEqual({
      kind: `${budget}-budget`,
      issue: "work-2",
      source: "pull",
    });
    expect(result.holders.map((holder) => holder.issue.id)).toEqual([
      "work-1",
      "work-2",
    ]);
  },
);

test("a pattern scan that exceeds the work budget yields an incomplete snapshot", async () => {
  const f = fixture([
    issue("work-1", {
      lease: { expiresAt: future },
      expectedFiles: ["src/" + "?".repeat(1000)],
    }),
  ]);
  f.gitOutputs["ls-tree"] = output(
    Array.from(
      { length: 1000 },
      (_, n) => `src/${n}`.padEnd(100, "x") + "\0",
    ).join(""),
  );
  expect(await f.read()).toMatchObject({
    complete: false,
    holders: [{ issue: { id: "work-1" } }],
    reasons: [{ kind: "resolution-budget", issue: "work-1" }],
  });
});
