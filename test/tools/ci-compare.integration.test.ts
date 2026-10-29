// [integration] Real CLI and git; fake gh on PATH serves recorded responses, without network.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
type Output = {
  comparisons: { verdict: string; next: string; reason?: string }[];
  cancelled: unknown[];
};
const job = (name: string, conclusion = "failure", step = "Unit tests") => ({
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
function fixture(
  options: {
    checks?: unknown[];
    mainJobs?: unknown[];
    current?: boolean;
    error?: string;
    authError?: boolean;
    noRuns?: boolean;
    prStep?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-ci-compare-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "package.json"), '{"private":true}');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_GH_USER: "fixture-user",
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: root,
      env,
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
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  git("remote", "add", "origin", "git@github.com:owner/repo.git");
  writeFileSync(
    join(root, "responses.json"),
    JSON.stringify({
      ...options,
      sha,
      checks: options.checks ?? [check()],
      mainJobs: options.mainJobs ?? [job("Linux")],
    }),
  );
  const fake = join(root, "gh.mjs");
  writeFileSync(
    fake,
    `import {readFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2), r=JSON.parse(readFileSync('responses.json','utf8'));
appendFileSync('calls.jsonl',JSON.stringify(a)+'\\n');
const out=x=>console.log(JSON.stringify(x));
if(a[0]==='auth'&&a[1]==='token'&&a[2]==='--user'&&a[3]==='fixture-user') {
  if(r.authError){console.error('authentication failed');process.exit(1)}
  console.log('fixture-credential');
} else if(process.env.GH_TOKEN!=='fixture-credential'){console.error('missing configured token');process.exit(1)}
else if(a[0]==='pr'&&a[1]==='view') {
  if(r.error){console.error(r.error+' fixture-credential');process.exit(1)}
  out({headRefOid:'pr-head',statusCheckRollup:r.checks});
} else if(a[0]==='run'&&a[1]==='view'&&a[2]==='10') out({workflowDatabaseId:7,jobs:[${JSON.stringify(job("Linux"))},${JSON.stringify(job("Windows"))}].map(j=>({...j,steps:j.steps.map(s=>s.conclusion==='failure'?{...s,name:r.prStep??s.name}:s)}))});
else if(a[0]==='run'&&a[1]==='list'&&a.includes('--workflow')&&a[a.indexOf('--workflow')+1]==='7'&&a.includes('--branch')&&a[a.indexOf('--branch')+1]==='main'&&a.includes('--status')&&a[a.indexOf('--status')+1]==='completed') out(r.noRuns||(!r.current&&a.includes('--commit'))?[]:[{databaseId:20,headSha:r.current?r.sha:'older-main'}]);
else if(a[0]==='run'&&a[1]==='view'&&a[2]==='20') out({jobs:r.mainJobs});
else {console.error('unexpected read command '+JSON.stringify(a));process.exit(1)}
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath.replaceAll("\\", "/")}\nimport ${JSON.stringify(fake.replaceAll("\\", "/"))};\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  if (process.platform === "win32") {
    const compiled = spawnSync(
      process.execPath,
      ["build", fake, "--compile", "--outfile", join(bin, "gh.exe")],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
  }
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
  const f = fixture({ mainJobs: [job("Linux", "success")] }),
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
