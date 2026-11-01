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
    lanes?: unknown[];
    truncated?: boolean;
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
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  git("init");
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  const marker = join(root, ".git/forge-digest.json");
  writeFileSync(marker, JSON.stringify({ lastSeen: since }));
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
if(source==='forge'){out({ok:true,result:{items:[{id:'forge-601',title:'New issue',createdAt:${JSON.stringify(mergedAt)}}],truncated:r.truncated??false}})}
else if(a[0]==='auth'){console.log('fake-digest-credential')}
else if(process.env.GH_TOKEN!=='fake-digest-credential'){process.exit(2)}
else if(a[0]==='repo'){out({nameWithOwner:'owner/repo'})}
else if(a[0]==='api'){out([{data:{repository:{pullRequests:{nodes:r.prs,pageInfo:{hasNextPage:false}}}}}])}
else if(a[1]==='checks'&&a.includes('--required')){out([{name:'Required build',bucket:'fail',link:'https://example.test/check'}]);process.exit(1)}
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
