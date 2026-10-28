// [integration] Real git worktrees and subprocesses; Forge is a PATH fixture.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
  next: string;
  lanes: Lane[];
};
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-lane-")));
  roots.push(root);
  const main = join(root, "main"),
    caller = join(root, "caller"),
    bin = join(root, "bin");
  mkdirSync(main);
  mkdirSync(bin);
  // A manifest exists before any command can discover or install a package.
  writeFileSync(
    join(main, "package.json"),
    '{"name":"lane-fixture","private":true}',
  );
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
  git(["init", "--initial-branch=main"]);
  git(["add", "package.json"]);
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
  const brief = join(root, "brief.md");
  const text = (omit = "", empty = "") =>
    sections
      .filter((s) => s !== omit)
      .map(
        (s) =>
          `## ${s}\n${s === empty ? "" : `Concrete ${s.toLowerCase()} evidence.`}\n`,
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

test("three lanes start from fetched main beneath caller; fourth refuses with exact recovery", () => {
  const f = fixture();
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "new remote head",
  ]);
  f.git(["push", "origin", "main"]);
  const head = f.git(["rev-parse", "main"]);
  for (const id of ["one", "two", "three"]) {
    const result = f.run(f.args(id));
    expect(result.code).toBe(0);
    expect(result.output.verdict).toBe("started");
    expect(result.output.worktree).toBe(join(f.caller, ".worktrees", id));
    expect(f.git(["rev-parse", "HEAD"], result.output.worktree!)).toBe(head);
    expect(f.git(["branch", "--show-current"], result.output.worktree!)).toBe(
      `lane/${id}`,
    );
  }
  const refused = f.run(f.args("four"));
  expect(refused.code).toBe(1);
  expect(refused.output.verdict).toBe("refused");
  expect(refused.output.reasons).toContain(
    "4 lanes, cap 3; next: wait for a lane to finish or remove one",
  );
  expect(refused.output.next).toBe("wait for a lane to finish or remove one");
  expect(existsSync(join(f.caller, ".worktrees/four"))).toBe(false);
  expect(f.git(["status", "--porcelain"], f.main)).toBe("");
  expect(
    JSON.parse(readFileSync(join(f.root, "forge-args.json"), "utf8")),
  ).toEqual(["issue", "show", "--input", '{"id":"four"}']);
}, 60_000);

for (const section of sections)
  for (const mode of ["missing", "empty"])
    test(`${mode} brief section ${section} refuses before creating a lane`, () => {
      const f = fixture();
      writeFileSync(
        f.brief,
        mode === "missing" ? f.text(section) : f.text("", section),
      );
      const result = f.run(f.args("one"));
      expect(result.code).toBe(1);
      expect(result.output.verdict).toBe("refused");
      expect(result.output.reasons.join(" ")).toContain(section);
      expect(result.output.next).toBe(
        "fill the named required sections and retry",
      );
      expect(existsSync(f.registry)).toBe(false);
      expect(existsSync(join(f.caller, ".worktrees/one"))).toBe(false);
    });

test("frontmatter and fenced headings cannot supply missing sections", () => {
  const f = fixture();
  writeFileSync(
    f.brief,
    `---\n## Goal\nfrontmatter\n---\n~~~md\n## Goal\nfake\n~~~\n${f.text("Goal")}`,
  );
  expect(f.run(f.args("one")).output.reasons.join(" ")).toContain("Goal");
});

test("list is read only, shared across worktrees, and removed worktrees release slots", () => {
  const f = fixture();
  expect(f.run(["list"]).output.lanes).toEqual([]);
  expect(existsSync(f.registry)).toBe(false);
  for (const id of ["one", "two", "three"])
    expect(f.run(f.args(id)).code).toBe(0);
  const lane = join(f.caller, ".worktrees/one");
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
  expect(f.run(f.args("four")).code).toBe(0);
});

test("subdirectory calls report and create lanes beneath the caller checkout root", () => {
  const f = fixture(),
    nested = join(f.caller, "nested");
  mkdirSync(nested);
  const first = f.run(f.args("one", ["--max", "1"]), nested);
  expect(first.code).toBe(0);
  expect(first.output.worktree).toBe(join(f.caller, ".worktrees/one"));
  const refused = f.run(f.args("two", ["--max", "1"]), nested);
  expect(refused.code).toBe(1);
  expect(refused.output.worktree).toBe(join(f.caller, ".worktrees/two"));
});

test("max overrides cap and invalid command arguments return one JSON with exit 2", () => {
  const f = fixture();
  expect(f.run(f.args("one", ["--max", "1"])).code).toBe(0);
  expect(f.run(f.args("two", ["--max", "1"])).code).toBe(1);
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

test("Forge failures, invalid JSON, and failed worktree creation never publish a lane registry", () => {
  const f = fixture();
  for (const mode of ["refused", "invalid", "exit"]) {
    writeFileSync(join(f.root, "mode"), mode);
    expect(f.run(f.args(mode)).code).toBe(1);
    expect(existsSync(f.registry)).toBe(false);
  }
  writeFileSync(join(f.root, "mode"), "ok");
  f.git(["branch", "lane/occupied"]);
  expect(f.run(f.args("occupied")).code).toBe(1);
  expect(existsSync(f.registry)).toBe(false);
});

test("concurrent starts serialize cap decisions and retain every successful lane", async () => {
  const f = fixture();
  const runs = await Promise.all(
    ["one", "two", "three", "four", "five", "six"].map(
      (id) =>
        new Promise<{ code: number | null; output: Output }>(
          (resolveRun, reject) => {
            const child = spawn(process.execPath, [script, ...f.args(id)], {
              cwd: f.caller,
              env: f.env,
              windowsHide: true,
              timeout: 30_000,
            });
            let stdout = "",
              stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
              try {
                resolveRun({ code, output: JSON.parse(stdout) as Output });
              } catch {
                reject(new Error(stderr || stdout));
              }
            });
          },
        ),
    ),
  );
  expect(runs.filter((r) => r.code === 0)).toHaveLength(3);
  expect(runs.filter((r) => r.code === 1)).toHaveLength(3);
  const active = f.run(["list"]).output.lanes;
  expect(active.map((l) => l.worktree).sort()).toEqual(
    runs
      .filter((r) => r.code === 0)
      .map((r) => r.output.worktree!)
      .sort(),
  );
  expect(
    active.every((l) => existsSync(join(l.worktree, "package.json"))),
  ).toBe(true);
}, 60_000);
