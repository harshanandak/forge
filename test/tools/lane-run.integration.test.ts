// [integration] Real git worktrees and subprocesses; Forge and Codex are PATH fixtures.
import { afterAll, afterEach, expect, setDefaultTimeout } from "bun:test";
import { test as runTest } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

import { laneRun, runClaude, runCodex } from "../../tools/lane-run.ts";
import { scriptFixture } from "../script-fixture.ts";
import { cliTopologyFixture } from "./cli-topology-fixture.ts";
import { RepositoryFixtures } from "./lane-fixture.ts";
import { FixtureChildren } from "../fixture-children.ts";

setDefaultTimeout(60_000);
const repositories = new RepositoryFixtures<boolean>();
const script = resolve(import.meta.dirname, "../../tools/lane.ts");
const template = resolve(import.meta.dirname, "../../tools/lane-brief.md");
const tiers = `    tiers:
      security: ["src/core/trust/**", "src/core/state/**", "src/adapters/store-sqlite/**", "src/adapters/fs/**", "src/adapters/process/**", "templates/delivery/harness/**", ".github/workflows/**", "package.json", "bun.lock", "migrations/**"]
      code: ["src/**", "tools/**", "templates/**", "bin/**", "schemas/**"]
`;
const sections = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
];
const roots: string[] = [];
const children = new FixtureChildren();
let childLaunches = 0;
let avoidedIssueChildren = 0;
const caseNames: string[] = [];
type Case = [name: string, body: () => void | Promise<void>];
function register(run: (...args: Case) => unknown) {
  return (...args: Case) => {
    caseNames.push(args[0]);
    run(...args);
  };
}
const test = Object.assign(register(runTest), {
  skipIf: (condition: boolean) => register(runTest.skipIf(condition)),
});
async function withEnvironment<T>(
  env: NodeJS.ProcessEnv,
  task: () => Promise<T>,
) {
  const before = childLaunches;
  const prior = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const result = await task();
    expect(childLaunches - before).toBe(0);
    return result;
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
afterEach(async () => {
  await children.cleanup(() => {
    for (const root of roots.splice(0)) {
      const calls = join(root, "issue-calls");
      if (existsSync(calls))
        avoidedIssueChildren += readFileSync(calls, "utf8")
          .trim()
          .split("\n").length;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
afterAll(() => {
  console.info(
    `lane-run fixture: avoided ${avoidedIssueChildren} issue CLI children`,
  );
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
  tier?: string;
  because?: string;
  reviews?: string[];
};
type Attempt = { args: string[]; cwd: string; prompt: string };
function fixture(trustedPolicy = `values:\n  lanes:\n${tiers}`) {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-lane-run-")),
  );
  roots.push(root);
  const main = join(root, "main"),
    caller = join(root, "caller"),
    bin = join(root, "bin");
  const cached = repositories.restore(trustedPolicy, root);
  if (!cached) {
    mkdirSync(main);
    writeFileSync(
      join(main, "package.json"),
      '{"name":"lane-run-fixture","private":true}',
    );
    writeFileSync(join(main, ".gitignore"), ".worktrees/\n");
    mkdirSync(join(main, ".forge"));
    writeFileSync(join(main, ".forge", "config.yaml"), trustedPolicy);
  }
  mkdirSync(bin);
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
    // The test polls this log while the child writes; publish complete JSON lines.
    String.raw`import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.env.LANE_FIXTURE,args=process.argv.slice(2),file=join(root,'attempts.jsonl');
const prompt=readFileSync(0,'utf8');const count=existsSync(file)?readFileSync(file,'utf8').trim().split('\n').length:0;
const pending=file+'.'+process.pid+'.tmp';writeFileSync(pending,(existsSync(file)?readFileSync(file,'utf8'):'')+JSON.stringify({args,cwd:process.cwd(),prompt})+'\n');renameSync(pending,file);
const mode=readFileSync(join(root,'mode'),'utf8');
writeFileSync(join(root,'harness-pid'),String(process.pid));
if(mode==='capacity'||mode==='limit')console.log('session id: fake-session');else console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'}));
if(mode==='limit'||(mode==='capacity'&&count===0)){console.log('Selected model is at capacity');process.exit(1)}
if(mode==='auto-slow')while(!existsSync(join(root,'finish')))await new Promise(done=>setTimeout(done,10));
if(mode==='auto-hold'&&args[args.indexOf('-m')+1]==='tester')await new Promise(()=>setInterval(()=>{},1000));
const flag=args.findIndex(a=>a==='--output-last-message'||a==='-o');if(flag<0)process.exit(8);
if(mode.startsWith('auto')){
 const role=args[args.indexOf('-m')+1],prior=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 if((role==='builder'&&mode!=='auto-no-commit')||role==='fixer'||(mode==='auto-move-'+role&&prior.filter(a=>a.args[a.args.indexOf('-m')+1]===role).length===1)||mode==='auto-move-always-'+role){
  writeFileSync('lane-change.md',String(count));
  for(const a of [['add','lane-change.md'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture lane change']]){if(spawnSync('git',a).status!==0)process.exit(9)}
 }
 const round=prior.filter(a=>a.args[a.args.indexOf('-m')+1]==='tester').length;
 const verdict=role==='tester'?(mode==='auto-missing'?'No verdict.':mode==='auto-fail'||(mode==='auto-chain'&&round===1)?'Verdict: FAIL':'Verdict: PASS'):role==='reviewer'?((mode==='auto-act'||mode==='auto-handoff')?'Verdict: ACT':mode==='auto-review-missing'?'No verdict.':'Verdict: CLEAN'):'Committed.';
 let reply=verdict+'\nFixture reply.';
 if(mode==='auto-empty-'+role)reply='';
 if(mode==='auto-handoff'&&role==='tester'&&round>1){
  const review=prior.find(a=>a.args[a.args.indexOf('-m')+1]==='reviewer');
  if(prompt.includes(review.args[review.args.indexOf('-o')+1].replaceAll('\\','/')))reply='Verdict: FAIL\nReviewer P1 remains unfixed.';
 }
 writeFileSync(args[flag+1],reply);process.exit(0);
}
if(mode==='no-reply')process.exit(0);
writeFileSync(args[flag+1],mode==='empty'?'':'Fixture final reply.');
if(mode==='hold'){setInterval(()=>{if(existsSync(join(root,'finish')))process.exit(0)},10)}
else if(mode==='hang'){setInterval(()=>{},1000)}else process.exit(mode==='timeout'?124:mode==='fail'?1:0);`,
  );
  writeFileSync(join(root, "mode"), "ok");
  const claude = join(root, "fake-claude.mjs");
  writeFileSync(
    claude,
    String.raw`import {existsSync,readFileSync,appendFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const root=process.env.LANE_FIXTURE,args=process.argv.slice(2),file=join(root,'attempts.jsonl'),prompt=readFileSync(0,'utf8');
const count=existsSync(file)?readFileSync(file,'utf8').trim().split('\n').length:0;
appendFileSync(file,JSON.stringify({args,cwd:process.cwd(),prompt})+'\n');
const mode=readFileSync(join(root,'mode'),'utf8');
writeFileSync(join(root,'harness-pid'),String(process.pid));
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session'}));
console.error('fixture stderr');
if(mode==='rate-event'&&count===0){console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected'}}));process.exit(1)}
if(mode==='limit'||((mode==='capacity'||mode==='rate-limit')&&count===0)){
 console.log(JSON.stringify({type:'result',is_error:true,session_id:'claude-session',errors:[mode==='rate-limit'?'rate_limit_error':'overloaded_error']}));process.exit(1);
}
if(mode==='no-reply')process.exit(0);
if(mode==='error-result'){console.log(JSON.stringify({type:'result',is_error:true,result:'Failed'}));process.exit(1)}
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Not the final reply'}]}}));
const result=JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'claude-session',result:'Verdict: PASS\nClaude final reply.'});
process.stdout.write(result.slice(0,20));setTimeout(()=>{process.stdout.write(result.slice(20)+'\n');
 if(mode==='hang')setInterval(()=>{},1000);else process.exit(0);
},10);`,
  );
  for (const [name, file] of [
    ["forge", forge],
    ["codex", codex],
    ["claude", claude],
  ]) {
    const shim = join(bin, name!);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec node "${file!.replaceAll("\\", "/")}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  let pristine = false;
  function git(args: string[], cwd = main) {
    pristine = false;
    childLaunches++;
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
  if (!cached) {
    git(["init", "--initial-branch=main"]);
    git(["add", "package.json", ".gitignore", ".forge/config.yaml"]);
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
    repositories.save(trustedPolicy, root, true);
  }
  const config = join(caller, ".forge", "config.yaml");
  function roles(model = "gpt-6.1-sol", harness = "codex") {
    pristine = false;
    writeFileSync(
      config,
      `values:\n  lanes:\n${tiers}    roles:\n      builder:\n        harness: ${harness}\n        model: ${model}\n        effort: high\n`,
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
  const autoScript = join(root, "auto-fixture.ts");
  // Keep CLI isolation and real Git/harness children; only the canned issue lookup
  // needs no shell and Node process for every step of an ordinary auto chain.
  writeFileSync(
    autoScript,
    String.raw`import {mock} from 'bun:test';
import {runCommand} from ${JSON.stringify(resolve(import.meta.dirname, "../../tools/run-command.ts"))};
import {scriptFixture} from ${JSON.stringify(resolve(import.meta.dirname, "../script-fixture.ts"))};
import {appendFileSync} from 'node:fs';
const issue=scriptFixture(${JSON.stringify(forge)}),nativeRunCommand=runCommand;
mock.module(${JSON.stringify(resolve(import.meta.dirname, "../../tools/run-command.ts"))},()=>({runCommand:(command,args,options)=>{
 if(command!=='forge')return nativeRunCommand(command,args,options);
 const result=issue('',args,options.env??process.env,options.cwd??process.cwd());
 appendFileSync(${JSON.stringify(join(root, "issue-calls"))},'lookup\n');
 return result;
}}));
const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  function run(args: string[], cwd = caller, entry = script) {
    childLaunches++;
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (args[0] !== "auto") expect(lines).toHaveLength(1);
    return {
      code: result.status,
      output: lines.at(-1) as unknown as Verdict,
      lines,
      stderr: result.stderr,
    };
  }
  function start() {
    const reuse = pristine;
    pristine = false;
    const key = `started:${trustedPolicy}`;
    if (reuse && repositories.restore(key, root))
      return join(main, ".worktrees", "one");
    const lane = join(main, ".worktrees", "one");
    git(["worktree", "add", "-b", "lane/one", lane, "origin/main"]);
    writeFileSync(
      join(main, ".git/forge-lanes.json"),
      JSON.stringify([
        { issue: "one", worktree: lane, branch: "lane/one", brief },
      ]),
    );
    if (reuse) repositories.save(key, root, true);
    return lane;
  }
  function trust(policy: string) {
    writeFileSync(join(main, ".forge", "config.yaml"), policy);
    git(["add", ".forge/config.yaml"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "trusted policy",
    ]);
    git(["push", "origin", "main"]);
    git(["fetch", "origin", "main"]);
  }
  function launch(
    entry = script,
    allowEmpty = false,
    args = ["run", "one", "--role", "builder"],
  ) {
    childLaunches++;
    const child = children.own(
      spawn(process.execPath, [entry, ...args], {
        cwd: caller,
        env,
        windowsHide: true,
        timeout: 20_000,
        detached: args.includes("--detach"),
      }),
    );
    child.stderr.resume();
    return Object.assign(
      new Promise<{ code: number | null; output: Verdict }>((done, fail) => {
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.once("error", fail);
        child.once("close", (code) => {
          try {
            done({
              code,
              output: JSON.parse(stdout || (allowEmpty ? "{}" : "")) as Verdict,
            });
          } catch (error) {
            fail(
              error instanceof Error
                ? error
                : new Error("invalid verdict", { cause: error }),
            );
          }
        });
      }),
      { child },
    );
  }
  const attempts = () =>
    existsSync(join(root, "attempts.jsonl"))
      ? readFileSync(join(root, "attempts.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Attempt)
      : [];
  async function direct(
    worktree: string,
    mode: string,
    resume?: string,
    harness = "codex",
  ): Promise<
    Pick<
      Verdict,
      "session" | "reply" | "log" | "exit" | "retries" | "stoppedAfterReply"
    >
  > {
    writeFileSync(join(root, "mode"), mode);
    const folder = join(root, "direct-output");
    mkdirSync(folder);
    return withEnvironment(env, () =>
      (harness === "claude" ? runClaude : runCodex)(
        {
          worktree,
          folder,
          model: harness === "claude" ? "claude-sonnet-5-5" : "gpt-6.1-sol",
          effort: "high",
          prompt: "Direct fixture prompt",
          ...(resume ? { resume } : {}),
        },
        { replyGraceMs: 100, pollMs: 10, retryDelayMs: 1 },
      ),
    );
  }
  pristine = true;
  return {
    root,
    main,
    caller,
    config,
    brief,
    roles,
    run,
    start,
    trust,
    launch,
    attempts,
    direct,
    git,
    env,
    autoScript,
  };
}
function expectModel(attempt: Attempt, model: string) {
  const modelFlag = attempt.args.findIndex(
    (arg) => arg === "--model" || arg === "-m",
  );
  expect(attempt.args[modelFlag + 1]).toBe(model);
  expect(attempt.args.join(" ")).toMatch(/model_reasoning_effort[^ ]*high/);
}

function claudeRole(f: ReturnType<typeof fixture>, role: string) {
  writeFileSync(
    f.config,
    `values:\n  lanes:\n${tiers}    roles:\n      ${role}: {harness: claude, model: claude-sonnet-5-5, effort: high}\n`,
  );
}

test("claude tester runs end to end with the same verdict, record and list shape", () => {
  const f = fixture(),
    lane = f.start();
  claudeRole(f, "tester");
  const result = f.run(["run", "one", "--role", "tester"]);
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    verdict: "completed",
    role: "tester",
    harness: "claude",
    model: "claude-sonnet-5-5",
    effort: "high",
    session: "claude-session",
    retries: 0,
    stoppedAfterReply: false,
    exit: 0,
  });
  const attempt = f.attempts()[0]!;
  expect(attempt.cwd).toBe(lane);
  expect(attempt.args).toEqual([
    "-p",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "high",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ]);
  expect(attempt.prompt).toBe(
    readFileSync(join(result.output.folder!, "brief.md"), "utf8"),
  );
  expect(readFileSync(result.output.reply!, "utf8")).toBe(
    "Verdict: PASS\nClaude final reply.",
  );
  expect(readFileSync(result.output.log!, "utf8")).toContain("fixture stderr");
  for (const name of ["start.txt", "end.txt"])
    expect(existsSync(join(result.output.folder!, name))).toBe(true);
  const record: unknown = JSON.parse(
    readFileSync(join(result.output.folder!, "run.json"), "utf8"),
  );
  expect(record).toMatchObject({
    harness: "claude",
    verdict: "completed",
    session: "claude-session",
    round: 1,
  });
  const list = f.run(["list"]).output as unknown as {
    lanes: { runs: unknown[] }[];
  };
  expect(list.lanes[0]!.runs).toEqual([record]);
});

test("interrupted Claude tester recovers its stream session before resuming", async () => {
  const f = roleFixture();
  claudeRole(f, "tester");
  const record = f.seed("tester", 1, "started"),
    file = join(record.reply, "..", "run.json");
  writeFileSync(
    file,
    JSON.stringify({ ...record, harness: "claude", end: null, session: null }),
  );
  writeFileSync(
    join(file, "..", "log.txt"),
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "interrupted-claude-session",
    })}\n`,
  );
  const result = await f.runRole("tester", ["--round-cap", "1"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")) as unknown).toMatchObject({
    verdict: "interrupted",
    session: "interrupted-claude-session",
  });
  const args = f.attempts()[0]!.args;
  expect(
    args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2),
  ).toEqual(["--resume", "interrupted-claude-session"]);
});

test("claude reviewer has only read tools and no MCP; builder skips permissions", () => {
  const f = fixture();
  f.start();
  claudeRole(f, "reviewer");
  expect(f.run(["run", "one", "--role", "reviewer"]).code).toBe(0);
  claudeRole(f, "builder");
  expect(f.run(["run", "one", "--role", "builder"]).code).toBe(0);
  const [review, build] = f.attempts();
  expect(review!.args).toContain("--permission-mode");
  expect(review!.args[review!.args.indexOf("--permission-mode") + 1]).toBe(
    "plan",
  );
  expect(review!.args[review!.args.indexOf("--tools") + 1]).toBe(
    "Read,Glob,Grep",
  );
  expect(review!.args).toContain("--strict-mcp-config");
  expect(review!.args).not.toContain("--dangerously-skip-permissions");
  expect(build!.args).toContain("--dangerously-skip-permissions");
  expect(build!.args).not.toContain("--permission-mode");
  expect(build!.args).not.toContain("--tools");
});

for (const mode of ["capacity", "rate-limit", "rate-event"])
  test(`claude ${mode} retries once and resumes the stream session`, async () => {
    const f = fixture(),
      lane = f.start();
    const result = await f.direct(lane, mode, undefined, "claude");
    expect(result.retries).toBe(1);
    expect(result.session).toBe("claude-session");
    expect(result.exit).toBe(0);
    expect(f.attempts()).toHaveLength(2);
    const retry = f.attempts()[1]!;
    expect(retry.args[retry.args.indexOf("--resume") + 1]).toBe(
      "claude-session",
    );
    expect(readFileSync(result.reply!, "utf8")).toContain("Verdict: PASS");
    expect(readFileSync(result.log!, "utf8")).toContain(
      mode === "rate-event" ? "rate_limit_event" : "is_error",
    );
  });

test.skipIf(process.platform !== "win32")(
  "claude resolves a native Windows executable before the shell shim",
  () => {
    const f = fixture();
    f.start();
    childLaunches++;
    const compile = spawnSync(
      process.execPath,
      [
        "build",
        "--compile",
        join(f.root, "fake-claude.mjs"),
        "--outfile",
        join(f.root, "bin", "claude.exe"),
      ],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    expect(compile.error).toBeUndefined();
    expect(compile.status).toBe(0);
    // A trap shim prevents any fallthrough to a real CLI during the red run.
    writeFileSync(join(f.root, "bin", "claude"), "#!/bin/sh\nexit 17\n");
    claudeRole(f, "tester");
    const result = f.run(["run", "one", "--role", "tester"]);
    expect(result.code).toBe(0);
    expect(result.output.session).toBe("claude-session");
    expect(readFileSync(result.output.reply!, "utf8")).toContain(
      "Verdict: PASS",
    );
  },
);

test("claude reply grace stops a hanging process after the result event", async () => {
  const f = fixture(),
    lane = f.start();
  const result = await f.direct(lane, "hang", undefined, "claude");
  expect(result.stoppedAfterReply).toBe(true);
  expect(result.retries).toBe(0);
  expect(readFileSync(result.reply!, "utf8")).toBe(
    "Verdict: PASS\nClaude final reply.",
  );
  expect(alive(Number(readFileSync(join(f.root, "harness-pid"), "utf8")))).toBe(
    false,
  );
});

test("claude capacity stops at three retries and keeps the session and error log", async () => {
  const f = fixture(),
    lane = f.start();
  const result = await f.direct(lane, "limit", undefined, "claude");
  expect(result).toMatchObject({
    retries: 3,
    exit: 1,
    session: "claude-session",
    stoppedAfterReply: false,
  });
  expect(f.attempts()).toHaveLength(4);
  for (const attempt of f.attempts().slice(1))
    expect(attempt.args[attempt.args.indexOf("--resume") + 1]).toBe(
      "claude-session",
    );
  expect(existsSync(result.reply!)).toBe(false);
  expect(
    readFileSync(result.log!, "utf8").match(/overloaded_error/g),
  ).toHaveLength(4);
});

for (const mode of ["no-reply", "error-result"])
  test(`claude ${mode} never writes a successful reply`, () => {
    const f = fixture();
    f.start();
    claudeRole(f, "tester");
    writeFileSync(join(f.root, "mode"), mode);
    const result = f.run(["run", "one", "--role", "tester"]);
    expect(result.code).toBe(1);
    expect(result.output.verdict).toBe("failed");
    expect(result.output.retries).toBe(0);
    expect(existsSync(result.output.reply!)).toBe(false);
    expect(f.attempts()).toHaveLength(1);
  });

test("claude support still refuses gemini before writing any run folder", () => {
  const f = fixture();
  f.start();
  f.roles("gemini", "gemini");
  const result = f.run(["run", "one", "--role", "builder"]);
  expect(result.code).toBe(1);
  expect(result.output.verdict).toBe("refused");
  expect(result.output.next).toBe(
    "unsupported harness: gemini; configure codex or claude",
  );
  expect(result.output.folder).toBeNull();
  expect(existsSync(join(f.main, ".git", "forge-lane-runs"))).toBe(false);
  expect(f.attempts()).toEqual([]);
});

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
    "tier",
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
  const premise = prompt.indexOf("premise holds: <evidence>");
  expect(premise).toBeGreaterThanOrEqual(0);
  expect(premise).toBeLessThan(prompt.indexOf("Tests first:"));
  expect(prompt).toContain("premise does not hold: <evidence>");
  expect(prompt).toContain(
    `forge issue comment --input '{"id":"<slice>","body":"premise holds: <evidence>"}'`,
  );
  expect(prompt).toContain(
    "through the installed `forge`, before any code change",
  );
  for (const text of [rules, readFileSync(f.brief, "utf8")])
    expect(text).not.toMatch(/[A-Z]:[\\/]|\/Users\/|\/home\//);
});

test("concurrent builders are refused until the active lane run finishes", async () => {
  const f = fixture();
  f.start();
  writeFileSync(join(f.root, "mode"), "hold");
  const first = f.launch();
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!ready() && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 10));
    expect(ready()).toBe(true);
  };
  let second: ReturnType<typeof f.launch> | undefined;
  let refused: Awaited<ReturnType<typeof f.launch>> | undefined;
  try {
    await waitFor(() => f.attempts().length === 1);
    const runs = join(f.main, ".git", "forge-lane-runs", "one");
    const started = JSON.parse(
      readFileSync(join(runs, readdirSync(runs)[0]!, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(started).toMatchObject({
      role: "builder",
      round: null,
      verdict: "started",
      end: null,
    });
    second = f.launch();
    void second.then((result) => {
      refused = result;
    });
    await waitFor(() => refused !== undefined || f.attempts().length === 2);
  } finally {
    writeFileSync(join(f.root, "finish"), "finish");
    await Promise.all([first, second]);
  }
  expect((await first).code).toBe(0);
  expect(refused?.code).toBe(1);
  expect(refused?.output.verdict).toBe("refused");
  expect(refused?.output.next).toMatch(/wait|finish/i);
  expect(f.attempts()).toHaveLength(1);
  writeFileSync(join(f.root, "mode"), "ok");
  expect(f.run(["run", "one", "--role", "builder"]).code).toBe(0);
});

async function waitForProcess(step: string, ready: () => boolean) {
  const started = Date.now();
  const deadline = started + 8_000;
  while (!ready() && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  expect(ready(), `waiting for ${step} after ${Date.now() - started}ms`).toBe(
    true,
  );
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("hard-killed runner retains the harness lock until the harness exits", async () => {
  const f = fixture();
  f.start();
  writeFileSync(join(f.root, "mode"), "hold");
  const first = f.launch(script, true);
  let pid = 0;
  let second: ReturnType<typeof f.run> | undefined;
  try {
    await waitForProcess("harness startup", () =>
      existsSync(join(f.root, "harness-pid")),
    );
    pid = Number(readFileSync(join(f.root, "harness-pid"), "utf8"));
    expect(first.child.kill("SIGKILL")).toBe(true);
    await first;
    expect(alive(pid)).toBe(true);
    const runs = join(f.main, ".git", "forge-lane-runs", "one");
    const record = join(runs, readdirSync(runs)[0]!, "run.json");
    const before = readFileSync(record, "utf8");
    f.run(["list"]);
    expect(readFileSync(record, "utf8")).toBe(before);
    writeFileSync(join(f.root, "mode"), "ok");
    second = f.run(["run", "one", "--role", "builder"]);
  } finally {
    writeFileSync(join(f.root, "finish"), "finish");
    await first;
    if (pid) await waitForProcess("harness exit", () => !alive(pid));
  }
  const reclaimed = f.run(["run", "one", "--role", "builder"]);
  expect(second?.code).toBe(1);
  expect(second?.output.verdict).toBe("refused");
  expect(second?.output.next).toMatch(/wait|finish/i);
  expect(reclaimed.code).toBe(0);
  expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
});

async function signalRun(emitted: boolean) {
  const f = fixture();
  f.start();
  writeFileSync(join(f.root, "mode"), "hold");
  const helper = join(f.root, "emit-term.ts");
  writeFileSync(
    helper,
    `import {existsSync} from 'node:fs';const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(f.root, "signal"))})){clearInterval(timer);process.emit('SIGTERM');}},20);const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  const first = f.launch(emitted ? helper : script, true);
  let pid = 0;
  try {
    await waitForProcess("harness startup", () =>
      existsSync(join(f.root, "harness-pid")),
    );
    pid = Number(readFileSync(join(f.root, "harness-pid"), "utf8"));
    if (emitted) writeFileSync(join(f.root, "signal"), "terminate");
    else expect(first.child.kill("SIGTERM")).toBe(true);
    expect((await first).code).not.toBe(0);
    const runs = join(f.main, ".git", "forge-lane-runs", "one");
    const record = JSON.parse(
      readFileSync(join(runs, readdirSync(runs)[0]!, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record.verdict).toBe("failed");
    expect(record.end).toMatch(/^\d{4}-/);
    await waitForProcess("harness exit", () => !alive(pid));
    expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
  } finally {
    writeFileSync(join(f.root, "finish"), "finish");
    await first;
    if (pid) await waitForProcess("harness exit", () => !alive(pid));
  }
  writeFileSync(join(f.root, "mode"), "ok");
  expect(f.run(["run", "one", "--role", "builder"]).code).toBe(0);
}
test.skipIf(process.platform === "win32")(
  "SIGTERM stops the harness and releases the lock",
  () => signalRun(false),
);
test("SIGTERM handler stops the real harness tree and releases the lock", () =>
  signalRun(true));

test("brief restores the wrong-issue stop rule verbatim", () => {
  const rule =
    "If the issue is wrong about the code, or already fixed on main, stop and say so with evidence instead of changing code.";
  expect(readFileSync(template, "utf8").replace(/\s+/g, " ")).toContain(rule);
});

test("empty reply fails with a typed verdict and the log path", () => {
  const f = fixture();
  f.start();
  writeFileSync(join(f.root, "mode"), "empty");
  const result = f.run(["run", "one", "--role", "builder"]);
  expect(result.code).toBe(1);
  expect(result.output.verdict).toBe("failed");
  expect(JSON.stringify(result.output)).toMatch(/no reply was written/i);
  expect(existsSync(result.output.log!)).toBe(true);
  expect(readFileSync(result.output.reply!, "utf8")).toBe("");
  const record = JSON.parse(
    readFileSync(join(result.output.folder!, "run.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(record).toMatchObject({
    verdict: "failed",
    role: "builder",
    session: "fake-session",
  });
  expect(record.end).toMatch(/^\d{4}-/);
  writeFileSync(join(f.root, "mode"), "ok");
  expect(f.run(["run", "one", "--role", "builder"]).code).toBe(0);
});

test("a dead owner run lock is reclaimed and released", () => {
  const f = fixture();
  f.start();
  childLaunches++;
  const dead = spawnSync(process.execPath, ["-e", ""], {
    timeout: 5_000,
    windowsHide: true,
  });
  expect(dead.status).toBe(0);
  const lock = join(f.main, ".git", "forge-lane-one.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${dead.pid}-${randomUUID()}`), "");
  expect(f.run(["run", "one", "--role", "builder"]).code).toBe(0);
  expect(existsSync(lock)).toBe(false);
  expect(
    readdirSync(join(f.main, ".git")).filter((name) =>
      name.startsWith("forge-lane-one.lock"),
    ),
  ).toEqual([]);
});

test("reply guard releases the lane run lock after stopping the harness", () => {
  const f = fixture();
  f.start();
  writeFileSync(join(f.root, "mode"), "hang");
  const helper = join(f.root, "fast-clock.ts");
  // Accelerate the child clock; exercise the CLI's actual 90-second guard and finally.
  writeFileSync(
    helper,
    `const now=Date.now;Date.now=()=>now()*1000;const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  const result = f.run(["run", "one", "--role", "builder"], f.caller, helper);
  expect(result.code).toBe(0);
  expect(result.output.stoppedAfterReply).toBe(true);
  expect(readFileSync(result.output.reply!, "utf8")).toBe(
    "Fixture final reply.",
  );
  expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
  writeFileSync(join(f.root, "mode"), "ok");
  expect(f.run(["run", "one", "--role", "builder"]).code).toBe(0);
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

test("capacity retry resumes the same session at default tier", async () => {
  const f = fixture(),
    lane = f.start();
  const result = await f.direct(lane, "capacity");
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

test("capacity retries stop after three retries and retain failure evidence", async () => {
  const f = fixture(),
    lane = f.start();
  const result = await f.direct(lane, "limit");
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

test("reply guard stops a lingering child after a reply and preserves the reply", async () => {
  const f = fixture(),
    lane = f.start(),
    before = Date.now();
  const result = await f.direct(lane, "hang");
  expect(Date.now() - before).toBeLessThan(10_000);
  expect(result.stoppedAfterReply).toBe(true);
  expect(result.retries).toBe(0);
  expect(readFileSync(result.reply!, "utf8")).toBe("Fixture final reply.");
  expect(f.attempts()).toHaveLength(1);
});

function roleFixture() {
  const f = fixture();
  f.start();
  writeFileSync(
    f.config,
    `values:
  lanes:
${tiers}    roles:
${["builder", "fixer", "tester", "reviewer"]
  .map(
    (role) => `      ${role}:
        harness: codex
        model: fixture-model
        effort: high
`,
  )
  .join("")}`,
  );
  const runs = join(f.main, ".git", "forge-lane-runs", "one");
  let clock = 0;
  function seed(
    role: string,
    round: number | null,
    verdict = "completed",
    reply = "Prior reply.",
  ) {
    const folder = join(runs, `arbitrary-${randomUUID()}`);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "reply.md");
    writeFileSync(path, reply);
    const record = {
      role,
      round,
      model: "fixture-model",
      effort: "high",
      start: new Date(++clock * 1000).toISOString(),
      end: new Date(clock * 1000 + 1).toISOString(),
      verdict,
      session: "fixture-session",
      reply: path,
    };
    writeFileSync(join(folder, "run.json"), JSON.stringify(record));
    return record;
  }
  const issue = scriptFixture(join(f.root, "fake-forge.mjs"));
  // Role assembly owns no CLI lifecycle or lock proof; those stay in f.run/f.launch.
  const runRole = async (role: string, extra: string[] = []) => {
    const lines: Record<string, unknown>[] = [];
    return withEnvironment(f.env, async () => {
      const code = await laneRun(["one", "--role", role, ...extra], {
        common: join(f.main, ".git"),
        configRoot: f.caller,
        lanes: [
          {
            issue: "one",
            worktree: join(f.main, ".worktrees", "one"),
            branch: "lane/one",
            brief: f.brief,
          },
        ],
        issue: (id) =>
          issue(
            "",
            ["issue", "show", "--input", JSON.stringify({ id })],
            f.env,
            f.caller,
          ).stdout,
        lock: () => () => {},
        report: (json) =>
          lines.push(JSON.parse(json) as Record<string, unknown>),
      });
      expect(lines).toHaveLength(1);
      return {
        code,
        output: lines[0] as unknown as Verdict,
        lines,
        stderr: "",
      };
    });
  };
  const prompt = () => f.attempts().at(-1)!.prompt;
  return { ...f, runs, seed, runRole, prompt };
}

function change(
  f: ReturnType<typeof fixture>,
  files: string[],
  lane = join(f.main, ".worktrees", "one"),
) {
  for (const file of files) {
    mkdirSync(resolve(lane, file, ".."), { recursive: true });
    writeFileSync(join(lane, file), `Changed ${file}.\n`);
  }
  f.git(["add", "--", ...files], lane);
  f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture changes",
    ],
    lane,
  );
}

function autoFixture(mode = "auto-chain") {
  const f = roleFixture();
  let config = readFileSync(f.config, "utf8");
  for (const role of ["builder", "fixer", "tester", "reviewer"])
    config = config.replace("model: fixture-model", `model: ${role}`);
  writeFileSync(f.config, config);
  writeFileSync(join(f.root, "mode"), mode);
  const auto = (extra: string[] = []) =>
    f.run(
      ["auto", "one", ...extra],
      f.caller,
      extra.includes("--detach") ? script : f.autoScript,
    );
  const roles = () => f.attempts().map((a) => a.args[a.args.indexOf("-m") + 1]);
  const head = () =>
    f.git(["rev-parse", "HEAD"], join(f.main, ".worktrees", "one"));
  return { ...f, auto, roles, head };
}

test("auto reads the Claude tester verdict through the same parser as Codex", () => {
  const f = autoFixture("auto-pass");
  writeFileSync(
    f.config,
    readFileSync(f.config, "utf8").replace(
      /tester:\s*\n\s*harness: codex\s*\n\s*model: tester/,
      "tester:\n        harness: claude\n        model: claude-sonnet-5-5",
    ),
  );
  const result = f.auto();
  expect(result.code).toBe(0);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "ready",
    head: f.head(),
  });
  expect(result.lines[1]).toMatchObject({
    step: "tester",
    verdict: "PASS",
    round: 1,
  });
  expect(f.attempts()[1]!.args).toContain("--model");
  expect(f.attempts()[1]!.args).toContain("claude-sonnet-5-5");
});

function killFixture(pid: number, group = false) {
  if (process.platform === "win32") {
    childLaunches++;
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
  } else {
    try {
      process.kill(group ? -pid : pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

test("detached auto survives parent exit and refuses a second chain", async () => {
  const f = autoFixture("auto-slow"),
    start = Date.now();
  const launched = f.launch(script, false, [
    "auto",
    "one",
    "--round-cap",
    "1",
    "--detach",
  ]);
  const first = await launched;
  expect(first.code).toBe(0);
  expect(Object.keys(first.output).sort()).toEqual([
    "log",
    "next",
    "outcome",
    "pid",
    "validated",
  ]);
  expect(first.output).toMatchObject({
    outcome: "detached",
    next: "bun tools/lane.ts list",
  });
  const { pid, log } = first.output as unknown as { pid: number; log: string };
  try {
    expect(Date.now() - start).toBeLessThan(2000);
    expect(pid).toBeGreaterThan(0);
    expect(log).toStartWith(f.runs);
    killFixture(launched.child.pid!, true);
    await waitForProcess("detached harness", () => f.attempts().length === 1);
    const folders = readdirSync(f.runs);
    const second = f.auto(["--detach"]);
    expect(second.code).toBe(1);
    expect(second.lines[0]?.next).toContain("already running");
    expect(readdirSync(f.runs)).toEqual(folders);
    const record = join(
      f.runs,
      folders.find((name) => existsSync(join(f.runs, name, "run.json")))!,
      "run.json",
    );
    const before = readFileSync(record, "utf8");
    expect(JSON.parse(before) as unknown).toMatchObject({ verdict: "started" });
    f.run(["list"]);
    expect(readFileSync(record, "utf8")).toBe(before);
    writeFileSync(join(f.root, "finish"), "continue");
    const deadline = Date.now() + 20_000;
    while (
      !readFileSync(log, "utf8").includes('"outcome":"ready"') &&
      Date.now() < deadline
    )
      await new Promise((done) => setTimeout(done, 50));
    expect(
      JSON.parse(readFileSync(log, "utf8").trim().split(/\r?\n/).at(-1)!),
    ).toMatchObject({ outcome: "ready" });
    expect(f.roles()).toEqual(["builder", "tester"]);
  } finally {
    killFixture(pid, true);
    if (existsSync(join(f.root, "harness-pid")))
      killFixture(Number(readFileSync(join(f.root, "harness-pid"), "utf8")));
  }
});

for (const detect of ["list", "auto", "run"])
  test(`interrupted tester recovers through ${detect} and resumes its session without consuming the cap`, async () => {
    const f = autoFixture("auto-hold");
    change(f, ["docs/guide.md"]);
    const first = f.launch(script, true, [
      "run",
      "one",
      "--role",
      "tester",
      "--round-cap",
      "1",
    ]);
    let pid = 0;
    try {
      await waitForProcess("held tester", () =>
        existsSync(join(f.root, "harness-pid")),
      );
      pid = Number(readFileSync(join(f.root, "harness-pid"), "utf8"));
      const record = join(f.runs, readdirSync(f.runs)[0]!, "run.json");
      await waitForProcess("session log", () =>
        readFileSync(join(record, "..", "log.txt"), "utf8").includes(
          "fake-session",
        ),
      );
      const lock = join(f.main, ".git", "forge-lane-one.lock");
      const child = Number(readdirSync(lock)[0]!.split("-").at(-1));
      expect(first.child.kill("SIGKILL")).toBe(true);
      await first;
      killFixture(child, true);
      killFixture(pid);
      await waitForProcess(
        "killed harness",
        () => !alive(pid) && !alive(child),
      );
      writeFileSync(join(f.root, "mode"), "auto-clean");
      if (detect === "list") {
        const listed = f.run(["list"]);
        expect(JSON.stringify(listed.lines)).toContain("tester interrupted");
      }
      const result =
        detect === "run"
          ? f.run(["run", "one", "--role", "tester", "--round-cap", "1"])
          : f.auto(["--round-cap", "1"]);
      expect(result.code).toBe(0);
      const interrupted = JSON.parse(readFileSync(record, "utf8")) as Record<
        string,
        unknown
      >;
      expect(interrupted).toMatchObject({
        verdict: "interrupted",
        role: "tester",
        round: 1,
        session: "fake-session",
      });
      expect(interrupted.end).toMatch(/^\d{4}-/);
      expect(f.attempts()[1]!.args).toContain("resume");
      expect(f.attempts()[1]!.args).toContain("fake-session");
      const history = readdirSync(f.runs).map(
        (name) =>
          JSON.parse(
            readFileSync(join(f.runs, name, "run.json"), "utf8"),
          ) as Record<string, unknown>,
      );
      expect(
        history.filter((row) => row.role === "tester").map((row) => row.round),
      ).toEqual([1, 1]);
      expect(f.roles()).toEqual(["tester", "tester"]);
    } finally {
      killFixture(first.child.pid!);
      if (pid) killFixture(pid);
      await first;
    }
  });

for (const session of ["fixture-session", null])
  test(`interrupted history starts a fresh folder with session ${session}`, () => {
    const f = autoFixture("auto-clean");
    const record = f.seed("builder", null, "started");
    const file = join(record.reply, "..", "run.json");
    writeFileSync(file, JSON.stringify({ ...record, end: null, session }));
    expect(f.auto().code).toBe(0);
    const args = f.attempts()[0]!.args;
    if (session)
      expect(
        args.slice(args.indexOf("resume"), args.indexOf("resume") + 2),
      ).toEqual(["resume", session]);
    else expect(args).not.toContain("resume");
    expect(JSON.parse(readFileSync(file, "utf8")) as unknown).toMatchObject({
      verdict: "interrupted",
    });
    expect(readdirSync(f.runs)).toHaveLength(3);
  });

for (const [role, cap] of [
  ["fixer", "1"],
  ["fixer", "2"],
  ["reviewer", "2"],
] as const)
  test(`interrupted ${role} reruns before accepting prior tester history at cap ${cap}`, () => {
    const f = autoFixture("auto-clean");
    change(f, ["docs/guide.md"]);
    const prior = f.seed(
      "tester",
      1,
      "completed",
      role === "fixer" ? "Verdict: FAIL" : "Verdict: PASS",
    );
    writeFileSync(
      join(prior.reply, "..", "run.json"),
      JSON.stringify({ ...prior, head: f.head() }),
    );
    const record = f.seed(role, null, "started");
    const file = join(record.reply, "..", "run.json");
    writeFileSync(file, JSON.stringify({ ...record, end: null }));
    const result = f.auto(["--round-cap", cap]);
    expect(result.code).toBe(cap === "1" ? 1 : 0);
    if (cap === "1") {
      expect(f.roles()).toEqual(["fixer"]);
      expect(result.lines.at(-1)).toMatchObject({
        outcome: "blocked",
        reason: "round-cap",
      });
    }
    expect(f.roles()[0]).toBe(role);
    expect(f.attempts()[0]!.args).toContain("fixture-session");
    if (role === "fixer")
      expect(f.attempts()[0]!.prompt).toContain(
        prior.reply.replaceAll("\\", "/"),
      );
    expect(JSON.parse(readFileSync(file, "utf8")) as unknown).toMatchObject({
      verdict: "interrupted",
    });
  });

test("auto chains builder, failed tester, fixer and passing tester to ready", () => {
  const f = autoFixture();
  const result = f.auto();
  expect(result.code).toBe(0);
  expect(f.roles()).toEqual(["builder", "tester", "fixer", "tester"]);
  expect(result.lines.at(-1)).toEqual({
    outcome: "ready",
    head: f.head(),
    next: "push and open the PR",
  });
  expect(result.lines.slice(0, -1).map((row) => row.step)).toEqual(f.roles());
  const firstTest = result.lines[1]!;
  expect(firstTest).toMatchObject({
    step: "tester",
    round: 1,
    verdict: "FAIL",
  });
  expect(typeof firstTest.minutes).toBe("number");
  expect(f.attempts()[2]!.prompt).toContain(
    String(firstTest.reply).replaceAll("\\", "/"),
  );
  expect(f.attempts()[2]!.prompt).toContain("fix every P1");
  expect(f.attempts()[2]!.prompt).toContain(
    "Re-run the tester's applicable targeted checks and repros, including existing tests covering the changed code.",
  );
  expect(f.attempts()[2]!.prompt).toContain(
    "every regression lane in `.forge/config.yaml` whose files the diff touches",
  );
  expect(f.attempts()[2]!.prompt).toContain("acceptance tests");
  expect(f.attempts()[2]!.prompt).toContain("bun run test:changed");
  const list = f.run(["list"]).lines[0] as {
    lanes: { state: string; since: string; runs: { end: string }[] }[];
  };
  expect(list.lanes[0]!.state).toBe("tester PASS");
  expect(list.lanes[0]!.since).toBe(list.lanes[0]!.runs.at(-1)!.end);
  expect(f.auto().lines.at(-1)?.outcome).toBe("ready");
  expect(f.roles()).toHaveLength(4);
});

test("auto blocks a builder reply without a commit and preserves the block on resume", () => {
  const f = autoFixture("auto-no-commit");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.auto();
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatchObject({
      outcome: "blocked",
      reason: "no-commit",
      step: "builder",
    });
    expect(f.roles()).toEqual(["builder"]);
  }
});

test("auto rejects resumed builder and PASS history without a lane commit", () => {
  const f = autoFixture("auto-pass");
  for (const record of [
    f.seed("builder", null),
    f.seed("tester", 1, "completed", "Verdict: PASS"),
  ])
    writeFileSync(
      join(record.reply, "..", "run.json"),
      JSON.stringify({ ...record, head: f.head() }),
    );
  const result = f.auto();
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "no-commit",
  });
  expect(f.roles()).toEqual([]);
});

for (const mode of ["auto-clean", "auto-act"])
  test(`auto requires the security review before ready after ${mode}`, () => {
    const f = autoFixture(mode);
    change(f, ["src/core/trust/access.ts"]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.auto();
      expect(result.code).toBe(1);
      expect(result.lines.at(-1)).toMatchObject({
        outcome: "blocked",
        reason: "security-review",
        next: "run the security review, then push",
      });
      expect(f.roles()).toEqual(
        mode === "auto-clean"
          ? ["tester", "reviewer"]
          : ["tester", "reviewer", "fixer", "tester"],
      );
    }
  });

for (const state of ["tracked", "staged", "untracked"])
  test(`auto blocks ready with ${state} worktree changes after local reviews`, () => {
    const f = autoFixture("auto-clean");
    change(f, ["tools/changed.ts"]);
    const lane = join(f.main, ".worktrees", "one");
    for (const [role, round, reply] of [
      ["tester", 1, "Verdict: PASS"],
      ["reviewer", null, "Verdict: CLEAN"],
    ] as const) {
      const record = f.seed(role, round, "completed", reply);
      writeFileSync(
        join(record.reply, "..", "run.json"),
        JSON.stringify({ ...record, head: f.head() }),
      );
    }
    const file = state === "untracked" ? "untracked.md" : "tools/changed.ts";
    writeFileSync(join(lane, file), "Uncommitted change.\n");
    if (state === "staged") f.git(["add", "--", file], lane);
    const result = f.auto();
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatchObject({
      outcome: "blocked",
      reason: "dirty-worktree",
    });
    expect(f.roles()).toEqual([]);
  });

test("auto bounds failing tester rounds and resumes the blocked cap", () => {
  const f = autoFixture("auto-fail");
  const result = f.auto(["--round-cap", "2"]);
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "round-cap",
    step: "tester",
  });
  expect(result.lines.at(-1)?.next).toContain("three-line threat model");
  expect(f.roles()).toEqual(["builder", "tester", "fixer", "tester"]);
  expect(f.auto().code).toBe(1);
  expect(f.roles()).toHaveLength(4);
});

for (const verdict of ["FAIL", "PASS"])
  test(`auto resumes a completed builder and tester ${verdict} from history`, () => {
    const f = autoFixture("auto-pass");
    change(f, ["docs/guide.md"]);
    const head = f.head();
    for (const record of [
      f.seed("builder", null),
      f.seed("tester", 1, "completed", `Verdict: ${verdict}\nFinding.`),
    ])
      writeFileSync(
        join(record.reply, "..", "run.json"),
        JSON.stringify({ ...record, head }),
      );
    const result = f.auto();
    expect(result.code).toBe(0);
    expect(f.roles()).toEqual(verdict === "FAIL" ? ["fixer", "tester"] : []);
  });

for (const mode of ["auto-act", "auto-clean", "auto-review-missing"])
  test(`auto code review ${mode} runs at most one review repair`, () => {
    const f = autoFixture(mode);
    change(f, ["tools/changed.ts"]);
    const result = f.auto();
    expect(result.code).toBe(0);
    expect(result.lines.at(-1)?.outcome).toBe("ready");
    expect(f.roles()).toEqual(
      mode === "auto-clean"
        ? ["tester", "reviewer"]
        : ["tester", "reviewer", "fixer", "tester"],
    );
    expect(f.auto().code).toBe(0);
    expect(f.roles()).toHaveLength(mode === "auto-clean" ? 2 : 4);
  });

test("auto hands reviewer findings to the final tester before accepting PASS", () => {
  const f = autoFixture("auto-handoff");
  change(f, ["tools/changed.ts"]);
  const result = f.auto();
  expect(f.roles()).toEqual(["tester", "reviewer", "fixer", "tester"]);
  const review = String(result.lines[1]!.reply).replaceAll("\\", "/");
  const finalPrompt = f.attempts()[3]!.prompt;
  expect(finalPrompt).toContain(review);
  expect(finalPrompt).toContain("verify every P0/P1 finding");
  expect(finalPrompt).toContain("Only return Verdict: PASS");
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "failed",
  });
});

test("auto resumes review repair with the reviewer report in the tester prompt", () => {
  const f = autoFixture("auto-pass");
  change(f, ["tools/changed.ts"]);
  f.seed("tester", 1, "completed", "Verdict: PASS");
  const review = f.seed(
    "reviewer",
    null,
    "completed",
    "Verdict: ACT\nP1: missed finding.",
  );
  const fix = f.seed("fixer", null, "completed", "Committed.");
  writeFileSync(
    join(fix.reply, "..", "run.json"),
    JSON.stringify({ ...fix, head: f.head() }),
  );
  const result = f.auto();
  expect(result.code).toBe(0);
  expect(f.roles()).toEqual(["tester"]);
  expect(f.prompt()).toContain(review.reply.replaceAll("\\", "/"));
  expect(f.prompt()).toContain("verify every P0/P1 finding");
});

test("auto treats empty tester replies as FAIL, consumes rounds and resumes at the cap", () => {
  const f = autoFixture("auto-empty-tester");
  const result = f.auto();
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "round-cap",
  });
  expect(f.roles()).toEqual(["builder", "tester", "fixer", "tester"]);
  expect(
    result.lines
      .filter((row) => row.step === "tester" && !row.outcome)
      .map((row) => [row.round, row.verdict]),
  ).toEqual([
    [1, "FAIL"],
    [2, "FAIL"],
  ]);
  expect(f.auto().code).toBe(1);
  expect(f.roles()).toHaveLength(4);
});

test("auto treats an empty reviewer reply as ACT and verifies its report after repair", () => {
  const f = autoFixture("auto-empty-reviewer");
  change(f, ["tools/changed.ts"]);
  const result = f.auto();
  expect(result.code).toBe(0);
  expect(f.roles()).toEqual(["tester", "reviewer", "fixer", "tester"]);
  expect(result.lines[1]).toMatchObject({ step: "reviewer", verdict: "ACT" });
  expect(f.attempts()[3]!.prompt).toContain(
    String(result.lines[1]!.reply).replaceAll("\\", "/"),
  );
  expect(f.auto().code).toBe(0);
  expect(f.roles()).toHaveLength(4);
});

for (const role of ["tester", "reviewer"])
  for (const mode of ["empty", "no-reply"])
    test(`manual ${role} with ${mode} reply fails without consuming a round`, async () => {
      const f = roleFixture();
      writeFileSync(join(f.root, "mode"), mode);
      const result = await f.runRole(role);
      expect(result.code).toBe(1);
      expect(result.output.verdict).toBe("failed");
      expect(JSON.stringify(result.output)).toContain("no reply was written");
      const record = JSON.parse(
        readFileSync(join(result.output.folder!, "run.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(record.verdict).toBe("failed");
      if (role === "tester") {
        writeFileSync(join(f.root, "mode"), "ok");
        const retry = await f.runRole(role, ["--round-cap", "1"]);
        expect(retry.code).toBe(0);
        expect(
          JSON.parse(
            readFileSync(join(retry.output.folder!, "run.json"), "utf8"),
          ),
        ).toMatchObject({ round: 1, verdict: "completed" });
        expect(f.attempts()).toHaveLength(2);
      }
    });

test("auto treats a missing tester verdict as failure", () => {
  const f = autoFixture("auto-missing");
  const result = f.auto(["--round-cap", "1"]);
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "round-cap",
  });
  expect(result.lines[1]).toMatchObject({ step: "tester", verdict: "FAIL" });
  expect(f.roles()).toEqual(["builder", "tester"]);
});

test("auto does not trust tester or reviewer reports from another head", () => {
  const f = autoFixture("auto-clean");
  const head = f.head();
  for (const [role, round, text] of [
    ["tester", 1, "Verdict: PASS"],
    ["reviewer", null, "Verdict: CLEAN"],
  ] as const) {
    const record = f.seed(role, round, "completed", text);
    writeFileSync(
      join(record.reply, "..", "run.json"),
      JSON.stringify({ ...record, head }),
    );
  }
  change(f, ["tools/changed.ts"]);
  expect(f.auto().code).toBe(0);
  expect(f.roles()).toEqual(["tester", "reviewer"]);
});

for (const role of ["tester", "reviewer"])
  test(`auto retests when HEAD moves during the ${role} run`, () => {
    const f = autoFixture(`auto-move-${role}`);
    change(f, role === "reviewer" ? ["tools/changed.ts"] : ["docs/guide.md"]);
    const startHead = f.head();
    const result = f.auto();
    const runs = (
      f.run(["list"]).lines[0] as {
        lanes: { runs: { role: string; head: string }[] }[];
      }
    ).lanes[0]!.runs;
    expect(runs.find((run) => run.role === role)!.head).toBe(startHead);
    expect(f.head()).not.toBe(startHead);
    expect(f.roles()).toEqual(
      role === "tester"
        ? ["tester", "tester"]
        : ["tester", "reviewer", "tester", "reviewer"],
    );
    expect(result.code).toBe(0);
    expect(result.lines.at(-1)).toMatchObject({
      outcome: "ready",
      head: f.head(),
    });
  });

test("auto counts stale tester results against the round cap", () => {
  const f = autoFixture("auto-move-always-tester");
  change(f, ["docs/guide.md"]);
  const result = f.auto();
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "round-cap",
    step: "tester",
  });
  expect(f.roles()).toEqual(["tester", "tester"]);
});

test("auto includes a reviewer report starting at the preceding tester end", () => {
  const f = autoFixture("auto-pass");
  change(f, ["tools/changed.ts"]);
  const tester = f.seed("tester", 1, "completed", "Verdict: PASS");
  const review = f.seed(
    "reviewer",
    null,
    "completed",
    "Verdict: ACT\nP1: missed finding.",
  );
  writeFileSync(
    join(review.reply, "..", "run.json"),
    JSON.stringify({ ...review, start: tester.end }),
  );
  const fix = f.seed("fixer", null, "completed", "Committed.");
  writeFileSync(
    join(fix.reply, "..", "run.json"),
    JSON.stringify({ ...fix, head: f.head() }),
  );
  expect(f.auto().code).toBe(0);
  expect(f.roles()).toEqual(["tester"]);
  expect(f.prompt()).toContain(review.reply.replaceAll("\\", "/"));
  expect(f.prompt()).toContain("verify every P0/P1 finding");
});

test("auto requires a passing tester before accepting a standalone clean reviewer", () => {
  const f = autoFixture("auto-clean");
  change(f, ["tools/changed.ts"]);
  const record = f.seed("reviewer", null, "completed", "Verdict: CLEAN");
  writeFileSync(
    join(record.reply, "..", "run.json"),
    JSON.stringify({ ...record, head: f.head() }),
  );
  expect(f.auto().code).toBe(0);
  expect(f.roles()).toEqual(["tester", "reviewer"]);
});

test("auto review repair respects the tester cap", () => {
  const f = autoFixture("auto-act");
  change(f, ["tools/changed.ts"]);
  const result = f.auto(["--round-cap", "1"]);
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatchObject({
    outcome: "blocked",
    reason: "round-cap",
    step: "tester",
  });
  expect(f.roles()).toEqual(["tester", "reviewer", "fixer"]);
});

test("auto re-reviews when new commits follow the review fixer", () => {
  const f = autoFixture("auto-clean");
  for (const role of ["reviewer", "fixer"]) {
    const record = f.seed(role, null, "completed", "Verdict: ACT");
    writeFileSync(
      join(record.reply, "..", "run.json"),
      JSON.stringify({ ...record, head: f.head() }),
    );
  }
  change(f, ["tools/another-change.ts"]);
  expect(f.auto().code).toBe(0);
  expect(f.roles()).toEqual(["tester", "reviewer"]);
});

for (const kind of ["refused", "failed", "timeout"])
  test(`auto stops on ${kind} rather than advancing the chain`, () => {
    const f = autoFixture(
      kind === "failed" ? "fail" : kind === "timeout" ? "timeout" : "auto-pass",
    );
    if (kind === "refused")
      writeFileSync(
        f.config,
        readFileSync(f.config, "utf8").replace(
          "harness: codex",
          "harness: unavailable",
        ),
      );
    const result = f.auto();
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatchObject({
      outcome: "blocked",
      reason: kind,
      step: "builder",
    });
    expect(f.roles()).toHaveLength(kind === "refused" ? 0 : 1);
  });

for (const flags of [
  ["--round-cap", "0"],
  ["--round-cap"],
  ["--round-cap", "11"],
  ["--bad", "2"],
  ["--round-cap", "2", "--round-cap", "2"],
])
  test(`auto refuses invalid flags ${flags.join(" ")}`, () => {
    const f = autoFixture();
    const result = f.auto(flags);
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatchObject({
      outcome: "blocked",
      reason: "refused",
    });
    expect(f.roles()).toEqual([]);
  });

for (const [files, tier, because, reviews] of [
  [[], "light", "no changes", ["tester", "github-codex"]],
  [["docs/guide.md"], "light", "docs/guide.md", ["tester", "github-codex"]],
  [["test/a.test.ts"], "light", "test/a.test.ts", ["tester", "github-codex"]],
  [
    ["tools/a.ts"],
    "code",
    "tools/a.ts",
    ["tester", "reviewer", "github-codex"],
  ],
  [
    ["src/core/trust/a.ts"],
    "security",
    "src/core/trust/a.ts",
    ["tester", "reviewer", "security-reviewer", "github-codex"],
  ],
  [
    ["docs/a.md", "tools/a.ts", "src/core/trust/z.ts", "src/core/trust/a.ts"],
    "security",
    "src/core/trust/a.ts",
    ["tester", "reviewer", "security-reviewer", "github-codex"],
  ],
] as const)
  test(`tier CLI classifies ${files.join(", ") || "no changes"} from the existing lane registry`, () => {
    const f = fixture();
    f.start();
    if (files.length) change(f, [...files]);
    const registry = JSON.parse(
      readFileSync(join(f.main, ".git", "forge-lanes.json"), "utf8"),
    ) as Record<string, unknown>[];
    expect(Object.hasOwn(registry[0]!, "tier")).toBe(false);
    const result = f.run(["tier", "one"]);
    expect(result.output as unknown).toEqual({
      tier,
      because,
      reviews: [...reviews],
    });
    expect(result.code).toBe(0);
    expect(f.attempts()).toEqual([]);
  });

test("tier CLI uses trusted origin/main policy and committed merge-base diff, including dotfiles", () => {
  const f = fixture();
  f.trust(
    `values:\n  lanes:\n    tiers:\n      security: ["docs/**", ".github/**"]\n      code: ["tools/**"]\n`,
  );
  const lane = f.start();
  change(f, ["docs/policy.md", "tools/a.ts", ".github/check.yml"]);
  writeFileSync(join(lane, "package.json"), "uncommitted security change");
  mkdirSync(join(f.main, ".github"));
  writeFileSync(join(f.main, ".github", "aaa.yml"), "Upstream.");
  f.git(["add", ".github/aaa.yml"]);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "upstream",
  ]);
  f.git(["push", "origin", "main"]);
  f.git(["fetch", "origin", "main"]);
  const result = f.run(["tier", "one"]);
  expect(result.output).toMatchObject({
    tier: "security",
    because: ".github/check.yml",
  });
  expect(result.code).toBe(0);
});

for (const policy of [
  "",
  "    tiers: {}\n",
  "    tiers: {security: [], code: [], typo: []}\n",
  "    tiers: {security: [42], code: []}\n",
  "    tiers: {security: ['[broken'], code: []}\n",
  "    tiers: {security: ['{broken'], code: []}\n",
  "    tiers: {security: [''], code: []}\n",
])
  test(`tier policy refusal prevents launch: ${policy.trim() || "missing tiers"}`, () => {
    const f = fixture();
    f.start();
    f.trust(`values:\n  lanes:\n${policy}`);
    const result = f.run(["run", "one", "--role", "builder"]);
    expect(result.output.verdict).toBe("refused");
    expect(result.code).toBe(1);
    expect(result.output.next).toContain("tiers");
    expect(f.attempts()).toEqual([]);
    const inspection = f.run(["tier", "one"]);
    expect(inspection.output.verdict).toBe("refused");
    expect(inspection.code).not.toBe(0);
  });

for (const [from, to, because] of [
  ["src/core/trust/access.ts", "docs/access.ts", "src/core/trust/access.ts"],
  ["docs/access.ts", "src/core/trust/access.ts", "src/core/trust/access.ts"],
] as const)
  test(`tier rename counts both endpoints: ${from} to ${to}`, () => {
    const f = fixture();
    change(f, [from], f.main);
    f.git(["push", "origin", "main"]);
    f.git(["fetch", "origin", "main"]);
    const lane = f.start();
    mkdirSync(resolve(lane, to, ".."), { recursive: true });
    f.git(["mv", from, to], lane);
    f.git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "rename fixture",
      ],
      lane,
    );
    const result = f.run(["tier", "one"]);
    expect(result.output).toMatchObject({ tier: "security", because });
    expect(result.code).toBe(0);
  });

test("tier ordinary edit keeps its security classification", () => {
  const f = fixture();
  change(f, ["src/core/trust/access.ts"], f.main);
  f.git(["push", "origin", "main"]);
  f.git(["fetch", "origin", "main"]);
  const lane = f.start();
  writeFileSync(join(lane, "src/core/trust/access.ts"), "Ordinary edit.\n");
  f.git(["add", "src/core/trust/access.ts"], lane);
  f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "ordinary edit",
    ],
    lane,
  );
  const result = f.run(["tier", "one"]);
  expect(result.output).toMatchObject({
    tier: "security",
    because: "src/core/trust/access.ts",
  });
  expect(result.code).toBe(0);
});

function weakenedPolicyFixture() {
  const f = roleFixture();
  const lane = join(f.main, ".worktrees", "one");
  const weakened = readFileSync(f.config, "utf8").replace(
    tiers,
    "    tiers: {security: [], code: []}\n",
  );
  writeFileSync(join(lane, ".forge", "config.yaml"), weakened);
  change(f, ["src/core/trust/access.ts"]);
  f.git(["add", ".forge/config.yaml"], lane);
  f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "weaken lane policy",
    ],
    lane,
  );
  writeFileSync(join(f.main, ".forge", "config.yaml"), weakened);
  writeFileSync(
    f.config,
    weakened.replaceAll("fixture-model", "caller-review-model"),
  );
  return { ...f, lane };
}

test("tier ignores weakened local policy from main and lane invocation directories", () => {
  const f = weakenedPolicyFixture();
  const lane = f.lane;
  for (const cwd of [f.main, lane]) {
    const result = f.run(["tier", "one"], cwd);
    expect(result.output).toMatchObject({
      tier: "security",
      because: "src/core/trust/access.ts",
    });
    expect(result.code).toBe(0);
  }
});

test("tier reviewer uses trusted policy while preserving caller role model", async () => {
  const f = weakenedPolicyFixture();
  const reviewed = await f.runRole("reviewer");
  expect(reviewed.output).toMatchObject({
    tier: "security",
    model: "caller-review-model",
  });
  expect(f.prompt()).toContain(
    "Tier: security (because src/core/trust/access.ts).",
  );
  expect(f.prompt()).toContain("First write a three-line threat model");
  expectModel(f.attempts()[0]!, "caller-review-model");
  expect(reviewed.code).toBe(0);
});

for (const missing of ["origin/main", "trusted config"])
  test(`tier refuses missing ${missing} before launch`, () => {
    const f = fixture();
    f.start();
    if (missing === "origin/main")
      f.git(["update-ref", "-d", "refs/remotes/origin/main"]);
    else {
      f.git(["rm", ".forge/config.yaml"]);
      f.git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "remove trusted config",
      ]);
      f.git(["push", "origin", "main"]);
      f.git(["fetch", "origin", "main"]);
    }
    const result = f.run(["run", "one", "--role", "builder"]);
    expect(result.output.verdict).toBe("refused");
    expect(result.code).toBe(1);
    expect(f.attempts()).toEqual([]);
    const inspection = f.run(["tier", "one"]);
    expect(inspection.output.verdict).toBe("refused");
    expect(inspection.code).toBe(1);
  });

test("tier repository default policy makes a policy-only change security", () => {
  const f = fixture(
    readFileSync(
      resolve(import.meta.dirname, "../../.forge/config.yaml"),
      "utf8",
    ),
  );
  const lane = f.start();
  writeFileSync(
    join(lane, ".forge", "config.yaml"),
    `${readFileSync(join(lane, ".forge", "config.yaml"), "utf8")}\n# policy change\n`,
  );
  f.git(["add", ".forge/config.yaml"], lane);
  f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "policy-only change",
    ],
    lane,
  );
  const result = f.run(["tier", "one"]);
  expect(result.output).toMatchObject({
    tier: "security",
    because: ".forge/config.yaml",
  });
  expect(result.code).toBe(0);
});

for (const role of ["tester", "reviewer"])
  test(`tier is in ${role} brief, verdict and durable record`, async () => {
    const f = roleFixture();
    change(f, ["src/core/trust/access.ts"]);
    const result = await f.runRole(role);
    const prompt = f.prompt();
    expect(prompt).toContain(
      "Tier: security (because src/core/trust/access.ts). Reviews: tester, reviewer, security-reviewer, github-codex.",
    );
    expect(result.output.tier).toBe("security");
    expect(
      JSON.parse(readFileSync(join(result.output.folder!, "run.json"), "utf8")),
    ).toMatchObject({ tier: "security" });
    expect(result.code).toBe(0);
    if (role === "reviewer") {
      expect(prompt).toContain("First write a three-line threat model");
      expect(prompt).toContain("threat, cause, out of scope");
      expect(prompt).toContain("Review against that threat model");
      expect(f.attempts()[0]!.args).toContain('sandbox_mode="read-only"');
    }
  });

test("tier run keeps complete builder and fixer prompts identical", async () => {
  const f = roleFixture();
  change(f, ["tools/changed.ts"]);
  const expected = [
    readFileSync(template, "utf8"),
    "\nIssue:\n",
    JSON.stringify({
      ok: true,
      result: {
        id: "one",
        title: "Fixture issue title",
        body: "Fixture issue body: implement the requested lane.",
      },
    }),
    "\nLane contract (takes precedence):\n",
    readFileSync(f.brief, "utf8"),
  ].join("\n");
  for (const role of ["builder", "fixer"]) {
    const result = await f.runRole(role);
    expect(f.prompt()).toBe(expected);
    expect(result.output.tier).toBe("code");
    expect(result.code).toBe(0);
  }
});

test("tester round one uses its template, issue, contract, builder reply and durable metadata", async () => {
  const f = roleFixture();
  const builder = await f.runRole("builder");
  const result = await f.runRole("tester");
  expect(result.code).toBe(0);
  expect(f.prompt()).toContain("You are the local tester");
  expect(f.prompt()).toContain("This is test round 1.");
  expect(f.prompt()).toContain(builder.output.reply!.replaceAll("\\", "/"));
  expect(f.prompt()).toContain("Fixture issue title");
  expect(f.prompt()).toContain(readFileSync(f.brief, "utf8"));
  expect(f.prompt()).toContain("FORGE_CANARY_BUN_DIR");
  expect(f.prompt()).toContain("FORGE_GH_USER");
  expect(f.prompt()).toContain("bun run test:changed");
  expect(f.prompt()).toContain(
    "every regression lane in .forge/config.yaml whose files the diff touches",
  );
  expect(f.prompt()).toContain("0 selected tests is not evidence");
  expect(f.prompt()).toContain("never replaces");
  expect(f.prompt()).toContain("acceptance tests");
  expect(f.prompt()).not.toContain("Run what CI runs");
  expect(f.prompt()).not.toMatch(
    /Personal-Projects|harshanandak|\{\{[A-Z]+\}\}/,
  );
  expect(
    JSON.parse(readFileSync(join(result.output.folder!, "run.json"), "utf8")),
  ).toMatchObject({
    role: "tester",
    round: 1,
    model: "fixture-model",
    effort: "high",
    verdict: "completed",
    session: "fake-session",
    reply: result.output.reply,
  });
});

test("tester round two names previous tester and only the subsequent newest fix", async () => {
  const f = roleFixture();
  f.seed("builder", null);
  const previous = f.seed("tester", 1);
  const fix = f.seed("fixer", null);
  await f.runRole("tester");
  expect(f.prompt()).toContain(
    `This is test round 2. The previous report is ${previous.reply.replaceAll("\\", "/")} and the builder's fix reply is ${fix.reply.replaceAll("\\", "/")}.`,
  );
  expect(f.prompt()).toContain(
    "First re-run every earlier repro and say for each finding whether it is fixed. Then re-run the checks and look for regressions the fixes introduced. New findings are welcome.",
  );
});

test("third tester round refuses before launch, explicit caps permit three and reject bounds", async () => {
  const f = roleFixture();
  f.seed("tester", 1);
  f.seed("tester", 2);
  const result = await f.runRole("tester");
  expect(result.output.verdict).toBe("refused");
  expect(result.output.next).toBe(
    "Test round 3 exceeds the cap (2). Write a three-line threat model, then choose ship, simplify or park.",
  );
  expect(f.attempts()).toHaveLength(0);
  expect((await f.runRole("tester", ["--round-cap", "3"])).code).toBe(0);
  expect(f.prompt()).toContain("This is test round 3.");
  expect(f.prompt()).toContain(
    "No completed builder or fixer reply is available",
  );
  for (const cap of ["0", "11", "1.5"])
    expect(
      (await f.runRole("tester", ["--round-cap", cap])).output.next,
    ).toContain("integer from 1 to 10");
  expect(f.attempts()).toHaveLength(1);
});

test("review uses read-only template, exact lane diff and optional PR", async () => {
  const f = roleFixture();
  const laneDir = join(f.main, ".worktrees", "one");
  writeFileSync(join(laneDir, "review-change.txt"), "Lane change.");
  f.git(["add", "review-change.txt"], laneDir);
  f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "lane change",
    ],
    laneDir,
  );
  writeFileSync(join(f.main, "upstream-change.txt"), "Upstream change.");
  f.git(["add", "upstream-change.txt"]);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "upstream change",
  ]);
  f.git(["push", "origin", "main"]);
  f.git(["fetch", "origin", "main"]);
  const result = await f.runRole("reviewer", ["--pr", "42"]);
  expect(result.code).toBe(0);
  expect(f.prompt()).toContain("You are an independent code reviewer.");
  const lane = f.git(["rev-parse", "--show-toplevel"], f.attempts()[0]!.cwd);
  const base = f.git(["merge-base", "origin/main", "HEAD"], lane);
  const head = f.git(["rev-parse", "HEAD"], lane);
  expect(base).not.toBe(head);
  expect(base).not.toBe(f.git(["rev-parse", "origin/main"], lane));
  expect(f.prompt()).toContain(`git diff ${base}...${head}`);
  expect(f.prompt()).toContain("PR #42");
  expect(f.prompt()).toContain("at most 300 words");
  expect(f.prompt()).toContain("act on (P0/P1), consider and noted");
  expect(f.prompt()).toContain(readFileSync(f.brief, "utf8"));
  expect(f.attempts()[0]!.args).toContain('sandbox_mode="read-only"');
  expect(f.attempts()[0]!.args).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
  for (const pr of ["0", "-1", "1.5"])
    expect((await f.runRole("reviewer", ["--pr", pr])).code).toBe(1);
  expect((await f.runRole("reviewer")).code).toBe(0);
  expect(f.prompt()).toContain("You are an independent code reviewer.");
  expect(f.prompt()).not.toContain("PR #");
});

test("builder and fixer assembly remains byte-identical while every launch records metadata", async () => {
  const f = roleFixture();
  const result = await f.runRole("builder");
  const issue = {
    ok: true,
    result: {
      id: "one",
      title: "Fixture issue title",
      body: "Fixture issue body: implement the requested lane.",
    },
  };
  const expected = [
    readFileSync(template, "utf8"),
    "\nIssue:\n",
    JSON.stringify(issue),
    "\nLane contract (takes precedence):\n",
    readFileSync(f.brief, "utf8"),
  ].join("\n");
  expect(f.prompt()).toBe(expected);
  expect(existsSync(join(result.output.folder!, "run.json"))).toBe(true);
  const record = JSON.parse(
    readFileSync(join(result.output.folder!, "run.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(record.start).toMatch(/^\d{4}-/);
  expect(record.end).toMatch(/^\d{4}-/);
  expect(record.verdict).toBe("completed");
  expect((await f.runRole("fixer")).code).toBe(0);
  expect(f.prompt()).toBe(expected);
});

test("failed and empty tester records do not count, explicit prompts override templates", async () => {
  const f = roleFixture();
  const builder = f.seed("builder", null);
  const failedFix = f.seed("fixer", null, "failed");
  const emptyFix = f.seed("fixer", null, "completed", "  ");
  f.seed("tester", 1, "failed");
  f.seed("tester", 1, "completed", "  ");
  for (const mode of ["empty", "fail"]) {
    writeFileSync(join(f.root, "mode"), mode);
    const failed = await f.runRole("tester");
    expect(failed.output.verdict).toBe("failed");
    const record = JSON.parse(
      readFileSync(join(failed.output.folder!, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      role: "tester",
      round: 1,
      verdict: "failed",
      session: "fake-session",
    });
    expect(record.end).toMatch(/^\d{4}-/);
  }
  writeFileSync(join(f.root, "mode"), "ok");
  await f.runRole("tester");
  expect(f.prompt()).toContain("This is test round 1.");
  expect(f.prompt()).toContain(builder.reply.replaceAll("\\", "/"));
  expect(f.prompt()).not.toContain(failedFix.reply.replaceAll("\\", "/"));
  expect(f.prompt()).not.toContain(emptyFix.reply.replaceAll("\\", "/"));
  const custom = join(f.root, "custom-role.md");
  writeFileSync(custom, "Exact tester override.\n");
  expect((await f.runRole("tester", ["--prompt", custom])).code).toBe(0);
  expect(f.prompt()).toBe("Exact tester override.\n");
});

test("list reports per-lane durable role, round, verdict and reply history", () => {
  const f = roleFixture();
  const record = f.seed("tester", 7);
  const result = f.run(["list"]);
  expect(result.output).toMatchObject({
    lanes: [
      {
        issue: "one",
        runs: [
          {
            role: "tester",
            round: 7,
            verdict: "completed",
            reply: record.reply,
          },
        ],
      },
    ],
  });
});

function unknownRun(
  f: ReturnType<typeof roleFixture>,
  name: string,
  contents?: string,
) {
  const folder = join(f.runs, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "reply.md"),
    "Unclassified reply must never be trusted.",
  );
  if (contents !== undefined) writeFileSync(join(folder, "run.json"), contents);
  return folder;
}
function unknownRows(f: ReturnType<typeof roleFixture>) {
  const result = f.run(["list"]);
  expect(result.code).toBe(0);
  return (
    result.output as unknown as {
      lanes: { runs: { role: string; folder?: string }[] }[];
    }
  ).lanes[0]!.runs.filter((run) => run.role === "unknown");
}

test("unknown history legacy-count fails closed, allows explicit cap and never invents prior replies", async () => {
  const f = roleFixture();
  const folders = [unknownRun(f, "old-builder"), unknownRun(f, "old-tester")];
  const refused = await f.runRole("tester");
  expect(refused.output.verdict).toBe("refused");
  expect(refused.output.next).toBe(
    "Test round 3 exceeds the cap (2). Write a three-line threat model, then choose ship, simplify or park.",
  );
  for (const folder of folders)
    expect(JSON.stringify(refused.output)).toContain(
      folder.replaceAll("\\", "\\\\"),
    );
  expect(f.attempts()).toHaveLength(0);
  expect(
    unknownRows(f)
      .map((run) => run.folder)
      .sort(),
  ).toEqual(folders.sort());
  const override = await f.runRole("tester", ["--round-cap", "3"]);
  expect(override.code).toBe(0);
  expect(f.prompt()).toContain("This is test round 3.");
  expect(f.prompt()).toContain(
    "No completed builder or fixer reply is available",
  );
  expect(f.prompt()).not.toContain("The previous report is");
  for (const folder of folders)
    expect(f.prompt()).not.toContain(
      join(folder, "reply.md").replaceAll("\\", "/"),
    );
});

test("unknown history truncated and unreadable records list without blocking other roles", async () => {
  const f = roleFixture();
  const truncated = unknownRun(f, "truncated", "{");
  const unreadable = unknownRun(f, "unreadable");
  mkdirSync(join(unreadable, "run.json"));
  expect(
    unknownRows(f)
      .map((run) => run.folder)
      .sort(),
  ).toEqual([truncated, unreadable].sort());
  for (const role of ["builder", "fixer", "reviewer"])
    expect((await f.runRole(role)).code).toBe(0);
  const refused = await f.runRole("tester");
  expect(refused.output.verdict).toBe("refused");
  expect(refused.output.next).toContain("Test round 3 exceeds the cap (2).");
  expect(f.attempts()).toHaveLength(3);
});

test("unknown history missing record counts alongside classified testers and custom prompts", async () => {
  const f = roleFixture();
  f.seed("tester", 1);
  const missing = unknownRun(f, "missing");
  const custom = join(f.root, "custom-unknown.md");
  writeFileSync(custom, "Exact unknown-history override.\n");
  const refused = await f.runRole("tester", ["--prompt", custom]);
  expect(refused.output.verdict).toBe("refused");
  expect(refused.output.next).toContain("Test round 3 exceeds the cap (2).");
  expect(unknownRows(f)).toEqual([{ role: "unknown", folder: missing }]);
  const override = await f.runRole("tester", [
    "--round-cap",
    "3",
    "--prompt",
    custom,
  ]);
  expect(override.code).toBe(0);
  expect(f.prompt()).toBe("Exact unknown-history override.\n");
  expect(
    JSON.parse(
      readFileSync(join(override.output.folder!, "run.json"), "utf8"),
    ) as Record<string, unknown>,
  ).toMatchObject({ role: "tester", round: 3 });
});

test("unknown history noninteger and missing tester rounds never classify as completed testers", async () => {
  const f = roleFixture();
  const rounds: unknown[] = [1.5, 0, 11, null, undefined, "1"];
  const folders = rounds.map((round) => {
    const record = f.seed("tester", 1);
    const folder = join(record.reply, "..");
    writeFileSync(
      join(folder, "run.json"),
      JSON.stringify({ ...record, round }),
    );
    return resolve(folder);
  });
  expect(
    unknownRows(f)
      .map((run) => run.folder)
      .sort(),
  ).toEqual(folders.sort());
  const refused = await f.runRole("tester");
  expect(refused.output.verdict).toBe("refused");
  expect(refused.output.next).toContain("Test round 7 exceeds the cap (2).");
  expect(f.attempts()).toHaveLength(0);
});

test("unknown history wrongrole rejects unknown roles and non-tester rounds", async () => {
  const f = roleFixture();
  const roles = ["builder", "fixer", "reviewer", "unrecognized"];
  const folders = roles.map((role) => {
    const record = f.seed(role, role === "unrecognized" ? null : 1);
    return resolve(record.reply, "..");
  });
  expect(
    unknownRows(f)
      .map((run) => run.folder)
      .sort(),
  ).toEqual(folders.sort());
  const allowed = await f.runRole("tester", ["--round-cap", "5"]);
  expect(allowed.code).toBe(0);
  expect(f.prompt()).toContain("This is test round 5.");
  expect(f.prompt()).toContain(
    "No completed builder or fixer reply is available",
  );
  expect(f.prompt()).not.toContain("The previous report is");
  for (const folder of folders)
    expect(f.prompt()).not.toContain(
      join(folder, "reply.md").replaceAll("\\", "/"),
    );
});

test("run records retain the old complete JSON when atomic publication is interrupted", () => {
  const f = roleFixture();
  const before = join(f.root, "before-publication.json");
  const helper = join(f.root, "interrupted-publish.ts");
  writeFileSync(
    helper,
    `import {mock} from 'bun:test';import fs from 'node:fs';const native={...fs};let injected=false;mock.module('node:fs',()=>({...native,renameSync:(from,to)=>{if(String(to).endsWith('run.json')&&native.existsSync(to)&&!injected){injected=true;native.writeFileSync(${JSON.stringify(before)},native.readFileSync(to));throw new Error('injected publication interruption');}return native.renameSync(from,to);}}));const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  const result = f.run(["run", "one", "--role", "builder"], f.caller, helper);
  expect(existsSync(before)).toBe(true);
  expect(
    JSON.parse(readFileSync(before, "utf8")) as Record<string, unknown>,
  ).toMatchObject({ verdict: "started", end: null });
  expect(result.code).toBe(1);
  expect(
    JSON.parse(
      readFileSync(join(result.output.folder!, "run.json"), "utf8"),
    ) as Record<string, unknown>,
  ).toMatchObject({ verdict: "failed" });
});

function detachProbe(f: ReturnType<typeof autoFixture>, handoff = "") {
  const helper = join(f.root, "detach-probe.ts"),
    pidFile = join(f.root, "detached-pid");
  writeFileSync(
    helper,
    `import {mock} from 'bun:test';import fs from 'node:fs';const native={...fs};mock.module('node:fs',()=>({...native,renameSync:(from,to)=>{const match=String(to).match(/owner-.*-(\\d+)$/);if(match){native.writeFileSync(${JSON.stringify(pidFile)},match[1]);${handoff}}return native.renameSync(from,to);}}));const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  return { helper, pid: () => Number(readFileSync(pidFile, "utf8")) };
}

test("detach validates child issue lookup taking longer than five seconds", async () => {
  const f = autoFixture("auto-clean"),
    probe = detachProbe(f),
    forge = join(f.root, "fake-forge.mjs"),
    started = Date.now();
  writeFileSync(
    forge,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(f.root, "startup-pid"))},String(process.pid));await new Promise(done=>setTimeout(done,5500));${readFileSync(forge, "utf8")}`,
  );
  try {
    const result = await f.launch(probe.helper, false, [
      "auto",
      "one",
      "--detach",
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      outcome: "detached",
      validated: true,
    });
    expect(Date.now() - started).toBeGreaterThan(5_000);
  } finally {
    // The slow issue lookup is a second process of the detached tree. Both must
    // exit before afterEach removes the root, or Windows reports EBUSY.
    const tree = [probe.pid()];
    const startupPid = join(f.root, "startup-pid");
    if (existsSync(startupPid))
      tree.push(Number(readFileSync(startupPid, "utf8")));
    for (const pid of tree) killFixture(pid, true);
    await waitForProcess("detached process tree exit", () =>
      tree.every((pid) => !alive(pid)),
    );
    expect(tree.filter(alive)).toEqual([]);
  }
});

test.skipIf(process.platform !== "win32")(
  "fixture cleanup ends the detached chain and its harness before the root is removed",
  async () => {
    const f = autoFixture("auto-slow");
    const launched = await f.launch(script, false, ["auto", "one", "--detach"]);
    const { pid } = launched.output as unknown as { pid: number };
    let harness = 0;
    try {
      await waitForProcess("detached harness", () =>
        existsSync(join(f.root, "harness-pid")),
      );
      harness = Number(readFileSync(join(f.root, "harness-pid"), "utf8"));
      expect([pid, harness].filter(alive)).toEqual([pid, harness]);
      await children.cleanup(() => {});
      expect(
        [pid, harness].filter(alive),
        "processes still alive after fixture cleanup",
      ).toEqual([]);
    } finally {
      for (const live of [pid, harness].filter((item) => item && alive(item)))
        killFixture(live, true);
    }
  },
);

test("detach reclaims the lock when the parent dies before handoff", async () => {
  const f = autoFixture("auto-clean"),
    probe = detachProbe(f, "process.exit(73);");
  const result = await f.launch(probe.helper, true, [
    "auto",
    "one",
    "--detach",
  ]);
  try {
    expect(result.code).toBe(73);
    await waitForProcess(
      "orphaned child completion",
      () => !alive(probe.pid()),
    );
    const log = readdirSync(f.runs).find((name) => name.endsWith(".log"))!;
    expect(readFileSync(join(f.runs, log), "utf8")).toContain(
      '"outcome":"ready"',
    );
    expect(f.roles()).toEqual(["builder", "tester"]);
    expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
  } finally {
    killFixture(probe.pid(), true);
  }
});

test("detach reclaims after parent death even when its polled PID stays alive", async () => {
  const f = autoFixture("auto-clean"),
    probe = detachProbe(f, "process.exit(73);"),
    inherited = join(f.root, "inherited-owner");
  // Keep the old liveness probe alive without changing the dead lock owner.
  writeFileSync(
    probe.helper,
    `import childProcess from 'node:child_process';const nativeChild={...childProcess};mock.module('node:child_process',()=>({...nativeChild,spawn:(command,args,options)=>{if(options?.env?.FORGE_LANE_LOCK_OWNER){options={...options,env:{...options.env,FORGE_LANE_LOCK_OWNER:options.env.FORGE_LANE_LOCK_OWNER.replace(/^owner-\\d+-/,'owner-${process.pid}-')}};fs.writeFileSync(${JSON.stringify(inherited)},options.env.FORGE_LANE_LOCK_OWNER);}return nativeChild.spawn(command,args,options);}}));${readFileSync(probe.helper, "utf8")}`,
  );
  const result = await f.launch(probe.helper, true, [
    "auto",
    "one",
    "--detach",
  ]);
  try {
    expect(result.code).toBe(73);
    expect(readFileSync(inherited, "utf8")).toStartWith(
      `owner-${process.pid}-`,
    );
    await waitForProcess(
      "orphan reclaim despite a live recycled parent PID",
      () => !alive(probe.pid()),
    );
    const log = readdirSync(f.runs).find((name) => name.endsWith(".log"))!;
    expect(readFileSync(join(f.runs, log), "utf8")).toContain(
      '"outcome":"ready"',
    );
    expect(f.roles()).toEqual(["builder", "tester"]);
    expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
  } finally {
    killFixture(probe.pid(), true);
  }
});

test("detach reports a configured readiness stall and leaves the child alive", async () => {
  const f = autoFixture("auto-clean"),
    probe = detachProbe(f),
    marker = join(f.root, "issue-started"),
    finish = join(f.root, "finish-startup"),
    forge = join(f.root, "fake-forge.mjs");
  writeFileSync(
    f.config,
    readFileSync(f.config, "utf8").replace(
      "  lanes:\n",
      "  lanes:\n    stallMinutes: 1\n",
    ),
  );
  writeFileSync(
    forge,
    `import {existsSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(f.root, "startup-pid"))},String(process.pid));writeFileSync(${JSON.stringify(marker)},'started');while(!existsSync(${JSON.stringify(finish)}))await new Promise(done=>setTimeout(done,20));${readFileSync(forge, "utf8")}`,
  );
  writeFileSync(
    probe.helper,
    `import {existsSync} from 'node:fs';const now=Date.now;Date.now=()=>now()+(existsSync(${JSON.stringify(marker)})?60000:0);${readFileSync(probe.helper, "utf8")}`,
  );
  try {
    const result = await f.launch(probe.helper, false, [
      "auto",
      "one",
      "--detach",
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      outcome: "detached",
      validated: false,
      stalled: true,
      pid: probe.pid(),
    });
    expect(alive(probe.pid())).toBe(true);
    expect(f.attempts()).toHaveLength(0);
    writeFileSync(finish, "continue");
    await waitForProcess("stalled child completion", () => !alive(probe.pid()));
    expect(readFileSync(result.output.log!, "utf8")).toContain(
      '"outcome":"ready"',
    );
  } finally {
    killFixture(probe.pid(), true);
    const startupPid = join(f.root, "startup-pid");
    if (existsSync(startupPid))
      killFixture(Number(readFileSync(startupPid, "utf8")));
    await waitForProcess("stalled child cleanup", () => !alive(probe.pid()));
  }
});

test("detach waits for a deliberately delayed parent lock handoff", async () => {
  const f = autoFixture("auto-clean");
  const helper = join(f.root, "delayed-handoff.ts");
  writeFileSync(
    helper,
    `import {mock} from 'bun:test';import fs from 'node:fs';const native={...fs};mock.module('node:fs',()=>({...native,renameSync:(from,to)=>{if(/owner-.*-\\d+$/.test(String(to)))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);return native.renameSync(from,to);}}));const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  const result = await f.launch(helper, false, ["auto", "one", "--detach"]);
  const { pid, log } = result.output as unknown as { pid: number; log: string };
  try {
    expect(result.code).toBe(0);
    await waitForProcess("detached decision", () =>
      /"outcome":"(ready|blocked)"/.test(readFileSync(log, "utf8")),
    );
    expect(readFileSync(log, "utf8")).not.toContain('"outcome":"blocked"');
    await waitForProcess("detached exit", () => !alive(pid));
  } finally {
    if (pid) killFixture(pid, true);
  }
});

for (const reason of [
  "round-cap",
  "unknown-history",
  "no-commit",
  "invalid-role",
])
  test(`detach returns the child's ${reason} refusal before reporting success`, () => {
    const f = autoFixture("auto-clean");
    if (reason === "round-cap") {
      change(f, ["docs/guide.md"]);
      f.seed("tester", 1, "completed", "Verdict: FAIL");
    } else if (reason === "unknown-history") unknownRun(f, "unclassified");
    else if (reason === "invalid-role") writeFileSync(f.config, "{}");
    else f.seed("builder", null);
    const result = f.auto(["--round-cap", "1", "--detach"]);
    try {
      expect(result.code).toBe(1);
      expect(result.lines[0]).toMatchObject({
        outcome: "blocked",
        reason: ["unknown-history", "invalid-role"].includes(reason)
          ? "refused"
          : reason,
      });
      expect(f.attempts()).toHaveLength(0);
    } finally {
      const pid = (result.output as unknown as { pid?: number }).pid;
      if (pid) killFixture(pid, true);
    }
  });

test("list never locks idle history during 25 concurrent detached autos", async () => {
  const f = autoFixture("auto-clean");
  expect(f.auto().code).toBe(0);
  const topology = cliTopologyFixture({ ...f, script });
  const helper = join(f.root, "slow-list-lock.ts"),
    autoHelper = join(f.root, "auto-topology.ts"),
    marker = join(f.root, "list-lock-attempt");
  writeFileSync(
    helper,
    `${topology.setup}import {mock} from 'bun:test';import fs from 'node:fs';const native={...fs};mock.module('node:fs',()=>({...native,renameSync:(from,to)=>{const result=native.renameSync(from,to);if(String(to).endsWith('forge-lane-one.lock')){native.writeFileSync(${JSON.stringify(marker)},'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);}return result;}}));const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  writeFileSync(
    autoHelper,
    `${topology.setup}const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
  );
  let refusals = 0;
  const detached: number[] = [];
  for (let i = 0; i < 25; i++) {
    const listing = f.launch(helper, false, ["list"]);
    let competing: ReturnType<typeof f.launch> | undefined;
    let detachedPid: number | undefined;
    try {
      // The old list implementation holds its lock here; the fixed list finishes.
      await Promise.race([
        listing,
        waitForProcess(
          "list lock or exit",
          () => existsSync(marker) || listing.child.exitCode !== null,
        ),
      ]);
      competing = f.launch(autoHelper, false, ["auto", "one", "--detach"]);
      const result = await competing;
      expect((await listing).code).toBe(0);
      if (result.code !== 0) refusals++;
      else {
        const { pid } = result.output as unknown as { pid: number };
        expect(pid).toBeGreaterThan(0);
        detachedPid = pid;
        detached.push(pid);
        await waitForProcess("auto exit", () => !alive(pid));
      }
      rmSync(marker, { force: true });
    } finally {
      for (const launched of [listing, competing])
        if (
          launched?.child.pid &&
          launched.child.exitCode === null &&
          launched.child.signalCode === null
        )
          killFixture(launched.child.pid, launched === competing);
      await Promise.allSettled(competing ? [listing, competing] : [listing]);
      const orphan = detachedPid;
      if (orphan && alive(orphan)) {
        killFixture(orphan, true);
        await waitForProcess("detached cleanup", () => !alive(orphan));
      }
    }
  }
  expect(refusals).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(detached).toHaveLength(25);
  expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
  topology.verify();
  const cachedCalls = readFileSync(topology.calls, "utf8")
    .trim()
    .split("\n").length;
  console.info(
    `list/auto fixture: kept 75 CLI processes; reused ${cachedCalls} topology reads with 4 setup and 4 verification Git children`,
  );
});

for (const operation of ["reclaim", "rename"])
  test(`list exposes ${operation} lock failures on the stale lane entry`, () => {
    const f = roleFixture();
    const record = f.seed("builder", null, "started");
    writeFileSync(
      join(record.reply, "..", "run.json"),
      JSON.stringify({ ...record, end: null }),
    );
    const lock = join(f.main, ".git", "forge-lane-one.lock");
    mkdirSync(lock);
    childLaunches++;
    const dead = spawnSync(process.execPath, ["-e", ""], {
      timeout: 5_000,
      windowsHide: true,
    });
    expect(dead.status).toBe(0);
    const owner = join(lock, `owner-${dead.pid}-${randomUUID()}`);
    writeFileSync(owner, "");
    const helper = join(f.root, "lock-error.ts");
    writeFileSync(
      helper,
      `import {mock} from 'bun:test';import fs from 'node:fs';const native={...fs};mock.module('node:fs',()=>({...native,${operation === "reclaim" ? "unlinkSync" : "renameSync"}:(from,...args)=>{if(${operation === "reclaim" ? `String(from)===${JSON.stringify(owner)}` : `String(args[0])===${JSON.stringify(lock)}`})throw Object.assign(new Error('injected ${operation} denied'),{code:'EACCES'});return native.${operation === "reclaim" ? "unlinkSync" : "renameSync"}(from,...args);}}));const {main}=await import(${JSON.stringify(script)});process.exitCode=await main();`,
    );
    const result = f.run(["list"], f.caller, helper);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatchObject({
      lanes: [{ issue: "one", error: `injected ${operation} denied` }],
    });
    expect(
      JSON.parse(
        readFileSync(join(record.reply, "..", "run.json"), "utf8"),
      ) as unknown,
    ).toMatchObject({ verdict: "started" });
    expect(
      readdirSync(join(f.main, ".git")).filter((name) =>
        name.startsWith("forge-lane-one.lock."),
      ),
    ).toEqual([]);
  });

// Registration is synchronous even when Bun selects a focused subset to execute.
expect(caseNames).toHaveLength(129);
expect(
  createHash("sha256").update(JSON.stringify(caseNames)).digest("hex"),
).toBe("4154d0a0cc4a5a5c63b9f43320210cd81c98cf7fe24bb414842e00f24615edb0");
