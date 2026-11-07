// [integration] Real CLI and git in disposable repos; source commands are fakes.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnBudget } from "../spawn-budget.ts";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const since = new Date(Date.now() - 24 * 3600_000).toISOString();
const mergedAt = new Date(Date.now() - 3600_000).toISOString();
const merged = [1, 2].map((number) => ({
  number,
  title: `Merge ${number}`,
  mergeCommit: { oid: `sha-${number}` },
  url: `https://github.com/owner/repo/pull/${number}`,
  mergedAt,
}));
function fixture(
  options: {
    fail?: string;
    prs?: unknown[];
    merged?: typeof merged;
    issues?: { id: string; title: string; createdAt: string }[];
    lanes?: unknown[];
    truncated?: boolean;
    checks?: Record<
      string,
      { status: number; stderr?: string; rows?: unknown[] }
    >;
    replies?: Record<string, string>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-digest-"));
  roots.push(root);
  mkdirSync(join(root, "tools"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}');
  for (const name of ["digest.ts", "run-command.ts"]) {
    const file = resolve(import.meta.dirname, "../../tools", name);
    if (existsSync(file)) copyFileSync(file, join(root, "tools", name));
  }
  const budget = spawnBudget(30_000);
  const git = (...args: string[]) =>
    budget
      .run(`git ${args.join(" ")}`, "git", args, { cwd: root }, 0)
      .stdout.trim();
  git("init");
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  const marker = join(root, ".git/forge-digest.json");
  writeFileSync(marker, JSON.stringify({ lastSeen: since }));
  for (const [name, reply] of Object.entries(options.replies ?? {}))
    writeFileSync(join(root, name), reply);
  writeFileSync(
    join(root, "responses.json"),
    JSON.stringify({
      merged,
      prs: [
        {
          number: 3,
          title: "Blocked",
          url: "https://github.com/owner/repo/pull/3",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      ],
      lanes: [
        {
          issue: "forge-600",
          runs: [
            {
              start: new Date(Date.now() - 4 * 3600_000).toISOString(),
              end: new Date(Date.now() - 3 * 3600_000).toISOString(),
              verdict: "FAIL",
              role: "tester",
            },
          ],
        },
      ],
      ...options,
    }),
  );
  const fake = join(root, "fake.mjs");
  writeFileSync(
    fake,
    `import {readFileSync,appendFileSync} from 'node:fs';
const [source,...raw]=process.argv.slice(2), a=raw.flatMap(s=>s.startsWith('--')&&s.includes('=')?s.split('='):s), r=JSON.parse(readFileSync('responses.json','utf8'));
appendFileSync('calls.jsonl',JSON.stringify([source,...a])+'\\n');
const out=x=>console.log(JSON.stringify(x));
if(r.fail===source){console.error('source unavailable');process.exit(1)}
if(source==='forge'){out({ok:true,result:{items:r.issues??[{id:'forge-601',title:'New issue',createdAt:${JSON.stringify(mergedAt)}}],truncated:r.truncated??false}})}
else if(a[0]==='auth'){console.log('fake-digest-credential')}
else if(process.env.GH_TOKEN!=='fake-digest-credential'){process.exit(2)}
else if(a[0]==='repo'){out({nameWithOwner:'owner/repo'})}
else if(a[0]==='api'){out([{data:{repository:{pullRequests:{nodes:r.prs,pageInfo:{hasNextPage:false}}}}}])}
else if(a[1]==='checks'&&a.includes('--required')){const check=r.checks?.[a.at(-1)];if(check){if(check.stderr)console.error(check.stderr);if(check.rows)out(check.rows);process.exit(check.status)}out([{name:'Required build',bucket:'fail',link:'https://example.test/check'}]);process.exit(1)}
else if(a[1]==='list'){const window=a[a.indexOf('--search')+1].slice('merged:>='.length);out(r.merged.filter(p=>p.mergedAt>=window))}
else {process.exit(3)}
`,
  );
  writeFileSync(
    join(root, "tools/lane.ts"),
    "import {readFileSync} from 'node:fs'; if(process.argv[2]!=='list') process.exit(1); const r=JSON.parse(readFileSync('responses.json','utf8')); if(r.fail==='lanes') process.exit(1); console.log(JSON.stringify({lanes:r.lanes}));",
  );
  for (const name of ["gh", "forge"]) {
    const shim = join(root, "bin", name);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${fake.replaceAll("\\", "/")}" ${name} "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  const env = {
    ...process.env,
    FORGE_GH_USER: "fixture-user",
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  const pathKey =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const runnerEnv: NodeJS.ProcessEnv = env;
  runnerEnv[pathKey] =
    join(root, "bin") + delimiter + (runnerEnv[pathKey] ?? "");
  return {
    root,
    marker,
    run: (...args: string[]) =>
      spawnSync(process.execPath, [join(root, "tools/digest.ts"), ...args], {
        cwd: root,
        env: runnerEnv,
        encoding: "utf8",
        timeout: 20_000,
      }),
    seen: () =>
      (JSON.parse(readFileSync(marker, "utf8")) as { lastSeen: string })
        .lastSeen,
  };
}
function text(f: ReturnType<typeof fixture>, ...args: string[]) {
  const r = f.run(...args);
  expect(r.stdout).toStartWith("Decisions needed:");
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("—");
  expect(r.stdout + r.stderr).not.toContain("fake-digest-credential");
  return r.stdout;
}
test("digest includes two merges, blockers, stalled lanes and issues, and advances at start", () => {
  const f = fixture(),
    before = Date.now();
  const out = text(f);
  for (const p of merged)
    for (const item of [p.title, p.mergeCommit.oid, p.url])
      expect(out).toContain(item);
  expect(out).toMatch(
    /PR #3[^\n]*Required build[^\n]*\(a\)[^\n]*\[default\][^\n]*\(b\)/,
  );
  expect(out).toMatch(/forge-600[^\n]*tester FAIL[^\n]*\(a\)[^\n]*\[default\]/);
  expect(out).toContain("forge-601 New issue");
  expect(out.indexOf("Merged:")).toBeLessThan(out.indexOf("Blocked:"));
  expect(out.indexOf("Blocked:")).toBeLessThan(out.indexOf("Stalled lanes:"));
  expect(out.indexOf("Stalled lanes:")).toBeLessThan(
    out.indexOf("Issues filed:"),
  );
  expect(Date.parse(f.seen())).toBeGreaterThanOrEqual(before);
  expect(Date.parse(f.seen())).toBeLessThanOrEqual(Date.now());
});
test("second run omits history but retains current blockers; clear state needs no decisions", () => {
  const f = fixture();
  text(f);
  const out = text(f);
  expect(out).not.toContain("Merge 1");
  expect(out).not.toContain("forge-601");
  expect(out).toContain("PR #3");
  const clear = fixture({ prs: [], lanes: [] });
  text(clear);
  expect(text(clear)).toContain("Decisions needed: none");
});
test("peek and since override leave the marker unchanged", () => {
  const f = fixture();
  expect(text(f, "--peek", "--since", new Date().toISOString())).not.toContain(
    "Merge 1",
  );
  expect(f.seen()).toBe(since);
});
test("source failure preserves marker, reports next step and keeps successful sources", () => {
  for (const fail of ["gh", "forge", "lanes"]) {
    const f = fixture({ fail }),
      r = f.run();
    expect(r.stdout).toStartWith("Decisions needed:");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(fail);
    expect(r.stdout).toContain("next:");
    if (fail === "gh") expect(r.stdout).toContain("forge-601");
    expect(f.seen()).toBe(since);
  }
});
test("JSON has text parity and advances the marker", () => {
  const f = fixture(),
    out = text(f, "--peek"),
    r = f.run("--json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout) as {
    merged: { title: string; url: string }[];
    blocked: { number: number }[];
    stalled: { issue: string }[];
    issues: { id: string }[];
    decisions: string[];
  };
  expect(data.merged).toHaveLength(2);
  expect(data.blocked).toHaveLength(1);
  expect(data.stalled).toHaveLength(1);
  expect(data.issues).toHaveLength(1);
  for (const p of data.merged) expect(out).toContain(p.url);
  for (const decision of data.decisions) expect(out).toContain(decision);
  expect(Date.parse(f.seen())).toBeGreaterThan(Date.parse(since));
});

test("complete 1000-issue page succeeds and sends createdSince to forge", () => {
  const issues = Array.from({ length: 1000 }, (_, i) => ({
    id: `issue-${i}`,
    title: `Recent issue ${i}`,
    createdAt: mergedAt,
  }));
  const f = fixture({ issues });
  const r = f.run("--json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout) as { issues: unknown[] };
  expect(data.issues).toHaveLength(1000);
  expect(f.seen()).not.toBe(since);
  const calls = readFileSync(join(f.root, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const call = calls.find((args) => args[0] === "forge")!;
  expect(JSON.parse(call[call.indexOf("--input") + 1]!)).toEqual({
    limit: 1000,
    createdSince: since,
  });
});

test("date-only since sends a normalized timestamp and includes matching issues", () => {
  const issues = [
    { id: "before", title: "Before", createdAt: "2026-01-01T23:59:59Z" },
    { id: "at", title: "At cutoff", createdAt: "2026-01-02T00:00:00Z" },
    { id: "after", title: "After", createdAt: "2026-01-02T01:00:00Z" },
  ];
  const f = fixture({ issues });
  const r = f.run("--since", "2026-01-02", "--peek", "--json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout) as {
    issues: typeof issues;
    errors: unknown[];
  };
  expect(data.issues).toEqual(issues.slice(1));
  expect(data.errors).toEqual([]);
  const calls = readFileSync(join(f.root, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const call = calls.find((args) => args[0] === "forge")!;
  expect(JSON.parse(call[call.indexOf("--input") + 1]!)).toEqual({
    limit: 1000,
    createdSince: "2026-01-02T00:00:00.000Z",
  });
  expect(f.seen()).toBe(since);
});

for (const source of ["issues", "merges"])
  test(`incomplete ${source} retains every row in text and JSON and keeps marker`, () => {
    const fullMerges = Array.from({ length: 1000 }, (_, i) => ({
      ...merged[0]!,
      number: i + 1,
      title: `Capped merge ${i + 1}`,
    }));
    const f = fixture(
      source === "issues" ? { truncated: true } : { merged: fullMerges },
    );
    for (const args of [[], ["--json"]]) {
      const r = f.run(...args);
      expect(r.status).toBe(1);
      expect(f.seen()).toBe(since);
      if (args.length) {
        const data = JSON.parse(r.stdout) as {
          issues: unknown[];
          merged: unknown[];
          errors: { source: string; next: string }[];
        };
        expect(data.issues).toHaveLength(1);
        expect(data.merged).toHaveLength(source === "merges" ? 1000 : 2);
        expect(data.errors).toHaveLength(1);
        expect(data.errors[0]!.source).toBe(
          source === "issues" ? "forge issue list" : "gh merged PRs",
        );
        expect(data.errors[0]!.next).toContain("incomplete");
      } else {
        expect(r.stdout).toContain("forge-601 New issue");
        if (source === "merges")
          for (const row of fullMerges)
            expect(r.stdout).toContain(`PR #${row.number} ${row.title} `);
        expect(r.stdout).toContain("incomplete");
        expect(r.stdout).toContain("next:");
      }
    }
  });

test("text preserves em dashes in merged PR, blocked PR and issue titles", () => {
  const titles = ["Merged — café", "Blocked — review", "Issue — follow-up"];
  const f = fixture({
    merged: merged.map((pr) => ({ ...pr, title: titles[0]! })),
    prs: [
      {
        number: 3,
        title: titles[1],
        url: "https://example.test/3",
        mergeable: "MERGEABLE",
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    ],
    issues: [{ id: "forge-601", title: titles[2]!, createdAt: mergedAt }],
  });
  const plain = f.run("--peek"),
    json = f.run("--peek", "--json");
  expect(plain.status).toBe(0);
  expect(json.status).toBe(0);
  const data = JSON.parse(json.stdout) as {
    merged: { title: string }[];
    blocked: { title: string }[];
    issues: { title: string }[];
  };
  expect([
    data.merged[0]?.title,
    data.blocked[0]?.title,
    data.issues[0]?.title,
  ]).toEqual(titles);
  for (const row of [...data.merged, ...data.blocked, ...data.issues])
    expect(plain.stdout).toContain(row.title);
  let generated = plain.stdout;
  for (const title of titles) generated = generated.replaceAll(title, "");
  expect(generated).not.toContain("—");
});

test("only the latest run determines lane activity and the stall clock", () => {
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3600_000).toISOString();
  const interrupted = {
    start: ago(10),
    end: null,
    role: "fixer",
    verdict: "interrupted",
  };
  const completed = {
    start: ago(4),
    end: ago(3),
    role: "tester",
    verdict: "PASS",
  };
  const f = fixture({
    lanes: [
      { issue: "old-interrupted", runs: [interrupted, completed] },
      { issue: "reverse-order", runs: [completed, interrupted] },
      {
        issue: "stale-state",
        state: "running",
        since: ago(0.5),
        runs: [interrupted, completed],
      },
      {
        issue: "recent-state",
        state: "idle",
        since: ago(0.5),
        runs: [completed],
      },
      {
        issue: "latest-active",
        runs: [completed, { ...interrupted, start: ago(1) }],
      },
      {
        issue: "latest-recent",
        runs: [completed, { ...completed, start: ago(1), end: ago(0.5) }],
      },
    ],
  });
  const r = f.run("--peek", "--json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout) as {
    stalled: { issue: string; idleHours: number; reason: string }[];
  };
  expect(data.stalled.map((lane) => lane.issue)).toEqual([
    "old-interrupted",
    "reverse-order",
    "stale-state",
    "recent-state",
  ]);
  for (const lane of data.stalled) {
    expect(lane.idleHours).toBeGreaterThanOrEqual(3);
    expect(lane.idleHours).toBeLessThan(3.1);
    expect(lane.reason).toBe("idle 3 h after tester PASS");
  }
});
test("all blocker reasons, running lanes, state fields and incomplete sources", () => {
  const f = fixture({
    prs: [
      {
        number: 4,
        title: "Needs review",
        url: "https://example.test/4",
        mergeable: "CONFLICTING",
        mergeStateStatus: "BEHIND",
        reviewDecision: "CHANGES_REQUESTED",
        reviewThreads: {
          nodes: [{ isResolved: false }],
          pageInfo: { hasNextPage: false },
        },
      },
    ],
    lanes: [
      { issue: "running", runs: [{ start: mergedAt, end: null }] },
      {
        issue: "state-idle",
        state: "idle",
        since: new Date(Date.now() - 5 * 3600_000).toISOString(),
        runs: [],
      },
    ],
  });
  const out = text(f, "--peek");
  for (const reason of [
    "conflicts",
    "changes requested",
    "unresolved",
    "old base",
    "state-idle",
  ])
    expect(out).toContain(reason);
  expect(out).not.toContain("lane running");
  const truncated = fixture({ truncated: true }),
    r = truncated.run();
  expect(r.status).toBe(1);
  expect(truncated.seen()).toBe(since);
});

test("no reported checks are pending while no required checks is a successful empty result", () => {
  const f = fixture({
    checks: {
      "3": { status: 1, stderr: "no checks reported on the feature branch" },
    },
  });
  const r = f.run("--json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout) as {
    errors: unknown[];
    blocked: [{ number: number; reasons: string[] }];
  };
  expect(data.errors).toEqual([]);
  expect(data.blocked[0].number).toBe(3);
  expect(data.blocked[0].reasons).toContain("checks pending");
  expect(f.seen()).not.toBe(since);
  const noRequired = fixture({
    checks: {
      "3": {
        status: 1,
        stderr: "no required checks reported on the feature branch",
      },
    },
    lanes: [],
  });
  expect(text(noRequired)).toContain("Decisions needed: none");
});

test("stalled lanes show the first tester or reviewer reply verdict with process fallback", () => {
  const lanes = ["tester", "reviewer", "no-verdict", "missing-reply"].map(
    (name) => ({
      issue: name === "tester" ? "forge-600" : name,
      runs: [
        {
          start: new Date(Date.now() - 4 * 3600_000).toISOString(),
          end: new Date(Date.now() - 3 * 3600_000).toISOString(),
          role: name === "reviewer" ? "reviewer" : "tester",
          verdict: "completed",
          reply: `${name}.md`,
        },
      ],
    }),
  );
  const f = fixture({
    lanes,
    replies: {
      "tester.md": "Report\r\nVerdict: FAIL\r\nVerdict: PASS\r\n",
      "reviewer.md": "Verdict: FAIL: checks are red\nVerdict: PASS\n",
      "no-verdict.md": "The process finished without a verdict.\n",
    },
  });
  const out = text(f, "--peek");
  expect(out).toContain(
    "lane forge-600 idle 3 h after tester Verdict: FAIL: (a) run the fixer [default] (b) park",
  );
  expect(out).toContain("after reviewer Verdict: FAIL: checks are red");
  expect(out).not.toContain("Verdict: PASS");
  expect(out).toContain("lane no-verdict idle 3 h after tester completed");
  expect(out).toContain("lane missing-reply idle 3 h after tester completed");
  const r = f.run("--peek", "--json"),
    data = JSON.parse(r.stdout) as {
      errors: unknown[];
      stalled: { reason: string }[];
    };
  expect(r.status).toBe(0);
  expect(data.errors).toEqual([]);
  expect(data.stalled).toHaveLength(4);
  for (const lane of data.stalled) expect(out).toContain(lane.reason);
});

test("one PR check read failure keeps blockers before and after it and names the failed PR", () => {
  const f = fixture({
    prs: [3, 4, 5].map((number) => ({
      number,
      title: `Open ${number}`,
      url: `https://example.test/pr/${number}`,
      mergeable: "MERGEABLE",
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    })),
    checks: { "4": { status: 1, stderr: "HTTP 502: could not read checks" } },
  });
  const r = f.run("--json"),
    data = JSON.parse(r.stdout) as {
      blocked: { number: number }[];
      errors: [{ source: string; next: string }];
      merged: unknown[];
      issues: unknown[];
    };
  expect(r.status).toBe(1);
  expect(data.blocked.map((pr: { number: number }) => pr.number)).toEqual([
    3, 5,
  ]);
  expect(data.errors).toHaveLength(1);
  expect(data.errors[0].source).toBe("gh PR #4");
  expect(data.errors[0].next).toContain("--peek");
  expect(data.merged).toHaveLength(2);
  expect(data.issues).toHaveLength(1);
  expect(f.seen()).toBe(since);
});

test("stall threshold accepts finite nonnegative values and rejects invalid values with usage exit 2", () => {
  const f = fixture({ prs: [] });
  for (const value of [
    "",
    " ",
    "Infinity",
    "-Infinity",
    "NaN",
    "-1",
    "invalid",
  ])
    for (const format of [[], ["--json"]]) {
      const r = f.run("--stall-hours", value, ...format);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("Usage: bun tools/digest.ts");
      expect(r.stdout).toContain("--stall-hours");
      if (format.length) {
        const data = JSON.parse(r.stdout) as {
          errors: [{ source: string }];
        };
        expect(data.errors[0].source).toBe("configuration");
      }
      expect(f.seen()).toBe(since);
    }
  const missing = f.run("--stall-hours");
  expect(missing.status).toBe(2);
  expect(missing.stdout).toContain("Usage: bun tools/digest.ts");
  for (const args of [["--unknown"], ["--since"], ["--since", "invalid"]])
    expect(f.run(...args).status).toBe(1);
  expect(f.seen()).toBe(since);
  expect(text(f, "--stall-hours", "0", "--peek")).toContain("lane forge-600");
  expect(text(f, "--stall-hours", "3.5", "--peek")).not.toContain(
    "lane forge-600",
  );
});
