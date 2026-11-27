import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { advisoryProject, laneCli } from "./lane-repository-fixture.ts";

const plan = { title: "Shared file", expectedFiles: ["src/ui/ask.rs"] };
const mapWarnings = (reply: object) =>
  (reply as Pick<ResultEnvelope, "warnings">).warnings.filter(({ code }) =>
    code.startsWith("WORK_FILE"),
  );
const hasIncompleteMap = (reply: object) =>
  mapWarnings(reply).some(({ code }) => code === "WORK_FILE_MAP_INCOMPLETE");

test.each(["script", "unknown native executable", "GitHub CLI build"] as const)(
  "advisory process accounting with %s preserves the CLI claim",
  async (kind) => {
    await advisoryProject(
      ".worktrees/briefs/overlap.md",
      async ({ good }, repo, root) => {
        const holder = String((await good("issue.create", plan)).id);
        const candidate = String((await good("issue.create", plan)).id);
        await good("issue.claim", { id: holder });
        for (let n = 1; n <= (kind === "script" ? 31 : 1); n++)
          await good("issue.link", {
            id: holder,
            relation: "delivers",
            url: `https://github.com/example/overlap/pull/${n}/`,
          });
        await good("issue.release", { id: holder });

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
          JSON.stringify([process.ppid, process.pid, process.argv.slice(2)]) + "\\n");
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
          } else {
            const go = join(root, "go-fixture");
            mkdirSync(join(go, "cmd", "gh"), { recursive: true });
            writeFileSync(
              join(go, "go.mod"),
              "module github.com/cli/cli/v2\n\ngo 1.20\n",
            );
            writeFileSync(
              join(go, "cmd", "gh", "main.go"),
              `package main
import ("os"; "strconv")
func main() {
    want := []string{"pr", "view", "https://github.com/example/overlap/pull/1", "--json", "state,headRefName"}
    if len(os.Args) != len(want) + 1 { panic("wrong argument count") }
    for i, arg := range want {
        if os.Args[i + 1] != arg { panic("wrong argument") }
    }
    f, err := os.OpenFile(${JSON.stringify(launches)}, os.O_WRONLY|os.O_APPEND, 0)
    if err != nil { panic(err) }
    defer f.Close()
    if _, err = f.WriteString("[" + strconv.Itoa(os.Getppid()) + "," + strconv.Itoa(os.Getpid()) + "]\\n"); err != nil { panic(err) }
    os.Stdout.WriteString(${JSON.stringify('{"state":"OPEN","headRefName":"feat/released"}')})
}`,
            );
            const compiled = spawnSync(
              "go",
              ["build", "-o", launcher, "./cmd/gh"],
              {
                cwd: go,
                env: {
                  ...process.env,
                  CGO_ENABLED: "0",
                  GOPROXY: "off",
                  GOTOOLCHAIN: "local",
                },
                encoding: "utf8",
                timeout: 15_000,
                windowsHide: true,
              },
            );
            expect(
              compiled.status,
              compiled.error?.message ?? compiled.stderr,
            ).toBe(0);
          }
          if (!windows) chmodSync(launcher, 0o755);
          writeFileSync(
            join(bin, ".gitconfig"),
            `[trace2]\n\teventTarget = ${gitTrace.replaceAll("\\", "/")}\n`,
          );

          const result = laneCli(
            root,
            repo,
            [
              "issue",
              "claim",
              "--input",
              JSON.stringify({ id: candidate, ttlSeconds: 600 }),
            ],
            "reader",
            {
              PATH: [bin, process.env.PATH ?? process.env.Path].join(delimiter),
              PATHEXT: ".CMD;.EXE",
              HOME: bin,
              USERPROFILE: bin,
              FORGE_DEVICE_ID: "lane-fixture",
              GH_TOKEN: "fixture-token",
            },
          );
          expect(result).toMatchObject({
            exit: 0,
            ok: true,
            result: { id: candidate },
          });
          const trees = readFileSync(launches, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean);
          const gitProcesses = readFileSync(gitTrace, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.includes('"event":"start"'));
          expect(gitProcesses.length).toBeGreaterThan(0);
          if (kind !== "GitHub CLI build") {
            expect(trees, "batch/interpreter and native child PIDs").toEqual(
              [],
            );
            expect(existsSync(launcherStarted)).toBe(false);
            expect(hasIncompleteMap(result)).toBe(true);
          } else {
            expect(trees).toHaveLength(1);
            expect(JSON.parse(trees[0]!)).toEqual([
              expect.any(Number),
              expect.any(Number),
            ]);
            expect(hasIncompleteMap(result)).toBe(false);
            expect(mapWarnings(result)[0]?.message).toContain("feat/released");
          }
          expect(
            gitProcesses.length * (windows ? 2 : 1) + trees.length * 2,
          ).toBeLessThanOrEqual(64);
        } finally {
          rmSync(bin, { recursive: true, force: true });
        }
      },
    );
  },
  30_000,
);
