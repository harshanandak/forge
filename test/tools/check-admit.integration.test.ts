import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
  exitCode: 0 | 1 | 2;
}
type Admit = (
  input: {
    root: string;
    name: string;
    patch: string;
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
`,
  );
  for (const content of ["old", "previous", "tip"]) {
    writeFileSync(join(root, "source.txt"), content + "\n");
    git("add", ".forge/config.yaml", "check.cjs", "source.txt");
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
    input: { root, name: "guard", patch, replay: 2, maxSeconds: 120 },
    clean() {
      expect(
        git("worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(1);
      expect(git("rev-parse", "HEAD")).toBe(tip);
      expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("tip\n");
      if (existsSync(join(root, ".worktrees")))
        expect(readdirSync(join(root, ".worktrees"))).toEqual([]);
      expect(git("worktree", "prune", "--dry-run", "--verbose")).toBe("");
    },
    contents: () =>
      existsSync(observed)
        ? readFileSync(observed, "utf8").trim().split("\n")
        : [],
    remove: () => rmSync(root, { recursive: true, force: true }),
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
    const stale = join(f.root, ".worktrees", ".admit-stale-fixture");
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
