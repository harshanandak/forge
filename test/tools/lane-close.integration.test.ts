// [integration] Real local git repositories; Forge, GitHub and cleanup failures are PATH fixtures.
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
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
type Call = {
  command: string;
  args: string[];
  input?: Record<string, unknown>;
};
type Receipt = {
  id: string;
  status: string;
  subject: string;
  checked: { name: string; status: string }[];
};
type State = {
  issue: { id: string; title: string; status: string; receipt?: string };
  pr: {
    state: string;
    headRefName: string;
    headRefOid: string;
    mergeCommit: { oid: string } | null;
    url: string;
  };
  receipt: Receipt | null;
  links: { relation: string; url: string }[];
  comments: string[];
  fail?: string;
  hideClosed?: boolean;
  commitOnComment?: boolean;
};
function fixture() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-lane-close-")),
  );
  roots.push(root);
  const main = join(root, "main"),
    caller = join(root, "caller"),
    bin = join(root, "bin");
  mkdirSync(main);
  mkdirSync(bin);
  writeFileSync(join(main, "package.json"), '{"name":"lane-close-fixture"}');
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
  const realGit = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["git"],
    { env, encoding: "utf8", timeout: 10_000, windowsHide: true },
  )
    .stdout.trim()
    .split(/\r?\n/)[0]!;
  env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
  env.FORGE_DEVICE_ROOT = join(root, "device");
  env.FORGE_GH_USER = "fixture-owner";
  env.LANE_CLOSE_FIXTURE = root;
  env.LANE_CLOSE_REAL_GIT = realGit;
  const stateFile = join(root, "state.json");
  const callsFile = join(root, "calls.jsonl");
  const fake = join(root, "fake.mjs");
  writeFileSync(
    fake,
    String.raw`import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.env.LANE_CLOSE_FIXTURE,[command,...args]=process.argv.slice(2),file=join(root,'state.json');
const state=JSON.parse(readFileSync(file,'utf8'));
const inputIndex=args.indexOf('--input');const input=inputIndex<0?undefined:JSON.parse(args[inputIndex+1]);
appendFileSync(join(root,'calls.jsonl'),JSON.stringify({command,args,...(input?{input}:{})})+'\n');
const save=()=>writeFileSync(file,JSON.stringify(state));
const ok=result=>console.log(JSON.stringify({ok:true,op:args.slice(0,2).join('.'),status:'OK',result,warnings:[]}));
const record=(value,index)=>({namespace:'work',key:'fixture:'+index,revision:1,value,updatedAt:'2026-10-29T00:00:00.000Z',updatedBy:{kind:'human',id:'fixture'}});
if(command==='gh'){
 if(args[0]==='auth'&&args[1]==='token'){console.log('synthetic-fixture-auth');process.exit(0)}
 if(args[0]!=='pr'||args[1]!=='view')process.exit(93);
 if(process.env.GH_TOKEN!=='synthetic-fixture-auth')process.exit(96);
 if(state.fail==='gh')process.exit(1);
 if(state.fail==='gh-json'){console.log('{');process.exit(0)}
 console.log(JSON.stringify(state.pr));process.exit(0);
}
const op=args.slice(0,2).join('.');
if(state.fail===op){console.log(JSON.stringify({ok:false,op,status:'FAIL',error:{code:'FIXTURE_REFUSED',message:'injected '+op+' failure'}}));process.exit(1)}
switch(op){
 case 'issue.show':ok({...state.issue,...(state.hideClosed?{status:'open'}:{}),id:input.id});break;
 case 'check.show':ok(state.receipt===null?null:{...state.receipt,version:1,checkedAt:'2026-10-29T00:00:00.000Z',reason:'All selected checks passed',inputsDigest:'sha256:fixture-inputs',digest:'sha256:fixture-receipt',runs:state.receipt.checked.map(check=>({...check,argv:['fixture-check'],executable:'fixture-check',testCount:1,exitCode:0,signal:null,timedOut:false,truncated:false,stdout:'',stderr:'',stdoutEvidence:null,stderrEvidence:null,durationMs:1,reason:'Command passed'}))});break;
 case 'issue.links':ok({records:state.links.map((value,index)=>record({id:input.id,...value},index))});break;
 case 'issue.comments':ok({records:state.comments.map((body,index)=>record({id:input.id,body},index))});break;
 case 'issue.claim':ok({subject:'issue:'+input.id,generation:1,expiresAt:'2099-01-01T00:00:00.000Z',holder:{actor:{kind:'human',id:'fixture'},session:{id:'fixture'}}});break;
 case 'issue.owns':ok({id:input.id,owned:true});break;
 case 'issue.link':state.links.push({relation:input.relation,url:input.url});save();ok(record(input,state.links.length));break;
 case 'issue.close':state.issue.status='closed';state.issue.receipt=input.receipt;save();ok(state.issue);break;
 case 'issue.comment':state.comments.push(input.body);save();if(state.commitOnComment){const lane=join(root,'main','.worktrees','one');writeFileSync(join(lane,'change.txt'),'Clean new commit during close.\n');const result=spawnSync(process.env.LANE_CLOSE_REAL_GIT,['-C',lane,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-am','new commit during landing comment'],{env:process.env,encoding:'utf8',windowsHide:true});if(result.status!==0)process.exit(95)}ok({id:input.id,commentId:'comment:fixture:'+state.comments.length});break;
 default:console.error('Unexpected fake Forge operation: '+op);process.exit(94);
}`,
  );
  function shim(name: string, file: string, prefix = "") {
    const target = file.replaceAll("\\", "/");
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${target}" ${prefix} "$@"\n`,
    );
    chmodSync(join(bin, name), 0o755);
    if (process.platform === "win32")
      writeFileSync(
        join(bin, `${name}.cmd`),
        `@"${process.execPath}" "${file}" ${prefix} %*\r\n`,
      );
  }
  shim("forge", fake, "forge");
  shim("gh", fake, "gh");
  function git(args: string[], cwd = main) {
    const result = spawnSync(realGit, args, {
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
  const commit = (message: string, cwd = main) =>
    git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        message,
      ],
      cwd,
    );
  git(["init", "--initial-branch=main"]);
  git(["add", "package.json", ".gitignore"]);
  commit("fixture");
  git(["init", "--bare", "--initial-branch=main", join(root, "remote.git")]);
  git(["remote", "add", "origin", join(root, "remote.git")]);
  git(["push", "origin", "main"]);
  git(["fetch", "origin", "main"]);
  git(["worktree", "add", "--detach", caller, "origin/main"]);
  const brief = join(root, "brief.md");
  writeFileSync(
    brief,
    [
      "Goal",
      "Acceptance test",
      "Files",
      "Forbidden actions",
      "Stop point",
      "Prior art",
    ]
      .map(
        (section) =>
          `## ${section}\nConcrete ${section.toLowerCase()} evidence.\n`,
      )
      .join("\n"),
  );
  writeFileSync(
    stateFile,
    JSON.stringify({ issue: { id: "one", title: "Fixture", status: "open" } }),
  );
  function run(args: string[]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: caller,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return {
      code: result.status,
      output: JSON.parse(result.stdout) as Record<string, unknown>,
      stderr: result.stderr,
    };
  }
  const started = run([
    "start",
    "one",
    "--branch",
    "lane/one",
    "--brief",
    brief,
  ]);
  expect(started.code).toBe(0);
  const lane = String(started.output.worktree);
  writeFileSync(join(lane, "change.txt"), "Delivered change.\n");
  git(["add", "change.txt"], lane);
  commit("lane change", lane);
  const head = git(["rev-parse", "lane/one"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "merge",
    "--no-ff",
    "lane/one",
    "-m",
    "merge delivered lane",
  ]);
  const merge = git(["rev-parse", "HEAD"]);
  git(["push", "origin", "main"]);
  git(["fetch", "origin", "main"]);
  const state: State = {
    issue: { id: "one", title: "Fixture", status: "open" },
    pr: {
      state: "MERGED",
      headRefName: "lane/one",
      headRefOid: head,
      mergeCommit: { oid: merge },
      url: "https://github.com/fixture/repo/pull/42",
    },
    receipt: {
      id: "receipt-one",
      status: "PASS",
      subject: merge,
      checked: [
        { name: "unit", status: "PASS" },
        { name: "types", status: "PASS" },
      ],
    },
    links: [],
    comments: [],
  };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(callsFile, "");
  const common = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const registry = join(common, "forge-lanes.json");
  const history = join(common, "forge-lane-runs", "one", "previous-run");
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, "reply.md"), "Durable prior reply.\n");
  const record = JSON.stringify({
    role: "builder",
    round: null,
    model: "fixture",
    effort: "high",
    start: "2026-10-29T00:00:00.000Z",
    end: "2026-10-29T00:00:01.000Z",
    verdict: "completed",
    session: null,
    reply: join(history, "reply.md"),
  });
  writeFileSync(join(history, "run.json"), record);
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8")) as State;
  function change(edit: (value: State) => void) {
    const value = readState();
    edit(value);
    writeFileSync(stateFile, JSON.stringify(value));
  }
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  const writes = () =>
    calls().filter(
      (call) =>
        call.command === "forge" &&
        ["claim", "link", "close", "comment"].includes(call.args[1]!),
    );
  function cleanupFailure(kind: "worktree" | "branch") {
    const helper = join(root, "fake-git.mjs");
    writeFileSync(
      helper,
      `import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';import {join} from 'node:path';const args=process.argv.slice(2).filter(Boolean);if(existsSync(join(process.env.LANE_CLOSE_FIXTURE,'fail-cleanup'))&&(args.includes(${JSON.stringify(kind)})||(${JSON.stringify(kind)}==='branch'&&args.includes('update-ref')))&&args.some(a=>['remove','-d','-D'].includes(a))){console.error('injected cleanup failure');process.exit(1)}const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env,windowsHide:true});process.exit(result.status??1);`,
    );
    if (process.platform === "win32") {
      // Bun refuses cmd metacharacters before a batch fixture can quote them.
      const compiled = spawnSync(
        process.execPath,
        ["build", helper, "--compile", "--outfile", join(bin, "git.exe")],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      if (compiled.status !== 0)
        throw new Error(
          `fake git executable compilation failed: ${compiled.stderr}`,
        );
    } else shim("git", helper);
    writeFileSync(join(root, "fail-cleanup"), "");
  }
  const close = (extra: string[] = []) =>
    run(["close", "one", "--pr", "42", "--receipt", "receipt-one", ...extra]);
  const registered = () =>
    JSON.parse(readFileSync(registry, "utf8")) as { issue: string }[];
  const branchExists = () =>
    git(["for-each-ref", "--format=%(refname)", "refs/heads/lane/one"]) !== "";
  function retained() {
    expect(existsSync(lane)).toBe(true);
    expect(branchExists()).toBe(true);
    expect(registered().map((entry) => entry.issue)).toEqual(["one"]);
    const listed = run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.output.lanes).toHaveLength(1);
    expect(listed.output.lanes).toMatchObject([
      { issue: "one", worktree: lane, branch: "lane/one" },
    ]);
  }
  function cleaned() {
    expect(existsSync(lane)).toBe(false);
    expect(branchExists()).toBe(false);
    expect(registered()).toEqual([]);
    const listed = run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.output.lanes).toEqual([]);
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(
      lane.replaceAll("\\", "/"),
    );
    expect(readFileSync(join(history, "run.json"), "utf8")).toBe(record);
    expect(readFileSync(join(history, "reply.md"), "utf8")).toBe(
      "Durable prior reply.\n",
    );
  }
  return {
    root,
    main,
    lane,
    common,
    registry,
    run,
    close,
    calls,
    writes,
    change,
    readState,
    git,
    commit,
    head,
    merge,
    retained,
    cleaned,
    cleanupFailure,
  };
}
function expectedComment(f: ReturnType<typeof fixture>) {
  return `PR #42 landed: https://github.com/fixture/repo/pull/42\nMerge commit: ${f.merge}\nReceipt: receipt-one\nChecks: unit: PASS, types: PASS`;
}

