import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { renderExample } from "../../src/contract/example.ts";
import {
  authoredInputs,
  exampleShells,
  scalarExamples,
} from "./fixtures/scalar-examples.ts";

setDefaultTimeout(30_000);

const windows = process.platform === "win32";
const bash =
  Bun.which("bash") ??
  (windows
    ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
    : undefined);
const system = process.env.SystemRoot ?? "C:/Windows";
const executables = [
  bash,
  windows
    ? join(system, "System32/WindowsPowerShell/v1.0/powershell.exe")
    : undefined,
  windows ? join(system, "System32/cmd.exe") : undefined,
];

const examples = [
  ...scalarExamples.map(({ value }) => ({
    op: "sample.echo",
    input: { value },
    schema: { type: "object", properties: { value: { type: "string" } } },
  })),
  ...authoredInputs.map(({ input }) => ({
    op: "sample.run",
    input,
    schema: {},
  })),
];

for (const [index, shell] of exampleShells.entries()) {
  const executable = executables[index];
  test.skipIf(shell !== "POSIX" && process.platform !== "win32")(
    `rendered example inputs reach the CLI exactly in ${shell}`,
    () => {
      if (!executable) throw new Error(`${shell} executable required`);
      const node = Bun.which("node");
      if (!node) throw new Error("Node runtime required");
      const fixture = resolve("test/surface/fixtures/echo-example.mjs");
      const quotePath = (path: string) =>
        shell === "cmd"
          ? `"${path}"`
          : `'${path.replaceAll("\\", "/").replaceAll("'", shell === "POSIX" ? "'\\''" : "''")}'`;
      const command = `${shell === "PowerShell 5.1" ? "& " : ""}${quotePath(node)} ${quotePath(fixture)}`;
      const commands = examples.map(({ op, input, schema }) => {
        const rendered = renderExample(
          op,
          { title: "Echo", summary: "Echo.", examples: [{ input }] },
          schema,
        );
        const lines = rendered.split("\n    ");
        const line =
          lines.length === 1
            ? lines[0]!
            : lines
                .find((item) => item.startsWith(`${shell}: `))
                ?.slice(shell.length + 2);
        if (!line) throw new Error(`Missing ${shell} example: ${rendered}`);
        return line.replace(/^forge /, `${command} `);
      });
      const script = commands.join(shell === "cmd" ? " & " : "\n");
      const args =
        shell === "POSIX"
          ? ["-c", script]
          : shell === "cmd"
            ? ["/d", "/v:off", "/s", "/c", `"${script}"`]
            : ["-NoProfile", "-NonInteractive", "-Command", script];
      const result = spawnSync(executable, args, {
        encoding: "utf8",
        timeout: 20_000,
        ...(shell === "cmd" ? { windowsVerbatimArguments: true } : {}),
      });
      const diagnostic = `${shell}\n${script}\n${result.stdout}\n${result.stderr}`;
      expect(result.error, diagnostic).toBeUndefined();
      expect(result.status, diagnostic).toBe(0);
      const outputs = result.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as unknown);
      expect(outputs, diagnostic).toEqual(
        examples.map(({ op, input }) => ({
          ok: true,
          op,
          status: "OK",
          result: input,
          warnings: [],
        })),
      );
    },
    30_000,
  );
}
