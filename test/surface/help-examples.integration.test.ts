import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { childStep } from "../child-step.ts";

const { createAssembly, localCall } = (await import(
  pathToFileURL(resolve("dist/src/assembly/index.js")).href
)) as typeof import("../../src/assembly/index.ts");
const { runCli } = (await import(
  pathToFileURL(resolve("dist/src/surface/cli.js")).href
)) as typeof import("../../src/surface/cli.ts");

const windows = process.platform === "win32";
const shells = ["POSIX", ...(windows ? ["PowerShell 5.1"] : [])];
for (const shell of shells) {
  test(`rendered scalar and JSON examples run in ${shell}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-help-example-"));
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  work: {}\n  memory: {}\n",
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      let shellStarts = 0;
      const node = Bun.which("node");
      if (!node) throw new Error("Node runtime required");
      const cases: { op: string; example: string }[] = [];
      for (const op of ["issue.create", "memory.add", "config.preview"]) {
        const help = await runCli(
          assembly.catalog,
          [op, "--help"],
          localCall(assembly),
        );
        if (op === "issue.create") {
          const invalid = await runCli(
            assembly.catalog,
            [op],
            localCall(assembly),
          );
          expect(invalid.exitCode).toBe(6);
          if (invalid.envelope.ok) throw new Error("expected input refusal");
          const example = (
            invalid.envelope.error.observed as { example: string }
          ).example;
          expect(example).toBe(
            'forge issue create --title "First task" --kind task',
          );
          expect(help.stdout).toContain(`Example: ${example}`);
        }
        const examples = help.stdout.split("\n").flatMap((line) => {
          const match =
            /^ {4}(?:Example: )?(?:(POSIX|PowerShell 5.1): )?(forge .+)$/.exec(
              line,
            );
          return match && (match[1] === undefined || match[1] === shell)
            ? [match[2]!]
            : [];
        });
        expect(examples).toHaveLength(1);
        cases.push({ op, example: examples[0]! });
      }
      const bin = resolve("dist/bin/forge.js").replaceAll("\\", "/");
      const bash = windows
        ? join(
            process.env.ProgramFiles ?? "C:/Program Files",
            "Git/bin/bash.exe",
          )
        : "bash";
      const executable =
        shell === "POSIX"
          ? bash
          : join(
              process.env.SystemRoot ?? "C:/Windows",
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            );
      const marker = "FORGE_HELP_EXAMPLE_END";
      // Keep each command's exit code: a later successful example must not hide a failure.
      const script =
        shell === "POSIX"
          ? `forge() { '${node.replaceAll("\\", "/")}' '${bin}' "$@"; }; ` +
            cases
              .map(
                ({ op, example }) =>
                  `printf 'START ${op}\\n' >&2; ${example}; code=$?; if [ "$code" -ne 0 ]; then exit "$code"; fi; printf '\\n${marker}\\n'`,
              )
              .join("; ")
          : `$ErrorActionPreference = 'Stop'; function forge { & '${node}' '${bin}' @args }; ` +
            cases
              .map(
                ({ op, example }) =>
                  `$step = [Diagnostics.Stopwatch]::StartNew(); [Console]::Error.WriteLine('START ${op}'); ${example}; $code = $LASTEXITCODE; [Console]::Error.WriteLine('END ${op} after ' + $step.ElapsedMilliseconds + ' ms'); if ($code -ne 0) { exit $code }; [Console]::Out.WriteLine('${marker}')`,
              )
              .join("; ");
      const args =
        shell === "POSIX"
          ? ["-c", script]
          : ["-NoProfile", "-NonInteractive", "-Command", script];
      const result = await childStep(`${shell} help examples`, () => {
        shellStarts += 1;
        const result = spawnSync(executable, args, {
          cwd: root,
          env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        });
        const diagnostic = `${result.stdout}\n${result.stderr}`;
        expect(result.error, diagnostic).toBeUndefined();
        expect(result.status, diagnostic).toBe(0);
        return result;
      });
      const outputs = result.stdout.split(marker).filter((part) => part.trim());
      expect(outputs).toHaveLength(cases.length);
      for (const [index, { op, example }] of cases.entries()) {
        const diagnostic = `${shell}: ${example}\n${result.stdout}\n${result.stderr}`;
        expect(result.error, diagnostic).toBeUndefined();
        expect(result.stdout, diagnostic).not.toContain("INPUT_INVALID");
        expect(result.status, diagnostic).toBe(0);
        expect(JSON.parse(outputs[index]!)).toMatchObject({
          ok: true,
          ...(op === "issue.create"
            ? { result: { title: "First task", kind: "task" } }
            : op === "memory.add"
              ? {
                  result: {
                    note: {
                      text: { text: "The release job needs a clean tree" },
                    },
                  },
                }
              : {}),
        });
      }
      expect(shellStarts, "all examples share one shell session").toBe(1);
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}
