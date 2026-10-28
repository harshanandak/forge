// [integration] Real git worktrees and subprocesses; Forge and Codex are PATH fixtures.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

setDefaultTimeout(60_000);
const script = resolve(import.meta.dirname, "../../tools/lane.ts");
const runner = resolve(import.meta.dirname, "../../tools/lane-run.ts");
const template = resolve(import.meta.dirname, "../../tools/lane-brief.md");
const sections = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
type Verdict = {
  verdict: string;
  role: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  session: string | null;
  reply: string | null;
  log: string | null;
  folder: string | null;
  exit: number | null;
  next: string;
  retries: number;
  stoppedAfterReply: boolean;
  worktree?: string;
};
type Attempt = { args: string[]; cwd: string; prompt: string };
function fixture() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-lane-run-")),
  );
  roots.push(root);
  const main = join(root, "main"),
    caller = join(root, "caller"),
    bin = join(root, "bin");
  mkdirSync(main);
  mkdirSync(bin);
  writeFileSync(
    join(main, "package.json"),
    '{"name":"lane-run-fixture","private":true}',
  );
  writeFileSync(join(main, ".gitignore"), ".worktrees/\n");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE)$/i.test(
        key,
      ),
    ),
  );
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
  env.FORGE_DEVICE_ROOT = join(root, "device");
  env.LANE_FIXTURE = root;
  const forge = join(root, "fake-forge.mjs"),
    codex = join(root, "fake-codex.mjs");
  writeFileSync(
    forge,
    `const args=process.argv.slice(2);const input=JSON.parse(args[args.indexOf('--input')+1]);console.log(JSON.stringify({ok:true,result:{id:input.id,title:'Fixture issue title',body:'Fixture issue body: implement the requested lane.'}}));`,
  );
  writeFileSync(
    codex,
    String.raw`import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const root=process.env.LANE_FIXTURE,args=process.argv.slice(2),file=join(root,'attempts.jsonl');
const prompt=readFileSync(0,'utf8');const count=existsSync(file)?readFileSync(file,'utf8').trim().split('\n').length:0;
appendFileSync(file,JSON.stringify({args,cwd:process.cwd(),prompt})+'\n');
const mode=readFileSync(join(root,'mode'),'utf8');
if(mode==='capacity'||mode==='limit')console.log('session id: fake-session');else console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'}));
if(mode==='limit'||(mode==='capacity'&&count===0)){console.log('Selected model is at capacity');process.exit(1)}
const flag=args.findIndex(a=>a==='--output-last-message'||a==='-o');if(flag<0)process.exit(8);
writeFileSync(args[flag+1],'Fixture final reply.');
if(mode==='hang'){setInterval(()=>{},1000)}else process.exit(0);`,
  );
  writeFileSync(join(root, "mode"), "ok");
  for (const [name, file] of [
    ["forge", forge],
    ["codex", codex],
  ]) {
    const shim = join(bin, name!);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec node "${file!.replaceAll("\\", "/")}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  function git(args: string[], cwd = main) {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }
  git(["init", "--initial-branch=main"]);
  git(["add", "package.json", ".gitignore"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  git(["init", "--bare", "--initial-branch=main", join(root, "remote.git")]);
  git(["remote", "add", "origin", join(root, "remote.git")]);
  git(["push", "origin", "main"]);
  git(["fetch", "origin", "main"]);
  git(["worktree", "add", "--detach", caller, "origin/main"]);
  const config = join(caller, ".forge", "config.yaml");
  mkdirSync(join(caller, ".forge"));
  function roles(model = "gpt-6.1-sol", harness = "codex") {
    writeFileSync(
      config,
      `values:\n  lanes:\n    roles:\n      builder:\n        harness: ${harness}\n        model: ${model}\n        effort: high\n`,
    );
  }
  roles();
  const brief = join(root, "brief.md");
  writeFileSync(
    brief,
    sections
      .map(
        (section) =>
          `## ${section}\nConcrete ${section.toLowerCase()} evidence.\n`,
      )
      .join("\n"),
  );
  function run(args: string[], cwd = caller) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return {
      code: result.status,
      output: JSON.parse(result.stdout) as Verdict,
      stderr: result.stderr,
    };
  }
  function start() {
    const result = run([
      "start",
      "one",
      "--branch",
      "lane/one",
      "--brief",
      brief,
    ]);
    expect(result.code).toBe(0);
    return result.output.worktree!;
  }
  const attempts = () =>
    existsSync(join(root, "attempts.jsonl"))
      ? readFileSync(join(root, "attempts.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Attempt)
      : [];
  function direct(worktree: string, mode: string, resume?: string) {
    writeFileSync(join(root, "mode"), mode);
    const folder = join(root, "direct-output");
    mkdirSync(folder);
    const helper = join(root, "direct.ts");
    writeFileSync(
      helper,
      `import {runCodex} from ${JSON.stringify(runner)};const result=await runCodex(${JSON.stringify({ worktree, folder, model: "gpt-6.1-sol", effort: "high", prompt: "Direct fixture prompt", ...(resume ? { resume } : {}) })},{replyGraceMs:100,pollMs:10,retryDelayMs:1});console.log(JSON.stringify(result));`,
    );
    const result = spawnSync(process.execPath, [helper], {
      cwd: caller,
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as Pick<
      Verdict,
      "session" | "reply" | "log" | "exit" | "retries" | "stoppedAfterReply"
    >;
  }
  return {
    root,
    main,
    caller,
    config,
    brief,
    roles,
    run,
    start,
    attempts,
    direct,
  };
}
function expectModel(attempt: Attempt, model: string) {
  const modelFlag = attempt.args.findIndex(
    (arg) => arg === "--model" || arg === "-m",
  );
  expect(attempt.args[modelFlag + 1]).toBe(model);
  expect(attempt.args.join(" ")).toMatch(/model_reasoning_effort[^ ]*high/);
}

test("run uses the caller role table, lane cwd, complete prompt, and typed verdict", () => {
  const f = fixture(),
    lane = f.start();
  const nested = join(f.caller, "nested");
  mkdirSync(nested);
  const result = f.run(["run", "one", "--role", "builder"], nested);
  expect(result.code).toBe(0);
  expect(result.output.verdict).toBe("completed");
  expect(Object.keys(result.output).sort()).toEqual([
    "effort",
    "exit",
    "folder",
    "harness",
    "log",
    "model",
    "next",
    "reply",
    "retries",
    "role",
    "session",
    "stoppedAfterReply",
    "verdict",
  ]);
  expect(result.output).toMatchObject({
    role: "builder",
    harness: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    session: "fake-session",
    exit: 0,
    retries: 0,
    stoppedAfterReply: false,
  });
  expect(f.attempts()).toHaveLength(1);
  const attempt = f.attempts()[0]!;
  expectModel(attempt, "gpt-6.1-sol");
  expect(attempt.cwd).toBe(lane);
  const replyFlag = attempt.args.findIndex(
    (arg) => arg === "--output-last-message" || arg === "-o",
  );
  expect(attempt.args[replyFlag + 1]).toBe(result.output.reply!);
  expect(readFileSync(result.output.reply!, "utf8")).toBe(
    "Fixture final reply.",
  );
  expect(result.output.reply).toBe(join(result.output.folder!, "reply.md"));
  expect(result.output.log).toBe(join(result.output.folder!, "log.txt"));
  for (const file of ["log.txt", "start.txt", "end.txt"])
    expect(existsSync(join(result.output.folder!, file))).toBe(true);
  const prompt = readFileSync(join(result.output.folder!, "brief.md"), "utf8");
  expect(attempt.prompt).toBe(prompt);
  expect(prompt).toContain("Fixture issue title");
  expect(prompt).toContain("Fixture issue body");
  for (const section of sections) expect(prompt).toContain(`## ${section}`);
  const rules = readFileSync(template, "utf8").trim();
  expect(prompt).toContain(rules);
  for (const text of [rules, readFileSync(f.brief, "utf8")])
    expect(text).not.toMatch(/[A-Z]:[\\/]|\/Users\/|\/home\//);
});

test("a changed caller role model changes the launched Codex model", () => {
  const f = fixture();
  f.start();
  f.roles("fixture-other-model");
  const result = f.run(["run", "one", "--role", "builder"]);
  expect(result.code).toBe(0);
  expect(result.output.model).toBe("fixture-other-model");
  expectModel(f.attempts()[0]!, "fixture-other-model");
});

for (const reason of ["unknown role", "missing table", "unsupported harness"])
  test(`${reason} refuses with a typed verdict before launching Codex`, () => {
    const f = fixture();
    f.start();
    if (reason === "missing table") writeFileSync(f.config, "values: {}\n");
    if (reason === "unsupported harness")
      f.roles("gpt-6.1-sol", "unavailable-harness");
    const result = f.run([
      "run",
      "one",
      "--role",
      reason === "unknown role" ? "reviewer" : "builder",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.output.verdict).toBe("refused");
    for (const key of [
      "role",
      "harness",
      "model",
      "effort",
      "session",
      "reply",
      "log",
      "folder",
      "exit",
      "next",
      "retries",
      "stoppedAfterReply",
    ])
      expect(Object.hasOwn(result.output, key)).toBe(true);
    expect(result.output.next.length).toBeGreaterThan(0);
    expect(f.attempts()).toEqual([]);
  });

test("custom prompt is persisted and passed to an explicit resumed session", () => {
  const f = fixture();
  f.start();
  const custom = join(f.root, "custom.md");
  writeFileSync(custom, "A custom continuation prompt.\n");
  const result = f.run([
    "run",
    "one",
    "--role",
    "builder",
    "--prompt",
    custom,
    "--resume",
    "prior-session",
  ]);
  expect(result.code).toBe(0);
  const attempt = f.attempts()[0]!;
  expect(attempt.args).toContain("resume");
  expect(attempt.args).toContain("prior-session");
  expect(attempt.prompt).toBe("A custom continuation prompt.\n");
  expect(readFileSync(join(result.output.folder!, "brief.md"), "utf8")).toBe(
    attempt.prompt,
  );
});

test("capacity retry resumes the same session at default tier", () => {
  const f = fixture(),
    lane = f.start();
  const result = f.direct(lane, "capacity");
  expect(result).toMatchObject({
    session: "fake-session",
    exit: 0,
    retries: 1,
    stoppedAfterReply: false,
  });
  expect(f.attempts()).toHaveLength(2);
  const retry = f.attempts()[1]!;
  expect(retry.args).toContain("resume");
  expect(retry.args).toContain("fake-session");
  expectModel(retry, "gpt-6.1-sol");
  expect(retry.args.join(" ")).toMatch(/service_tier[^ ]*default/);
  expect(readFileSync(result.reply!, "utf8")).toBe("Fixture final reply.");
});

test("capacity retries stop after three retries and retain failure evidence", () => {
  const f = fixture(),
    lane = f.start();
  const result = f.direct(lane, "limit");
  expect(result).toMatchObject({
    session: "fake-session",
    exit: 1,
    retries: 3,
    stoppedAfterReply: false,
  });
  expect(f.attempts()).toHaveLength(4);
  for (const attempt of f.attempts().slice(1)) {
    expect(attempt.args).toContain("resume");
    expect(attempt.args).toContain("fake-session");
  }
  expect(readFileSync(result.log!, "utf8")).toContain(
    "Selected model is at capacity",
  );
});

test("reply guard stops a lingering child after a reply and preserves the reply", () => {
  const f = fixture(),
    lane = f.start(),
    before = Date.now();
  const result = f.direct(lane, "hang");
  expect(Date.now() - before).toBeLessThan(10_000);
  expect(result.stoppedAfterReply).toBe(true);
  expect(result.retries).toBe(0);
  expect(readFileSync(result.reply!, "utf8")).toBe("Fixture final reply.");
  expect(f.attempts()).toHaveLength(1);
});
