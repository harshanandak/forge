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
import { pathToFileURL } from "node:url";
import { gitExecutable } from "../../../tools/git-executable.ts";
import { gitFixtureDirectory } from "../../fixtures/git-resolution.ts";

const windows = process.platform === "win32";
const node = Bun.which("node")!;
const git = gitExecutable();
const fixture = join(import.meta.dirname, "git-location.fixture.ts");
const hookFile = join(
  import.meta.dirname,
  "../../../templates/delivery/skills/forge-build/done-claim.mjs",
);
const rows: readonly (readonly [string, string, string, boolean])[] = [
  ["project bin", "bin", ".git", false],
  ["node_modules bin", "node_modules/.bin", ".git", false],
  ["relative dot", ".", ".git", false],
  ["relative bin", "bin", ".git", false],
  ["forge ancestor", "nested/bin", ".forge", false],
  ["no git left", "bin", ".git", true],
  ["linked lane uses project bin", "bin", ".git", false],
  ["symlink into project", "bin", ".git", false],
  ["completion hook", "node_modules/.bin", ".git", false],
  ["completion hook no safe git", "node_modules/.bin", ".git", true],
  ["home device store", "scoop/shims", ".forge", false],
  ["home local bin", ".local/bin", ".forge", false],
  ["home project config", "scoop/shims", ".forge", true],
  ["home project identity", "scoop/shims", ".forge", true],
  ["repository under home", "repo/bin", ".forge", true],
  ["discovery warms cache", "bin", ".git", false],
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
    const homeRow =
      name.startsWith("home ") || name === "repository under home";
    const root = realpathSync.native(
      homeRow
        ? gitFixtureDirectory("forge-git-location-")
        : mkdtempSync(join(tmpdir(), "forge-git-location-")),
    );
    try {
      const project = join(root, "project");
      const planted =
        name === "discovery warms cache"
          ? join(root, "tools")
          : join(project, bin);
      const cwd =
        name === "linked lane uses project bin"
          ? join(project, ".worktrees/lane")
          : project;
      mkdirSync(planted, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(project, markerName), { recursive: true });
      if (name === "home project config")
        writeFileSync(join(project, ".forge/config.yaml"), "{}");
      if (name === "home project identity")
        writeFileSync(join(project, ".forge/project.json"), "{}");
      if (name === "repository under home")
        mkdirSync(join(project, "repo/.git"));
      if (name === "discovery warms cache") {
        rmSync(join(project, ".git"), { recursive: true });
        writeFileSync(join(project, ".git"), "gitdir: ../unavailable\n");
      }
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
      if (homeRow) {
        rmSync(shim);
        if (windows) {
          rmSync(planted, { recursive: true });
          symlinkSync(dirname(git), planted, "junction");
        } else symlinkSync(git, shim);
      }
      if (name.startsWith("relative"))
        entry = name === "relative dot" ? "." : relative(cwd, planted);
      if (name === "symlink into project") {
        entry = join(root, "alias");
        symlinkSync(planted, entry, windows ? "junction" : "dir");
      }
      const path =
        onlyPlanted || homeRow
          ? entry
          : [entry, "", dirname(git)].join(delimiter);
      const hook = name.startsWith("completion hook");
      const preload = join(root, "git-marker.cjs");
      writeFileSync(
        preload,
        `if(/[\\\\/]git(?:\\.exe)?$/i.test(process.execPath))require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`,
      );
      const run = spawnSync(
        node,
        hook ? [hookFile] : [fixture, cwd, marker, path, name],
        {
          cwd,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
          shell: false,
          env: {
            PATH: hook ? path : process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TMPDIR: tmpdir(),
            TEMP: tmpdir(),
            TMP: tmpdir(),
            ...(hook
              ? { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }
              : {}),
            ...(homeRow ? { HOME: project, USERPROFILE: project } : {}),
          },
          ...(hook
            ? { input: JSON.stringify({ cwd, last_assistant_message: "done" }) }
            : {}),
        },
      );
      expect(existsSync(marker)).toBe(false);
      expect(run.status, run.stderr || run.error?.message).toBe(0);
      if (hook) return;
      const result = JSON.parse(
        readFileSync(join(cwd, "result.json"), "utf8"),
      ) as {
        found: Record<string, string>;
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

test("lane tier preserves Git refusal diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-tier-refusal-"));
  try {
    mkdirSync(join(root, ".git"));
    const module = pathToFileURL(
      join(import.meta.dirname, "../../../tools/lane-tier.ts"),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import {laneTier} from ${JSON.stringify(module)};try{laneTier(${JSON.stringify(root)})}catch(error){console.log(error.message)}`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: root, Path: root },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 skipped PATH entries");
    expect(result.stdout).toContain("Install Git outside any repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
