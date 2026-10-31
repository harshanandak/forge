// [integration] Real CLI and git; fake gh on PATH serves recorded responses, without network.
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
const script = resolve(import.meta.dirname, "../../tools/ci-compare.ts");
const shared = mkdtempSync(join(tmpdir(), "forge-ci-compare-shared-"));
const bin = join(shared, "bin"),
  seed = join(shared, "repo");
afterAll(() => rmSync(shared, { recursive: true, force: true }));
let sha: string;
type Output = {
  comparisons: { verdict: string; next: string; reason?: string }[];
  cancelled: unknown[];
};
const job = (name: string, conclusion = "failure", step = "Unit tests") => ({
  databaseId: 11,
  name,
  conclusion,
  url: `https://github.com/owner/repo/actions/runs/10/job/11`,
  steps: [
    { name: "Setup", conclusion: "success" },
    { name: step, conclusion },
  ],
});
const check = (name = "Linux", conclusion = "FAILURE") => ({
  name,
  conclusion,
  detailsUrl: "https://github.com/owner/repo/actions/runs/10/job/11",
});
beforeAll(() => {
  mkdirSync(bin);
  mkdirSync(seed);
  writeFileSync(join(seed, "package.json"), '{"private":true}');
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: seed,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("add", "package.json");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  );
  sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  git("remote", "add", "origin", "git@github.com:owner/repo.git");
  const fake = join(shared, "gh.mjs");
  writeFileSync(
    fake,
    `import {readFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2).flatMap(s=>s.startsWith('--')&&s.includes('=')?s.split('='):s), r=JSON.parse(readFileSync('responses.json','utf8'));
appendFileSync('calls.jsonl',JSON.stringify(a)+'\\n');
const out=x=>console.log(JSON.stringify(x));
if(r.enforceHost&&(process.env.GH_HOST!=='github.com'||(a[0]==='auth'&&a[a.indexOf('--hostname')+1]!=='github.com'))){console.error('wrong auth or request host');process.exit(1)}
if(a[0]==='auth'&&a[1]==='token'&&a[2]==='--user'&&a[3]==='fixture-user') {
  if(r.authError){console.error('authentication failed');process.exit(1)}
  console.log('fixture-credential');
} else if(process.env.GH_TOKEN!=='fixture-credential'){console.error('missing configured token');process.exit(1)}
else if(a[0]==='pr'&&a[1]==='view') {
  if(r.error){console.error(r.error+' fixture-credential');process.exit(1)}
  out({headRefOid:'pr-head',statusCheckRollup:r.checks});
} else if(a[0]==='run'&&a[1]==='view'&&a[2]==='10') out({workflowDatabaseId:7,jobs:r.prJobs.map(j=>({...j,steps:j.steps.map(s=>s.conclusion==='failure'?{...s,name:r.prStep??s.name}:s)}))});
else if(a[0]==='run'&&a[1]==='list'&&a.includes('--workflow')&&a[a.indexOf('--workflow')+1]==='7'&&a.includes('--branch')&&a[a.indexOf('--branch')+1]==='main'&&a.includes('--status')&&a[a.indexOf('--status')+1]==='completed') out(r.noRuns||(!r.current&&a.includes('--commit'))?[]:[{databaseId:20,headSha:r.current?r.sha:'older-main'}]);
else if(a[0]==='run'&&a[1]==='view'&&a[2]==='20') out({jobs:r.mainJobs});
else {console.error('unexpected read command '+JSON.stringify(a));process.exit(1)}
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${fake.replaceAll("\\", "/")}" "$@"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  if (process.platform === "win32")
    writeFileSync(
      join(bin, "gh.cmd"),
      `@"${process.execPath}" "${fake}" %*\r\n`,
    );
});
function fixture(
  options: {
    checks?: unknown[];
    mainJobs?: unknown[];
    current?: boolean;
    error?: string;
    authError?: boolean;
    noRuns?: boolean;
    prStep?: string;
    prJobs?: unknown[];
    noMain?: boolean;
    ghHost?: string;
    enforceHost?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-ci-compare-"));
  roots.push(root);
  cpSync(seed, root, { recursive: true });
  if (options.noMain) rmSync(join(root, ".git/refs/remotes/origin/main"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_GH_USER: "fixture-user",
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  if (options.ghHost) env.GH_HOST = options.ghHost;
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
  writeFileSync(
    join(root, "responses.json"),
    JSON.stringify({
      current: true,
      ...options,
      sha,
      checks: options.checks ?? [check()],
      mainJobs: options.mainJobs ?? [job("Linux")],
      prJobs: options.prJobs ?? [
        job("Linux"),
        { ...job("Windows"), databaseId: 12 },
      ],
    }),
  );
  return {
    run: (args = ["42"]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15_000,
      }),
    calls: () =>
      readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s) as string[]),
    sha,
  };
}
function output(f: ReturnType<typeof fixture>) {
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("fixture-credential");
  return JSON.parse(result.stdout) as Output;
}
test("same workflow on current main failed at the same step", () => {
  const f = fixture({ current: true }),
    r = output(f);
  expect(r.comparisons[0]).toMatchObject({
    name: "Linux",
    verdict: "main-fails-same-step",
    pr: { conclusion: "failure", failedStep: "Unit tests" },
    main: {
      runId: 20,
      headSha: f.sha,
      conclusion: "failure",
      failedStep: "Unit tests",
    },
  });
  expect(r.comparisons[0]!.next).toContain("do not retry");
  expect(f.calls().filter((a) => a[1] === "list")).toHaveLength(1);
});
test("main passing reports PR-only and names the failed step; falls back to latest completed main", () => {
  const f = fixture({ current: false, mainJobs: [job("Linux", "success")] }),
    r = output(f);
  expect(r.comparisons[0]).toMatchObject({
    verdict: "pr-only",
    pr: { failedStep: "Unit tests" },
    main: { headSha: "older-main" },
  });
  expect(r.comparisons[0]!.next).toContain("named flake issue");
  expect(f.calls().filter((a) => a[1] === "list")).toHaveLength(2);
});
test("missing main job is unknown; cancelled is listed without comparison", () => {
  const r = output(
    fixture({
      checks: [check(), check("Cancelled", "CANCELLED")],
      mainJobs: [job("Other")],
    }),
  );
  expect(r.comparisons).toHaveLength(1);
  expect(r.comparisons[0]).toMatchObject({
    verdict: "main-unknown",
  });
  expect(r.comparisons[0]!.reason).toContain("same-named job");
  expect(r.cancelled).toEqual([
    { name: "Cancelled", conclusion: "cancelled", url: check().detailsUrl },
  ]);
});
test("no failed checks succeeds without looking up main runs", () => {
  const f = fixture({ checks: [check("Linux", "SUCCESS")] }),
    r = output(f);
  expect(r.comparisons).toEqual([]);
  expect(f.calls().some((a) => a[0] === "run")).toBe(false);
});
test("gh PR and auth errors return one JSON object, nonzero, and no credential", () => {
  for (const options of [
    { error: "Could not resolve PullRequest" },
    { authError: true },
  ]) {
    const r = fixture(options).run();
    expect(r.status).toBe(1);
    expect((JSON.parse(r.stdout) as { error: string }).error).toContain(
      options.error ?? "authentication failed",
    );
    expect(r.stdout + r.stderr).not.toContain("fixture-credential");
  }
});
test("other failed step and timed-out checks are compared", () => {
  const r = output(
    fixture({
      checks: [check("Linux", "TIMED_OUT")],
      mainJobs: [job("Linux", "failure", "Build")],
    }),
  );
  expect(r.comparisons[0]!.verdict).toBe("main-fails-other-step");
  expect(r.comparisons[0]!.next).toContain("both logs");
});
test("absent main run or failed step gives an explicit unknown reason", () => {
  for (const options of [
    { noRuns: true },
    { mainJobs: [job("Linux", "failure", "")] },
  ]) {
    const r = output(fixture(options));
    expect(r.comparisons[0]!.verdict).toBe("main-unknown");
    expect(r.comparisons[0]!.reason!.length).toBeGreaterThan(5);
  }
});

test("duplicate PR job names use the check URL's job id", () => {
  const r = output(
    fixture({
      checks: [
        {
          ...check(),
          detailsUrl: check().detailsUrl.replace("/job/11", "/job/12"),
        },
      ],
      prJobs: [
        job("Linux"),
        { ...job("Linux", "failure", "Lint"), databaseId: 12 },
      ],
    }),
  );
  expect(r.comparisons[0]).toMatchObject({
    verdict: "main-fails-other-step",
    pr: { failedStep: "Lint" },
  });
  expect(r.comparisons[0]!.next).toContain("both logs");
});

test("unidentifiable PR job is unknown instead of guessing by name", () => {
  for (const detailsUrl of [
    check().detailsUrl.replace("/job/11", ""),
    check().detailsUrl.replace("/job/11", "/job/99"),
  ]) {
    const r = output(fixture({ checks: [{ ...check(), detailsUrl }] }));
    expect(r.comparisons[0]).toMatchObject({
      verdict: "main-unknown",
      pr: { failedStep: null },
    });
    expect(r.comparisons[0]!.reason).toContain("PR job");
  }
});

test("origin host overrides inherited GH_HOST for auth and every request", () => {
  const f = fixture({ ghHost: "example.invalid", enforceHost: true });
  expect(output(f).comparisons[0]!.verdict).toBe("main-fails-same-step");
  expect(f.calls()[0]).toEqual([
    "auth",
    "token",
    "--user",
    "fixture-user",
    "--hostname",
    "github.com",
  ]);
});

test("no failed checks and no origin/main returns an empty result", () => {
  const f = fixture({ checks: [], noMain: true });
  expect(output(f).comparisons).toEqual([]);
  expect(f.calls().some((a) => a[0] === "run")).toBe(false);
});

test("failed check without origin/main preserves the PR failed step and gives an unknown reason", () => {
  const r = output(fixture({ noMain: true }));
  expect(r.comparisons[0]).toMatchObject({
    pr: { failedStep: "Unit tests" },
  });
  expect(r.comparisons[0]!.verdict).toBe("main-unknown");
  expect(r.comparisons[0]!.reason).toContain("origin/main");
});

test("success output redacts the fake token in a failed step name", () => {
  const r = output(fixture({ prStep: "step fixture-credential" }));
  expect(r.comparisons[0]).toMatchObject({
    pr: { failedStep: "step [redacted]" },
  });
});
