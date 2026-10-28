import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(120000);
interface Row {
  name: string;
  result: "pass" | "fail" | "inconclusive";
  seconds: number;
  nextStep: string;
}
interface Result {
  rows: Row[];
  verdict: "admit" | "refuse";
  firstFailingRow?: string;
  exitCode: 0 | 1 | 2 | 130;
}
type Admit = (
  input: {
    root: string;
    name: string;
    patch: string;
    guard: readonly string[];
    replay?: number;
    maxSeconds?: number;
  },
  dependencies?: { platform?: NodeJS.Platform; setup?: readonly string[] },
) => Promise<Result>;
async function load(): Promise<Admit> {
  const url = new URL("../../tools/check-admit.ts", import.meta.url);
  expect(existsSync(fileURLToPath(url))).toBe(true);
  const module = (await import(url.href)) as { admit?: Admit };
  expect(typeof module.admit).toBe("function");
  return module.admit!;
}
const names = ["clean", "break", "restore", "replay", "Windows time"];
const setup = [process.execPath, "-e", ""];
function fixture(mode = "pass") {
  const root = mkdtempSync(join(tmpdir(), "forge-check-admit-"));
  const observed = join(root, "observed.txt"),
    marker = join(root, "saw-break");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Admission fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, ".forge"));
  writeFileSync(join(root, ".gitignore"), "cache/\nnode_modules/\n");
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      blocks: {
        check: {
          config: {
            commands: { guard: { argv: ["node", "check.cjs"] } },
            report: "exit-code",
            timeoutMs: mode === "timeout" ? 1500 : 10000,
          },
        },
      },
    }),
  );
  writeFileSync(
    join(root, "check.cjs"),
    `
const fs = require('node:fs');
const value = fs.readFileSync('source.txt', 'utf8').trim();
const observed = ${JSON.stringify(observed)}, marker = ${JSON.stringify(marker)}, mode = ${JSON.stringify(mode)};
fs.appendFileSync(observed, value + '\\n');
let failed = value === 'BROKEN';
if (mode === 'clean') failed = true;
if (mode === 'survived' && value === 'BROKEN') failed = false;
if (mode === 'restore' && value === 'tip' && fs.existsSync(marker)) failed = true;
if (mode === 'replay' && value === 'previous') failed = true;
if (value === 'BROKEN') fs.writeFileSync(marker, 'yes');
if (mode === 'timeout' && value === 'BROKEN') setInterval(() => {}, 1000);
console.log('checked ' + value);
process.exitCode = failed ? 1 : 0;
if (mode.startsWith('missing') && value === 'BROKEN') {
  console.error('spawn ENOENT: required child tool is unavailable');
  process.exitCode = Number(mode.slice(7));
}
if (mode === 'cache') {
  if (value === 'tip') { fs.mkdirSync('cache', {recursive:true}); fs.writeFileSync('cache/seen', 'yes'); }
  if (value === 'previous' && !fs.existsSync('cache/seen')) process.exitCode = 1;
}
if (mode === 'slow' && value === 'tip') setTimeout(() => {}, 3000);
`,
  );
  for (const content of ["old", "previous", "tip"]) {
    writeFileSync(join(root, "source.txt"), content + "\n");
    git("add", ".forge/config.yaml", ".gitignore", "check.cjs", "source.txt");
    git("commit", "-m", content);
  }
  const tip = git("rev-parse", "HEAD"),
    previous = git("rev-parse", "HEAD^");
  git("update-ref", "refs/remotes/origin/main", tip);
  const patch = join(root, "break.patch");
  writeFileSync(
    patch,
    "diff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-tip\n+BROKEN\n",
  );
  return {
    root,
    patch,
    previous,
    observed,
    git,
    input: {
      root,
      name: "guard",
      patch,
      guard: ["check.cjs"],
      replay: 2,
      maxSeconds: 120,
    },
    clean(head = tip) {
      expect(
        git("worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(1);
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("tip\n");
      if (existsSync(join(root, ".worktrees")))
        expect(readdirSync(join(root, ".worktrees"))).toEqual([]);
      expect(git("worktree", "prune", "--dry-run", "--verbose")).toBe("");
    },
    contents: () =>
      existsSync(observed)
        ? readFileSync(observed, "utf8").trim().split("\n")
        : [],
    remove: () =>
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      }),
  };
}
function rows(result: Result) {
  expect(result.rows.map((row) => row.name)).toEqual(names);
  expect(
    result.rows.every(
      (row) =>
        Number.isFinite(row.seconds) &&
        row.seconds >= 0 &&
        row.nextStep.length > 0,
    ),
  ).toBe(true);
}
function launch(
  input: Parameters<Admit>[0],
  observed?: string,
  signal = "SIGINT",
) {
  const tool = new URL("../../tools/check-admit.ts", import.meta.url).href;
  const script = `
import {admit} from ${JSON.stringify(tool)};
import {existsSync} from 'node:fs';
let timer;
try {
  const pending = admit(${JSON.stringify(input)}, {platform:'win32',setup:[process.execPath,'-e','']});
  ${observed ? `timer = setInterval(() => { if(existsSync(${JSON.stringify(observed)})) {clearInterval(timer);process.emit(${JSON.stringify(signal)});} }, 25);` : ""}
  const result = await pending;
  console.log(JSON.stringify(result));process.exitCode=result.exitCode;
} catch(error) {console.log(JSON.stringify({error:String(error)}));process.exitCode=2;}
finally {clearInterval(timer);}
`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        /^(?:PATH|PATHEXT|SystemRoot|windir|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(
          name,
        ),
    ),
  );
  const child = spawn(process.execPath, ["-e", script], {
    env,
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
test("regression: concurrent admission children preserve each other's live worktree", async () => {
  await load();
  const f = fixture("slow"),
    children: ReturnType<typeof launch>[] = [];
  try {
    children.push(launch(f.input));
    const deadline = Date.now() + 30000;
    while (!existsSync(f.observed) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(f.observed)).toBe(true);
    children.push(launch(f.input));
    const results = await Promise.all(children.map((child) => child.done));
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    for (const result of results)
      expect(JSON.parse(result.stdout)).toMatchObject({
        verdict: "admit",
        exitCode: 0,
      });
    f.clean();
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(children.map((child) => child.done));
    f.remove();
  }
});
for (const signal of ["SIGINT", "SIGTERM"])
  test(`regression: interruption ${signal} cleans its own worktree and returns 130`, async () => {
    await load();
    const f = fixture("slow");
    const child = launch(f.input, f.observed, signal);
    try {
      const result = await child.done;
      expect(result).toMatchObject({ code: 130 });
      const reported = JSON.parse(result.stdout) as Result;
      expect(reported).toMatchObject({ verdict: "refuse", exitCode: 130 });
      rows(reported);
      expect(reported.rows[0]?.result).toBe("inconclusive");
      f.clean();
    } finally {
      if (child.child.exitCode === null) child.child.kill();
      await child.done;
      f.remove();
    }
  });
test("admit proves all five rows using changed prior files and removes all worktree state", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const result = await admit(f.input, { platform: "win32", setup });
    rows(result);
    expect(result).toMatchObject({ verdict: "admit", exitCode: 0 });
    expect(result.rows.map((row) => row.result)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(result.firstFailingRow).toBeUndefined();
    expect(f.contents()).toEqual(["tip", "BROKEN", "tip", "previous", "old"]);
    f.clean();
  } finally {
    f.remove();
  }
});
for (const [mode, row] of [
  ["clean", "clean"],
  ["survived", "break"],
  ["restore", "restore"],
  ["replay", "replay"],
]) {
  test(`${row} failure refuses at its first blocked row and cleans up`, async () => {
    const admit = await load(),
      f = fixture(mode);
    try {
      const result = await admit(f.input, { platform: "win32", setup });
      rows(result);
      expect(result).toMatchObject({
        verdict: "refuse",
        firstFailingRow: row,
        exitCode: 1,
      });
      expect(result.rows.find((value) => value.name === row)?.result).toBe(
        "fail",
      );
      if (mode === "clean") expect(f.contents()).toEqual(["tip"]);
      if (mode === "replay")
        expect(JSON.stringify(result.rows[3])).toContain(f.previous);
      f.clean();
    } finally {
      f.remove();
    }
  });
}
test("Windows timing refuses a check over the strict limit", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const result = await admit(
      { ...f.input, maxSeconds: 0.000001 },
      { platform: "win32", setup },
    );
    rows(result);
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "Windows time",
      exitCode: 1,
    });
    expect(result.rows[4]?.result).toBe("fail");
    expect(result.rows[4]?.seconds).toBeGreaterThan(0.000001);
    f.clean();
  } finally {
    f.remove();
  }
});
test("setup is repeated for every checkout and excluded from Windows timing", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const setupLog = join(f.root, "setup-log.txt");
    const result = await admit(
      { ...f.input, replay: 1, maxSeconds: 2 },
      {
        platform: "win32",
        setup: [
          process.execPath,
          "-e",
          `require('node:fs').appendFileSync(${JSON.stringify(setupLog)}, 'setup\\n');setTimeout(() => {}, 3000)`,
        ],
      },
    );
    expect(result).toMatchObject({ verdict: "admit", exitCode: 0 });
    expect(result.rows[4]?.result).toBe("pass");
    expect(result.rows[4]?.seconds).toBeLessThan(2);
    expect(readFileSync(setupLog, "utf8").trim().split("\n")).toHaveLength(5);
    f.clean();
  } finally {
    f.remove();
  }
});
test("a known-break timeout is inconclusive rather than catching the break", async () => {
  const admit = await load(),
    f = fixture("timeout");
  try {
    const result = await admit(f.input, { platform: "win32", setup });
    rows(result);
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "break",
      exitCode: 2,
    });
    expect(result.rows[1]?.result).toBe("inconclusive");
    f.clean();
  } finally {
    f.remove();
  }
});
test("non-Windows timing is explicitly inconclusive", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const result = await admit(f.input, { platform: "linux", setup });
    rows(result);
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "Windows time",
      exitCode: 2,
    });
    expect(result.rows[4]?.result).toBe("inconclusive");
    expect(JSON.stringify(result.rows[4])).toContain("not measured on Windows");
    f.clean();
  } finally {
    f.remove();
  }
});
test("setup failure is inconclusive and removes the disposable checkout", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const result = await admit(f.input, {
      platform: "win32",
      setup: [process.execPath, "-e", "process.exit(1)"],
    });
    rows(result);
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "clean",
      exitCode: 2,
    });
    expect(result.rows[0]?.result).toBe("inconclusive");
    expect(f.contents()).toEqual([]);
    f.clean();
  } finally {
    f.remove();
  }
});
test("an invalid patch cannot prove the break was caught and leaves no worktree", async () => {
  const admit = await load(),
    f = fixture();
  try {
    writeFileSync(f.patch, "not a patch\n");
    const result = await admit(f.input, { platform: "win32", setup });
    rows(result);
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "break",
      exitCode: 2,
    });
    expect(result.rows[1]?.result).toBe("inconclusive");
    f.clean();
  } finally {
    f.remove();
  }
});
test("a stale admission worktree is removed along with the new disposable checkout", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const stale = join(f.root, ".worktrees", ".admit-2147483647-fixture");
    mkdirSync(join(f.root, ".worktrees"));
    execFileSync("git", ["worktree", "add", "--detach", stale, "origin/main"], {
      cwd: f.root,
      stdio: "pipe",
    });
    const result = await admit(f.input, { platform: "win32", setup });
    expect(result).toMatchObject({ verdict: "admit", exitCode: 0 });
    expect(existsSync(stale)).toBe(false);
    f.clean();
  } finally {
    f.remove();
  }
});
test("regression: proposed guard is copied to prior snapshots without unrelated dirty files", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const guard = join(f.root, "check.cjs");
    writeFileSync(
      guard,
      readFileSync(guard, "utf8") +
        "\nif (value === 'previous' || fs.existsSync('unrelated.txt')) process.exitCode = 1;\n",
    );
    f.git("add", "check.cjs");
    f.git("commit", "-m", "candidate guard");
    const head = f.git("rev-parse", "HEAD");
    writeFileSync(join(f.root, "unrelated.txt"), "must not enter snapshots");
    const result = await admit(f.input, { platform: "win32", setup });
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "replay",
      exitCode: 1,
    });
    expect(result.rows.slice(0, 3).map((row) => row.result)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(JSON.stringify(result.rows[3])).toContain(f.previous);
    f.clean(head);
  } finally {
    f.remove();
  }
});
test("regression: a branch-only declared guard works without copying unrelated branch files", async () => {
  const admit = await load(),
    f = fixture();
  try {
    writeFileSync(
      join(f.root, "new-guard.cjs"),
      readFileSync(join(f.root, "check.cjs"), "utf8") +
        "\nif(fs.existsSync('unrelated.txt')) process.exitCode = 1;\n",
    );
    writeFileSync(join(f.root, "unrelated.txt"), "must not enter snapshots");
    const config = JSON.parse(
      readFileSync(join(f.root, ".forge/config.yaml"), "utf8"),
    ) as {
      blocks: {
        check: { config: { commands: { guard: { argv: string[] } } } };
      };
    };
    config.blocks.check.config.commands.guard.argv = ["node", "new-guard.cjs"];
    writeFileSync(join(f.root, ".forge/config.yaml"), JSON.stringify(config));
    const result = await admit(
      { ...f.input, guard: ["new-guard.cjs"] },
      { platform: "win32", setup },
    );
    expect(result).toMatchObject({ verdict: "admit", exitCode: 0 });
    expect(f.contents()).toEqual(["tip", "BROKEN", "tip", "previous", "old"]);
    f.clean();
  } finally {
    f.remove();
  }
});
for (const code of [126, 127])
  test(`regression: child-tool exit ${code} is inconclusive rather than a caught break`, async () => {
    const admit = await load(),
      f = fixture(`missing${code}`);
    try {
      const result = await admit(f.input, { platform: "win32", setup });
      expect(result).toMatchObject({
        verdict: "refuse",
        firstFailingRow: "break",
        exitCode: 2,
      });
      expect(result.rows[1]?.result).toBe("inconclusive");
      f.clean();
    } finally {
      f.remove();
    }
  });
