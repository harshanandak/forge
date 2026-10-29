import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { childStep } from "../child-step.ts";
import { createProcessPort } from "../../src/adapters/process/index.ts";

const { createAssembly, localCall } = (await import(
  pathToFileURL(resolve("dist/src/assembly/index.js")).href
)) as typeof import("../../src/assembly/index.ts");
const { runCli } = (await import(
  pathToFileURL(resolve("dist/src/surface/cli.js")).href
)) as typeof import("../../src/surface/cli.ts");

const windows = process.platform === "win32";
const shells = ["POSIX", ...(windows ? ["PowerShell 5.1"] : [])];
const children = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
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
    const runExamples = async () => {
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
      const result = await childStep(`${shell} help examples`, async () => {
        shellStarts += 1;
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env))
          if (value !== undefined) env[key] = value;
        env.FORGE_DEVICE_ROOT = join(root, "device");
        const found = children.resolve(executable, env);
        if (found.kind !== "resolved")
          throw new Error(`${executable} is unavailable`);
        let outputBytes = 0;
        const result = await children.run(found, args, {
          cwd: root,
          env,
          timeoutMs: 20_000,
          maxOutputBytes: 1_000_000,
          observer: {
            push(_stream, chunk) {
              outputBytes += chunk.byteLength;
            },
          },
        });
        const op = [...result.stderr.matchAll(/^START ([^\r\n]+)/gm)].at(
          -1,
        )?.[1];
        const example = cases.find((item) => item.op === op)?.example;
        const step = `${shell}: ${op ?? "shell startup"}: ${example ?? ""}`;
        if (result.truncated)
          throw new Error(
            `${step}: output truncated after ${outputBytes} bytes`,
          );
        const diagnostic = `${shell}: ${op ?? "shell startup"}: ${example ?? ""}\n${result.stdout}\n${result.stderr}`;
        expect(result.timedOut, diagnostic).toBe(false);
        expect(result.exitCode, diagnostic).toBe(0);
        expect(
          result.stdout.trimEnd().endsWith(marker),
          `${step}: missing final frame terminator`,
        ).toBe(true);
        return result;
      });
      const outputs = result.stdout.split(marker);
      outputs.pop();
      for (const [index, { op, example }] of cases.entries()) {
        await childStep(`${shell}: ${op}: ${example}`, () => {
          const diagnostic = `${shell}: ${example}\n${result.stdout}\n${result.stderr}`;
          expect(outputs, diagnostic).toHaveLength(cases.length);
          expect(result.timedOut, diagnostic).toBe(false);
          expect(outputs[index]!, diagnostic).not.toContain("INPUT_INVALID");
          expect(result.exitCode, diagnostic).toBe(0);
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
        });
      }
      expect(shellStarts, "all examples share one shell session").toBe(1);
    };
    await childStep(`${shell} help session`, runExamples, async () => {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    });
  }, 120_000);
}

test.each([
  "stall",
  "bad-json",
  "missing",
  "mismatch",
  "bad-exit",
  "invalid",
  "overflow",
])(
  "help regression: %s identifies the example and stops its child",
  async (mode) => {
    const probe = mkdtempSync(join(tmpdir(), "forge-help-fault-"));
    const record = join(probe, "child.json");
    const injector = resolve("test/surface/fixtures/help-fault.cjs");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    Object.assign(env, {
      HELP_FAULT: mode,
      HELP_FAULT_ROOT: probe,
      NODE_OPTIONS: `--require=${JSON.stringify(injector)}`,
      FORGE_DEVICE_ROOT: join(probe, "device"),
    });
    const child = () => {
      const data = JSON.parse(readFileSync(record, "utf8")) as {
        pid: number;
        cwd: string;
      };
      if (
        !resolve(data.cwd).startsWith(resolve(tmpdir(), "forge-help-example-"))
      )
        throw new Error("Unexpected fault directory");
      return data;
    };
    let aliveAtFailure: boolean | undefined;
    let observed = "";
    try {
      const port = children;
      const shell = windows ? "PowerShell 5.1" : "POSIX";
      const result = await port.run(
        { kind: "resolved", path: process.execPath },
        [
          "test",
          "--test-name-pattern",
          `^rendered scalar and JSON examples run in ${shell}$`,
          "test/surface/help-examples.integration.test.ts",
        ],
        {
          cwd: process.cwd(),
          env,
          timeoutMs: 25_000,
          maxOutputBytes: 1_000_000,
          observer: {
            push(_stream, chunk) {
              observed += Buffer.from(chunk).toString("utf8");
              if (
                aliveAtFailure === undefined &&
                observed.includes("(fail)") &&
                existsSync(record)
              ) {
                try {
                  process.kill(child().pid, 0);
                  aliveAtFailure = true;
                } catch {
                  aliveAtFailure = false;
                }
              }
            },
          },
        },
      );
      const output = result.stdout + result.stderr;
      expect(result.exitCode, output).toBe(1);
      expect(result.timedOut, output).toBe(false);
      expect(output).toMatch(/after \d+ ms/);
      if (mode === "stall") {
        expect(aliveAtFailure, output).toBe(false);
        expect(output).not.toContain("EBUSY");
      } else if (mode === "overflow") {
        expect(output).toMatch(
          /config\.preview: forge config preview[^\n]*truncated[^\n]*\d+ bytes/,
        );
      } else {
        expect(output).toContain("memory.add");
        expect(output).toContain("forge memory add --input");
        expect(output).toMatch(
          /error: [^\n]*memory\.add: forge memory add --input/,
        );
      }
      expect(existsSync(child().cwd), output).toBe(false);
    } finally {
      if (existsSync(record))
        rmSync(child().cwd, { recursive: true, force: true });
      rmSync(probe, { recursive: true, force: true });
    }
  },
  30_000,
);
