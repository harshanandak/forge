import {
  acceptanceCases,
  acceptanceTable,
} from "../blocks/l7-work/lane-brief-fixture.ts";
// [integration] Real git worktrees and subprocesses; Forge is a PATH fixture.
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

import { RepositoryFixtures } from "./lane-fixture.ts";

setDefaultTimeout(60_000);
const repositories = new RepositoryFixtures<boolean>();
const script = resolve(import.meta.dirname, "../../tools/lane.ts");
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
type Lane = { issue: string; worktree: string; branch: string; brief: string };
type Output = {
  verdict: string;
  reasons: string[];
  worktree: string | null;
  branch: string | null;
  brief: string | null;
  next: string[];
  lanes: Lane[];
};
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-lane-")));
  roots.push(root);
  const main = join(root, "main"),
    caller = join(root, "caller"),
    bin = join(root, "bin");
  const cached = repositories.restore("default", root);
  if (!cached) {
    mkdirSync(main);
    // A manifest exists before any command can discover or install a package.
    writeFileSync(
      join(main, "package.json"),
      '{"name":"lane-fixture","private":true}',
    );
    writeFileSync(join(main, ".gitignore"), ".worktrees/\n");
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
  const fake = join(root, "fake-forge.mjs");
  writeFileSync(
    fake,
    `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const root=process.env.LANE_FIXTURE;writeFileSync(join(root,'forge-args.json'),JSON.stringify(process.argv.slice(2)));const mode=readFileSync(join(root,'mode'),'utf8');if(mode==='invalid'){console.log('bad json');process.exit(0)}console.log(JSON.stringify(mode==='refused'?{ok:false,error:{message:'missing issue'}}:{ok:true,result:{id:JSON.parse(process.argv[5]).id}}));process.exit(mode==='exit'?1:0);`,
  );
  writeFileSync(join(root, "mode"), "ok");
  writeFileSync(
    join(bin, "forge"),
    `#!/bin/sh\nexec node "${fake.replaceAll("\\", "/")}" "$@"\n`,
  );
  chmodSync(join(bin, "forge"), 0o755);
  function git(args: string[], cwd = main) {
    const run = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (run.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  }
  if (!cached) {
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
    repositories.save("default", root, true);
  }
  const brief = join(root, "brief.md");
  const text = (omit = "", empty = "") =>
    sections
      .filter((s) => s !== omit)
      .map(
        (s) =>
          `## ${s}\n${s === empty ? "" : `Concrete ${s.toLowerCase()} evidence.${s === "Acceptance test" ? "\n" + acceptanceTable : ""}`}\n`,
      )
      .join("\n");
  writeFileSync(brief, text());
  const args = (id: string, extra: string[] = []) => [
    "start",
    id,
    "--branch",
    `lane/${id}`,
    "--brief",
    brief,
    ...extra,
  ];
  function run(argv: string[], cwd = caller) {
    const result = spawnSync(process.execPath, [script, ...argv], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    return {
      code: result.status,
      output: JSON.parse(result.stdout) as Output,
      stderr: result.stderr,
    };
  }
  return {
    root,
    main,
    caller,
    brief,
    text,
    env,
    git,
    args,
    run,
    registry: join(main, ".git", "forge-lanes.json"),
  };
}

test("lane helper start and close refuse with equivalent argv and preserve repository state", () => {
  const f = fixture();
  for (const args of [
    f.args("one"),
    ["close", "one", "--no-pr", "--dropped", "Use another approach"],
  ]) {
    const result = f.run(args);
    expect(result.code, result.stderr).toBe(2);
    expect(result.output.next).toEqual(["forge", "lane", ...args]);
    expect(existsSync(f.registry)).toBe(false);
    expect(f.git(["branch", "--list", "lane/one"])).toBe("");
  }
}, 30000);
test("list is read only, shared across worktrees, and removed worktrees release slots", () => {
  const f = fixture();
  expect(f.run(["list"]).output.lanes).toEqual([]);
  expect(existsSync(f.registry)).toBe(false);
  const lanes = ["one", "two", "three"].map((issue) => {
    const worktree = join(f.main, ".worktrees", issue),
      branch = `lane/${issue}`;
    f.git(["worktree", "add", "-b", branch, worktree, "origin/main"]);
    return { issue, worktree, branch, brief: f.brief };
  });
  writeFileSync(f.registry, JSON.stringify(lanes));
  const lane = join(f.main, ".worktrees/one");
  expect(
    f
      .run(["list"], lane)
      .output.lanes.map((l) => l.issue)
      .sort(),
  ).toEqual(["one", "three", "two"]);
  f.git(["worktree", "remove", lane]);
  const registry = readFileSync(f.registry, "utf8");
  expect(f.run(["list"]).output.lanes).toHaveLength(2);
  expect(readFileSync(f.registry, "utf8")).toBe(registry);
});

test("invalid command arguments return one JSON with exit 2", () => {
  const f = fixture();
  for (const argv of [
    [],
    ["wat"],
    ["start"],
    ["list", "--max", "2"],
    f.args("../escape"),
    f.args("bad", ["--max", "0"]),
    f.args("bad", ["--max", "1.5"]),
    f.args("bad", ["--unknown", "x"]),
  ]) {
    const result = f.run(argv);
    expect(result.code).toBe(2);
    expect(result.output.verdict).toBe("refused");
    if (argv[0] === "start")
      expect(result.output.next).toEqual([
        "forge",
        "lane",
        ...(argv.includes("--max") ? f.args("bad") : argv),
      ]);
    else
      expect(Object.keys(result.output).sort()).toEqual([
        "branch",
        "brief",
        "next",
        "reasons",
        "verdict",
        "worktree",
      ]);
  }
});

test("retired start omits the script-only max flag from replacement argv", () => {
  const f = fixture();
  const result = f.run(f.args("one", ["--max", "2"]));
  expect(result.code).toBe(2);
  expect(result.output.next).toEqual(["forge", "lane", ...f.args("one")]);
}, 30000);

test("retired start never calls Forge or publishes a registry", () => {
  const f = fixture();
  for (const mode of ["refused", "invalid", "exit"]) {
    writeFileSync(join(f.root, "mode"), mode);
    expect(f.run(f.args(mode)).code).toBe(2);
    expect(existsSync(f.registry)).toBe(false);
  }
  writeFileSync(join(f.root, "mode"), "ok");
  f.git(["branch", "lane/occupied"]);
  expect(f.run(f.args("occupied")).code).toBe(2);
  expect(existsSync(f.registry)).toBe(false);
});

for (const [name, body, problem] of acceptanceCases) {
  test(`tools acceptance table refuses ${name} with the same problem`, () => {
    const f = fixture();
    writeFileSync(f.brief, f.text().replace(acceptanceTable, body));
    const result = f.run(f.args("no-table"));
    expect(result.output.reasons).toEqual([problem]);
    expect(result.code).toBe(2);
    expect(result.output.verdict).toBe("refused");
    expect(existsSync(f.registry)).toBe(false);
    expect(f.git(["branch", "--list", "lane/no-table"])).toBe("");
    expect(existsSync(join(f.main, ".worktrees/no-table"))).toBe(false);
  }, 30000);
}