test("close claims, links, closes with the merge receipt, verifies and comments before removing the lane", () => {
  const f = fixture();
  const result = f.close();
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    ok: true,
    issue: "one",
    pr: 42,
    mergeCommit: f.merge,
    receipt: "receipt-one",
    status: "closed",
    removed: true,
  });
  expect(f.writes().map((call) => call.args[1])).toEqual([
    "claim",
    "link",
    "close",
    "comment",
  ]);
  expect(f.writes().find((call) => call.args[1] === "link")?.input).toEqual({
    id: "one",
    relation: "delivers",
    url: "https://github.com/fixture/repo/pull/42",
  });
  expect(f.writes().find((call) => call.args[1] === "close")?.input).toEqual({
    id: "one",
    receipt: "receipt-one",
    reason: `PR #42 merged as ${f.merge.slice(0, 7)}`,
  });
  expect(f.readState().issue).toMatchObject({
    status: "closed",
    receipt: "receipt-one",
  });
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  const auth = f
    .calls()
    .find((call) => call.command === "gh" && call.args[0] === "auth");
  expect(auth?.args).toEqual(["auth", "token", "--user", "fixture-owner"]);
  const operations = f
    .calls()
    .filter((call) => call.command === "forge")
    .map((call) => call.args.slice(0, 2).join("."));
  const closing = operations.indexOf("issue.close");
  expect(
    operations.slice(closing + 1, operations.indexOf("issue.comment")),
  ).toContain("issue.show");
  const pr = f
    .calls()
    .find((call) => call.command === "gh" && call.args[0] === "pr");
  expect(pr?.args).toContain("42");
  expect(pr?.args[pr.args.indexOf("--json") + 1]?.split(",").sort()).toEqual(
    ["state", "headRefName", "headRefOid", "mergeCommit", "url"].sort(),
  );
  f.cleaned();
});

