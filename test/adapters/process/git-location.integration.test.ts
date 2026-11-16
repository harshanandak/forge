// [integration] Every row starts a fresh Node process so the executable cache is process-local.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";

const windows = process.platform === "win32";
const node = Bun.which("node")!;
const git = realpathSync.native(windows ? Bun.which("git")! : "/usr/bin/git");
const fixture = join(import.meta.dirname, "git-location.fixture.ts");
const rows: readonly (readonly [string, string, string, boolean])[] = [
  ["project bin", "bin", ".git", false],
  ["node_modules bin", "node_modules/.bin", ".git", false],
  ["relative dot", ".", ".git", false],
  ["relative bin", "bin", ".git", false],
  ["forge ancestor", "nested/bin", ".forge", false],
  ["no git left", "bin", ".git", true],
  ["linked lane uses project bin", "bin", ".git", false],
  ["symlink into project", "bin", ".git", false],
  ...(windows
    ? [
        ["cmd shim", "bin", ".git", false] as const,
        ["bat shim", "bin", ".git", false] as const,
      ]
    : []),
] as const;

test.each(rows)(
  "git location: %s",
  (name, bin, markerName, onlyPlanted) => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "forge-git-location-")),
    );
    try {
      const project = join(root, "project");
      const planted = join(project, bin);
      const cwd =
        name === "linked lane uses project bin"
          ? join(project, ".worktrees/lane")
          : project;
      mkdirSync(planted, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(project, markerName), { recursive: true });
      if (cwd !== project)
        writeFileSync(join(cwd, ".git"), "gitdir: ../../.git/worktrees/lane\n");
      const marker = join(root, "shim-ran");
      const extension =
        name === "cmd shim"
          ? ".cmd"
          : name === "bat shim"
            ? ".bat"
            : windows
              ? ".exe"
              : "";
      const shim = join(planted, `git${extension}`);
      if (extension === ".exe") copyFileSync(node, shim);
      else {
        writeFileSync(
          shim,
          windows
            ? `@echo ran>"${marker}"\r\n`
            : `#!/bin/sh\nprintf ran > '${marker}'\n`,
        );
        chmodSync(shim, 0o755);
      }
      let entry = planted;
      if (name.startsWith("relative"))
        entry = name === "relative dot" ? "." : relative(cwd, planted);
      if (name === "symlink into project") {
        entry = join(root, "alias");
        symlinkSync(planted, entry, windows ? "junction" : "dir");
      }
      const path = onlyPlanted
        ? entry
        : [entry, "", dirname(git)].join(delimiter);
      const run = spawnSync(node, [fixture, cwd, marker, path], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        shell: false,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      });
      expect(run.status, run.stderr || run.error?.message).toBe(0);
      const result = JSON.parse(
        readFileSync(join(cwd, "result.json"), "utf8"),
      ) as {
        found: {
          kind: string;
          path?: string;
          reason?: string;
          remedy?: string;
        };
        cached: unknown;
        version: string;
        marker: boolean;
      };
      expect(result.marker).toBe(false);
      expect(existsSync(marker)).toBe(false);
      if (onlyPlanted) {
        expect(result.found.kind).toBe("unavailable");
        expect(result.found.reason).toContain("1 skipped");
        expect(result.found.remedy).toContain("outside any repository");
      } else {
        expect(result.found).toEqual({ kind: "resolved", path: git });
        expect(result.version).toStartWith("git version ");
      }
      expect(result.cached).toEqual(result.found);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
