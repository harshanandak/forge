// [integration] Real git worktrees and subprocesses; Forge and Codex are PATH fixtures.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
writeFileSync(join(root,'harness-pid'),String(process.pid));
if(mode==='capacity'||mode==='limit')console.log('session id: fake-session');else console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'}));
if(mode==='limit'||(mode==='capacity'&&count===0)){console.log('Selected model is at capacity');process.exit(1)}
const flag=args.findIndex(a=>a==='--output-last-message'||a==='-o');if(flag<0)process.exit(8);
writeFileSync(args[flag+1],mode==='empty'?'':'Fixture final reply.');
if(mode==='hold'){setInterval(()=>{if(existsSync(join(root,'finish')))process.exit(0)},10)}
else if(mode==='hang'){setInterval(()=>{},1000)}else process.exit(mode==='fail'?1:0);`,
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
  function run(args: string[], cwd = caller, entry = script) {
    const result = spawnSync(process.execPath, [entry, ...args], {
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
  function launch(entry = script, allowEmpty = false) {
    const child = spawn(
      process.execPath,
      [entry, "run", "one", "--role", "builder"],
      {
        cwd: caller,
        env,
        windowsHide: true,
        timeout: 20_000,
      },
    );
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
    launch,
    attempts,
    direct,
    git,
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

async function waitForProcess(ready: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!ready() && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  expect(ready()).toBe(true);
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
    await waitForProcess(() => existsSync(join(f.root, "harness-pid")));
    pid = Number(readFileSync(join(f.root, "harness-pid"), "utf8"));
    expect(first.child.kill("SIGKILL")).toBe(true);
    await first;
    expect(alive(pid)).toBe(true);
    writeFileSync(join(f.root, "mode"), "ok");
    second = f.run(["run", "one", "--role", "builder"]);
  } finally {
    writeFileSync(join(f.root, "finish"), "finish");
    await first;
    if (pid) await waitForProcess(() => !alive(pid));
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
    `import {existsSync} from 'node:fs';const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(f.root, "signal"))})){clearInterval(timer);process.emit('SIGTERM');}},20);await import(${JSON.stringify(script)});`,
  );
  const first = f.launch(emitted ? helper : script, true);
  let pid = 0;
  try {
    await waitForProcess(() => existsSync(join(f.root, "harness-pid")));
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
    await waitForProcess(() => !alive(pid));
    expect(existsSync(join(f.main, ".git", "forge-lane-one.lock"))).toBe(false);
  } finally {
    writeFileSync(join(f.root, "finish"), "finish");
    await first;
    if (pid) await waitForProcess(() => !alive(pid));
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
    `const now=Date.now;Date.now=()=>now()*1000;await import(${JSON.stringify(script)});`,
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

function roleFixture() {
  const f = fixture();
  f.start();
  writeFileSync(
    f.config,
    `values:
  lanes:
    roles:
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
  const runRole = (role: string, extra: string[] = []) =>
    f.run(["run", "one", "--role", role, ...extra]);
  const prompt = () => f.attempts().at(-1)!.prompt;
  return { ...f, runs, seed, runRole, prompt };
}

test("tester round one uses its template, issue, contract, builder reply and durable metadata", () => {
  const f = roleFixture();
  const builder = f.runRole("builder");
  const result = f.runRole("tester");
  expect(result.code).toBe(0);
  expect(f.prompt()).toContain("You are the local tester");
  expect(f.prompt()).toContain("This is test round 1.");
  expect(f.prompt()).toContain(builder.output.reply!.replaceAll("\\", "/"));
  expect(f.prompt()).toContain("Fixture issue title");
  expect(f.prompt()).toContain(readFileSync(f.brief, "utf8"));
  expect(f.prompt()).toContain("FORGE_CANARY_BUN_DIR");
  expect(f.prompt()).toContain("FORGE_GH_USER");
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

test("tester round two names previous tester and only the subsequent newest fix", () => {
  const f = roleFixture();
  f.seed("builder", null);
  const previous = f.seed("tester", 1);
  const fix = f.seed("fixer", null);
  f.runRole("tester");
  expect(f.prompt()).toContain(
    `This is test round 2. The previous report is ${previous.reply.replaceAll("\\", "/")} and the builder's fix reply is ${fix.reply.replaceAll("\\", "/")}.`,
  );
  expect(f.prompt()).toContain(
    "First re-run every earlier repro and say for each finding whether it is fixed. Then re-run the checks and look for regressions the fixes introduced. New findings are welcome.",
  );
});

test("third tester round refuses before launch, explicit caps permit three and reject bounds", () => {
  const f = roleFixture();
  f.seed("tester", 1);
  f.seed("tester", 2);
  const result = f.runRole("tester");
  expect(result.output.verdict).toBe("refused");
  expect(result.output.next).toBe(
    "Test round 3 exceeds the cap (2). Write a three-line threat model, then choose ship, simplify or park.",
  );
  expect(f.attempts()).toHaveLength(0);
  expect(f.runRole("tester", ["--round-cap", "3"]).code).toBe(0);
  expect(f.prompt()).toContain("This is test round 3.");
  for (const cap of ["0", "11", "1.5"])
    expect(f.runRole("tester", ["--round-cap", cap]).output.next).toContain(
      "integer from 1 to 10",
    );
  expect(f.attempts()).toHaveLength(1);
});

test("review uses read-only template, exact lane diff and optional PR", () => {
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
  const result = f.runRole("reviewer", ["--pr", "42"]);
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
    expect(f.runRole("reviewer", ["--pr", pr]).code).toBe(1);
  expect(f.runRole("reviewer").code).toBe(0);
  expect(f.prompt()).toContain("You are an independent code reviewer.");
  expect(f.prompt()).not.toContain("PR #");
});

test("builder and fixer assembly remains byte-identical while every launch records metadata", () => {
  const f = roleFixture();
  const result = f.runRole("builder");
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
  expect(f.runRole("fixer").code).toBe(0);
  expect(f.prompt()).toBe(expected);
});

test("failed and empty tester records do not count, explicit prompts override templates", () => {
  const f = roleFixture();
  const builder = f.seed("builder", null);
  const failedFix = f.seed("fixer", null, "failed");
  const emptyFix = f.seed("fixer", null, "completed", "  ");
  f.seed("tester", 1, "failed");
  f.seed("tester", 1, "completed", "  ");
  for (const mode of ["empty", "fail"]) {
    writeFileSync(join(f.root, "mode"), mode);
    const failed = f.runRole("tester");
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
  f.runRole("tester");
  expect(f.prompt()).toContain("This is test round 1.");
  expect(f.prompt()).toContain(builder.reply.replaceAll("\\", "/"));
  expect(f.prompt()).not.toContain(failedFix.reply.replaceAll("\\", "/"));
  expect(f.prompt()).not.toContain(emptyFix.reply.replaceAll("\\", "/"));
  const custom = join(f.root, "custom-role.md");
  writeFileSync(custom, "Exact tester override.\n");
  expect(f.runRole("tester", ["--prompt", custom]).code).toBe(0);
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
