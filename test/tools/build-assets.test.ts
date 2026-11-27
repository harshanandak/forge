import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIdentity } from "../../tools/build-assets.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-build-identity-"));
  return root;
}

function fakeGit(outputs: Record<string, string>, calls: string[][]) {
  return (args: string[]): string => {
    calls.push(args);
    const key = args.join(" ");
    if (key in outputs) return outputs[key]!;
    throw new Error(`unexpected git call: ${key}`);
  };
}

test("a root without .git reports unknown without calling git", () => {
  const root = tempRoot();
  try {
    const calls: string[][] = [];
    expect(buildIdentity(root, fakeGit({}, calls))).toEqual({
      commit: "unknown",
      dirty: false,
    });
    expect(calls).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a .git directory is a checkout: clean and dirty status", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".git"));
    const cleanCalls: string[][] = [];
    expect(
      buildIdentity(
        root,
        fakeGit(
          { "rev-parse HEAD": SHA, "status --porcelain": "" },
          cleanCalls,
        ),
      ),
    ).toEqual({ commit: SHA, dirty: false });
    expect(cleanCalls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
    ]);
    const dirtyCalls: string[][] = [];
    expect(
      buildIdentity(
        root,
        fakeGit(
          { "rev-parse HEAD": SHA, "status --porcelain": " M src/index.ts" },
          dirtyCalls,
        ),
      ),
    ).toEqual({ commit: SHA, dirty: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a .git file (worktree) is treated as a checkout", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/worktrees/x\n");
    const calls: string[][] = [];
    expect(
      buildIdentity(
        root,
        fakeGit({ "rev-parse HEAD": SHA, "status --porcelain": "" }, calls),
      ),
    ).toEqual({ commit: SHA, dirty: false });
    expect(calls.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a failing rev-parse probe throws a named error", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".git"));
    const calls: string[][] = [];
    expect(() =>
      buildIdentity(root, (args) => {
        calls.push(args);
        throw new Error("fatal: not a git repository");
      }),
    ).toThrow("build identity: git rev-parse HEAD failed:");
    expect(calls).toEqual([["rev-parse", "HEAD"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a failing status probe throws a named error", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".git"));
    const calls: string[][] = [];
    expect(() =>
      buildIdentity(root, (args) => {
        calls.push(args);
        if (args.join(" ") === "rev-parse HEAD") return SHA;
        throw new Error("fatal: unable to read status");
      }),
    ).toThrow("build identity: git status --porcelain failed:");
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