test("close --keep-open comments and removes the lane while leaving the issue open", () => {
  const f = fixture();
  const result = f.close(["--keep-open"]);
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    ok: true,
    issue: "one",
    pr: 42,
    mergeCommit: f.merge,
    receipt: "receipt-one",
    status: "open",
    removed: true,
  });
  expect(f.writes().map((call) => call.args[1])).toEqual(["comment"]);
  expect(f.readState().issue.status).toBe("open");
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.cleaned();
});

const refusals: {
  name: string;
  edit: (f: ReturnType<typeof fixture>) => void;
}[] = [
  {
    name: "unmerged open PR",
    edit: (f) =>
      f.change((s) => {
        s.pr.state = "OPEN";
      }),
  },
  {
    name: "closed unmerged PR",
    edit: (f) =>
      f.change((s) => {
        s.pr.state = "CLOSED";
      }),
  },
  {
    name: "missing merge commit",
    edit: (f) =>
      f.change((s) => {
        s.pr.mergeCommit = null;
      }),
  },
  {
    name: "invalid merge SHA",
    edit: (f) =>
      f.change((s) => {
        s.pr.mergeCommit = { oid: "not-a-sha" };
      }),
  },
  {
    name: "different PR branch",
    edit: (f) =>
      f.change((s) => {
        s.pr.headRefName = "another-lane";
      }),
  },
  {
    name: "different PR head",
    edit: (f) =>
      f.change((s) => {
        s.pr.headRefOid = "a".repeat(40);
      }),
  },
  {
    name: "malformed PR head",
    edit: (f) =>
      f.change((s) => {
        s.pr.headRefOid = "invalid";
      }),
  },
  {
    name: "invalid PR URL",
    edit: (f) =>
      f.change((s) => {
        s.pr.url = "not-a-url";
      }),
  },
  {
    name: "unavailable GitHub",
    edit: (f) =>
      f.change((s) => {
        s.fail = "gh";
      }),
  },
  {
    name: "malformed GitHub JSON",
    edit: (f) =>
      f.change((s) => {
        s.fail = "gh-json";
      }),
  },
  {
    name: "missing receipt",
    edit: (f) =>
      f.change((s) => {
        s.receipt = null;
      }),
  },
  ...["FAIL", "INCOMPLETE", "NOT_EXECUTED"].map((status) => ({
    name: `${status} receipt`,
    edit: (f: ReturnType<typeof fixture>) =>
      f.change((s) => {
        s.receipt!.status = status;
      }),
  })),
  {
    name: "receipt for PR head instead of merge",
    edit: (f) =>
      f.change((s) => {
        s.receipt!.subject = f.head;
      }),
  },
  {
    name: "receipt for different merge",
    edit: (f) =>
      f.change((s) => {
        s.receipt!.subject = "b".repeat(40);
      }),
  },
  {
    name: "wrong receipt id",
    edit: (f) =>
      f.change((s) => {
        s.receipt!.id = "receipt-other";
      }),
  },
  {
    name: "tracked modifications",
    edit: (f) =>
      writeFileSync(join(f.lane, "change.txt"), "Dirty tracked content.\n"),
  },
  {
    name: "untracked file",
    edit: (f) =>
      writeFileSync(join(f.lane, "untracked.txt"), "Untracked content.\n"),
  },
  {
    name: "staged change",
    edit: (f) => {
      writeFileSync(join(f.lane, "change.txt"), "Staged content.\n");
      f.git(["add", "change.txt"], f.lane);
    },
  },
  {
    name: "missing lane worktree without a pending cleanup",
    edit: (f) => {
      f.git(["worktree", "remove", f.lane]);
    },
  },
];
for (const { name, edit } of refusals)
  test(`close refuses ${name} before Forge writes`, () => {
    const f = fixture();
    edit(f);
    const before = readFileSync(f.registry, "utf8");
    const result = f.close();
    expect(result.code).toBe(1);
    expect(result.output.verdict).toBe("refused");
    expect(f.writes()).toEqual([]);
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(f.readState().comments).toEqual([]);
  });

