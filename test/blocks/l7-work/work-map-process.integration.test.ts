import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import {
  advisoryGitAvailable,
  advisoryProject,
  laneCli,
} from "./lane-repository-fixture.ts";

const plan = { title: "Shared file", expectedFiles: ["src/ui/ask.rs"] };
type GitEvent = { event: string; sid: string; argv?: string[] };

test.each(["script", "unknown native executable", "live lease"] as const)(
  "advisory process accounting with %s preserves the CLI claim",
  async (kind) => {
    await advisoryProject(
      ".worktrees/briefs/overlap.md",
      async ({ good }, repo, root) => {
        const holder = String((await good("issue.create", plan)).id);
        const candidate = String((await good("issue.create", plan)).id);
        await good("issue.claim", { id: holder });
        if (kind !== "live lease") {
          for (let n = 1; n <= (kind === "script" ? 31 : 1); n++)
            await good("issue.link", {
              id: holder,
              relation: "delivers",
              url: `https://github.com/example/overlap/pull/${n}/`,
            });
          await good("issue.release", { id: holder });
        }

        const bin = mkdtempSync(join(homedir(), "forge-advisory-bin-"));
        try {
          const launches = join(root, "launcher-pids.jsonl");
          const launcherStarted = join(root, "launcher-started");
          const gitTrace = join(root, "git-trace.jsonl");
          const fixture =
            kind === "script"
              ? join(root, "native-fixture.cjs")
              : join(repo, "pr");
          writeFileSync(launches, "");
          writeFileSync(gitTrace, "");
          writeFileSync(
            fixture,
            `require("node:fs").appendFileSync(${JSON.stringify(launches)},
          JSON.stringify([process.ppid, process.pid]) + "\\n");
          console.log(JSON.stringify({state: "OPEN", headRefName: "feat/released"}));`,
          );
          const windows = process.platform === "win32";
          const launcher = join(
            bin,
            windows ? (kind === "script" ? "gh.cmd" : "gh.exe") : "gh",
          );
          if (kind === "script") {
            const forward = `"${process.execPath}" "${fixture}"`;
            writeFileSync(
              launcher,
              windows
                ? `@echo off\r\n>"${launcherStarted}" echo started\r\n${forward} %*\r\n`
                : `#!/bin/sh\nprintf '%s\\n' "$$" >"${launcherStarted}"\n${forward} "$@"\nexit $?\n`,
            );
          } else if (kind === "unknown native executable") {
            const node = spawnSync("node", ["-p", "process.execPath"], {
              encoding: "utf8",
              timeout: 5000,
            });
            expect(node.status, node.stderr).toBe(0);
            copyFileSync(node.stdout.trim(), launcher);
          }
          if (!windows && kind !== "live lease") chmodSync(launcher, 0o755);
          writeFileSync(
            join(bin, ".gitconfig"),
            `[trace2]\n\teventTarget = ${gitTrace.replaceAll("\\", "/")}\n`,
          );

          const cliEnv = {
            PATH: [bin, process.env.PATH ?? process.env.Path].join(delimiter),
            PATHEXT: ".CMD;.EXE",
            HOME: bin,
            USERPROFILE: bin,
            FORGE_DEVICE_ID: "lane-fixture",
          };
          const linuxAdvisory = await advisoryGitAvailable(repo, cliEnv);
          const gitOnPath = Bun.which("git", { PATH: cliEnv.PATH, cwd: repo });
          if (
            kind === "live lease" &&
            process.platform === "linux" &&
            existsSync("/var/lib/dpkg/info/git.md5sums") &&
            gitOnPath &&
            realpathSync(gitOnPath) === "/usr/bin/git"
          )
            expect(linuxAdvisory).toBe(true);
          const input = JSON.stringify({ id: candidate, ttlSeconds: 600 });
          const args = ["issue", "claim", "--input", input];
          const claim = laneCli(root, repo, args, "reader", cliEnv);
          expect(claim).toMatchObject({
            exit: 0,
            ok: true,
            result: { id: candidate },
          });
          const { generation, expiresAt } = claim.result;
          expect(typeof generation).toBe("number");
          expect(typeof expiresAt).toBe("string");
          expect(await good("issue.show", { id: candidate })).toMatchObject({
            id: candidate,
            lease: { generation, expiresAt },
          });

          const launchLog = readFileSync(launches, "utf8");
          expect(launchLog, "interpreter and native child PIDs").toBe("");
          expect(existsSync(launcherStarted)).toBe(false);
          const events = readFileSync(gitTrace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as GitEvent);
          const advisory = events.filter(
            ({ event, argv }) =>
              event === "start" &&
              (argv?.includes("--no-lazy-fetch") ||
                (argv?.includes("--absolute-git-dir") &&
                  argv?.includes("--git-common-dir"))),
          );
          expect(advisory.length).toBe(linuxAdvisory ? 4 : 0);
          const tree = events.filter(({ sid }) =>
            advisory.some(
              (start) => sid === start.sid || sid.startsWith(start.sid + "/"),
            ),
          );
          const childStarts = tree.filter(
            ({ event }) => event === "child_start",
          );
          expect(childStarts).toEqual([]);
          expect(tree.filter(({ event }) => event === "start")).toHaveLength(
            advisory.length,
          );
          expect(advisory.length).toBeLessThanOrEqual(64);

          const warnings = (
            claim as typeof claim & Pick<ResultEnvelope, "warnings">
          ).warnings.filter(({ code }) => code.startsWith("WORK_FILE"));
          if (!linuxAdvisory) {
            expect(warnings).toEqual([
              {
                code: "WORK_FILE_MAP_INCOMPLETE",
                message:
                  "File overlap map incomplete (advisory Git process cost unavailable). Some overlap may be missing.",
              },
            ]);
          } else if (kind === "live lease") {
            expect(warnings.map(({ code }) => code)).toEqual([
              "WORK_FILE_OVERLAP",
            ]);
            expect(warnings[0]?.message).toContain(holder);
          } else {
            expect(warnings.map(({ code }) => code)).toEqual([
              "WORK_FILE_MAP_INCOMPLETE",
            ]);
            expect(warnings[0]?.message).toContain("pull-unavailable");
          }
        } finally {
          rmSync(bin, { recursive: true, force: true });
        }
      },
    );
  },
  30_000,
);