test("regression: ignored caches cannot make an old snapshot falsely pass", async () => {
  const admit = await load(),
    f = fixture("cache");
  try {
    const result = await admit(f.input, { platform: "win32", setup });
    expect(result).toMatchObject({
      verdict: "refuse",
      firstFailingRow: "replay",
      exitCode: 1,
    });
    expect(JSON.stringify(result.rows[3])).toContain(f.previous);
    f.clean();
  } finally {
    f.remove();
  }
});
test("regression: cleanup preserves an unrelated prunable worktree registration", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const unrelated = join(f.root, "unrelated-worktree");
    f.git(
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      unrelated,
      "origin/main",
    );
    rmSync(unrelated, { recursive: true });
    mkdirSync(join(f.root, ".worktrees", ".admit-2147483647-orphan"), {
      recursive: true,
    });
    expect(f.git("worktree", "list", "--porcelain")).toContain("prunable");
    const result = await admit(f.input, { platform: "win32", setup });
    expect(result).toMatchObject({ verdict: "admit", exitCode: 0 });
    expect(f.git("worktree", "list", "--porcelain")).toContain(
      "unrelated-worktree",
    );
    expect(
      f.git("worktree", "list", "--porcelain").match(/^worktree /gm),
    ).toHaveLength(2);
  } finally {
    f.remove();
  }
});
test("invalid input refuses with an actionable reason and leaves the original checkout", async () => {
  const admit = await load(),
    f = fixture();
  try {
    for (const input of [
      { ...f.input, name: "missing" },
      { ...f.input, replay: -1 },
    ]) {
      try {
        const result = await admit(input, { platform: "win32", setup });
        expect(result.verdict).toBe("refuse");
        expect(result.exitCode).not.toBe(0);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /configured|unknown|missing|replay|positive|integer|invalid/i,
        );
      }
      f.clean();
    }
  } finally {
    f.remove();
  }
});
test("dead-pid cleanup recognizes a missing worktree through Windows path casing", async () => {
  const admit = await load(),
    f = fixture();
  try {
    const stale = join(f.root, ".worktrees", ".admit-2147483647-missing");
    f.git("worktree", "add", "--detach", stale, "origin/main");
    rmSync(stale, { recursive: true });
    const root = process.platform === "win32" ? f.root.toUpperCase() : f.root;
    const result = await admit(
      { ...f.input, root },
      { platform: "win32", setup },
    );
    expect(result).toMatchObject({ verdict: "admit", exitCode: 0 });
    f.clean();
  } finally {
    f.remove();
  }
});