test("close refuses an unknown lane before GitHub or Forge writes", () => {
  const f = fixture();
  const result = f.run([
    "close",
    "unknown",
    "--pr",
    "42",
    "--receipt",
    "receipt-one",
  ]);
  expect(result.code).toBe(1);
  expect(result.output.verdict).toBe("refused");
  expect(f.calls()).toEqual([]);
  f.retained();
});

test("close rejects missing, duplicate, unknown and malformed flags before external reads", () => {
  const f = fixture();
  for (const args of [
    ["close"],
    ["close", "..", "--pr", "42", "--receipt", "receipt-one"],
    ["close", "one", "--receipt", "receipt-one"],
    ["close", "one", "--pr", "42"],
    ["close", "one", "--pr", "42", "--receipt"],
    ["close", "one", "--pr", "42", "--receipt", "receipt-one", "--unknown"],
    ["close", "one", "--pr", "42", "--receipt", "receipt-one", "--pr", "42"],
    [
      "close",
      "one",
      "--pr",
      "42",
      "--receipt",
      "receipt-one",
      "--receipt",
      "receipt-one",
    ],
    [
      "close",
      "one",
      "--pr",
      "42",
      "--receipt",
      "receipt-one",
      "--keep-open",
      "--keep-open",
    ],
    ...["0", "-1", "1.5", "NaN", "9007199254740992"].map((number) => [
      "close",
      "one",
      "--pr",
      number,
      "--receipt",
      "receipt-one",
    ]),
  ]) {
    const result = f.run(args);
    expect(result.code).toBe(2);
    expect(result.output.ok).toBe(false);
    expect(result.output.verdict).toBe("refused");
  }
  expect(f.calls()).toEqual([]);
  f.retained();
});

test("Forge close failure leaves the worktree, branch and registry available for recovery", () => {
  const f = fixture();
  f.change((s) => {
    s.fail = "issue.close";
  });
  expect(f.close().code).toBe(1);
  expect(f.writes().some((call) => call.args[1] === "close")).toBe(true);
  expect(f.readState().issue.status).toBe("open");
  expect(f.readState().comments).toEqual([]);
  f.retained();
});

test("failed close readback preserves the lane and does not publish a landing comment", () => {
  const f = fixture();
  f.change((s) => {
    s.hideClosed = true;
  });
  expect(f.close().code).toBe(1);
  expect(f.readState().issue.status).toBe("closed");
  expect(f.readState().comments).toEqual([]);
  f.retained();
});

for (const kind of ["worktree", "branch"] as const)
  test(`cleanup ${kind} failure is retryable without duplicate close or comment`, () => {
    const f = fixture();
    f.cleanupFailure(kind);
    expect(f.close().code).toBe(1);
    expect(f.readState().issue.status).toBe("closed");
    expect(f.readState().comments).toEqual([expectedComment(f)]);
    expect(JSON.parse(readFileSync(f.registry, "utf8"))).toHaveLength(1);
    rmSync(join(f.root, "fail-cleanup"));
    expect(f.close().code).toBe(0);
    expect(f.writes().filter((call) => call.args[1] === "close")).toHaveLength(
      1,
    );
    expect(
      f.writes().filter((call) => call.args[1] === "comment"),
    ).toHaveLength(1);
    f.cleaned();
  });

test("retry accepts worktree and branch already removed after a verified close", () => {
  const f = fixture();
  f.cleanupFailure("worktree");
  expect(f.close().code).toBe(1);
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.git(["worktree", "remove", f.lane]);
  f.git(["branch", "-d", "lane/one"]);
  rmSync(join(f.root, "fail-cleanup"));
  expect(f.close().code).toBe(0);
  expect(f.writes().filter((call) => call.args[1] === "close")).toHaveLength(1);
  expect(f.writes().filter((call) => call.args[1] === "comment")).toHaveLength(
    1,
  );
  f.cleaned();
});

test("close preserves a clean new commit created after preflight", () => {
  const f = fixture();
  f.change((state) => {
    state.commitOnComment = true;
  });
  const result = f.close();
  expect(result.code).toBe(1);
  expect(result.output.ok).toBe(false);
  expect(f.readState().comments).toEqual([expectedComment(f)]);
  f.retained();
  const newHead = f.git(["rev-parse", "refs/heads/lane/one"]);
  expect(newHead).not.toBe(f.head);
  expect(f.git(["rev-parse", "HEAD"], f.lane)).toBe(newHead);
  expect(
    f.git(["status", "--porcelain", "--untracked-files=all"], f.lane),
  ).toBe("");
  expect(readFileSync(join(f.lane, "change.txt"), "utf8")).toBe(
    "Clean new commit during close.\n",
  );
});
