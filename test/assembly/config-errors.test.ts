import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { blockCapture } from "../../src/assembly/capture.ts";

setDefaultTimeout(30_000);

const cases = [
  [
    "timeout typo",
    { operationTimeouts: { "check.rnu": 3000 } },
    'blocks.check.operationTimeouts["check.rnu"]',
    "did you mean check.run?",
    "Fix:",
  ],
  [
    "timeout from unbound block",
    { operationTimeouts: { "memory.search": 3000 } },
    'blocks.check.operationTimeouts["memory.search"]',
    "block is not bound",
    "Fix:",
  ],
  [
    "typo",
    { timoutMs: 3000 },
    "blocks.check.config.timoutMs",
    "3000",
    "did you mean timeoutMs?",
  ],
  [
    "type",
    { timeoutMs: "soon" },
    "blocks.check.config.timeoutMs",
    'expected integer, got "soon"',
    "Fix:",
  ],
  [
    "enum",
    { report: "sometimes" },
    "blocks.check.config.report",
    '"sometimes"',
    '["auto","json","exit-code"]',
  ],
  [
    "replacement tokens",
    { timeoutMs: "$&" },
    "blocks.check.config.timeoutMs",
    'expected integer, got "$&".',
    "Fix:",
  ],
  [
    "source",
    { source: { builtin: "forge/chekc" } },
    "blocks.check.source.builtin",
    '"forge/chekc"',
    "forge/check",
  ],
  ["yaml", "blocks: [\n", "strict YAML", "line", "Fix:"],
  [
    "quote",
    { commands: { test: 'tool "unterminated' } },
    "blocks.check.config.commands.test",
    "unclosed quote",
    '{"argv":["tool","unterminated"]}',
  ],
  [
    "shell",
    { commands: { test: "tool && other" } },
    "blocks.check.config.commands.test",
    "Shell syntax",
    '{"argv":["tool","&&","other"]}',
  ],
  [
    "budget",
    { commands: { test: "tool" }, maxOutputBytes: 1 },
    "blocks.check.config.outputHeadBytes",
    "maximum retained",
    "Fix:",
  ],
] as const;

for (const [name, config, ...messages] of cases) {
  test(`invalid config ${name} keeps its diagnosis across show and command dispatch`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-config-errors-"));
    mkdirSync(join(root, ".forge"));
    const file = join(root, ".forge/config.yaml");
    const open = blockCapture.open.bind(blockCapture);
    const capture = spyOn(blockCapture, "open").mockImplementation((path) => {
      const handle = open(path);
      return {
        ...handle,
        value: {
          read: (name, budget) =>
            name.endsWith(".cjs")
              ? new TextEncoder().encode("module.exports={};")
              : handle.value.read(name, budget),
        },
      };
    });
    writeFileSync(
      file,
      typeof config === "string"
        ? config
        : JSON.stringify({
            blocks: { check: { commands: {}, ...config }, memory: {} },
          }),
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
      providers: { env: {} },
    });
    try {
      for (const args of [["unknown-command"], ["check", "lst"]]) {
        const response = await runCli(
          assembly.catalog,
          args,
          localCall(assembly),
        );
        expect(response.exitCode).toBe(3);
        expect(response.envelope).toMatchObject({
          ok: false,
          error: { code: "UNKNOWN_COMMAND" },
        });
      }
      for (const args of [
        ["config", "show"],
        ["check", "list"],
        ["check", "run"],
      ]) {
        const response = await runCli(
          assembly.catalog,
          args,
          localCall(assembly),
        );
        expect(response.exitCode).toBe(6);
        expect(response.envelope).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID" },
        });
        if (response.envelope.ok) throw Error("Expected invalid config");
        expect(response.envelope.error.message).toContain(".forge/config.yaml");
        for (const message of messages)
          expect(response.envelope.error.message).toContain(message);
        if (args[0] === "config") {
          expect(response.envelope.result).toMatchObject({ valid: false });
          const shown = response.envelope.result as {
            effective: { blocks?: Record<string, unknown> };
            values: { pointer: string; active: boolean }[];
            instances: { name: string; enabled: boolean }[];
          };
          expect(shown.effective.blocks?.check ?? {}).not.toHaveProperty(
            "config",
          );
          expect(
            shown.values.some(
              (v) => v.active && v.pointer.startsWith("/blocks/check/"),
            ),
          ).toBe(false);
          expect(
            shown.instances.find((v) => v.name === "check")?.enabled ?? false,
          ).toBe(false);
        }
      }
      if (name !== "yaml")
        expect(
          assembly.catalog.list().some((entry) => entry.op === "memory.search"),
        ).toBe(true);
      writeFileSync(file, "blocks:\n  check:\n    commands: {}\n");
      expect(
        (
          await runCli(
            assembly.catalog,
            ["config", "show"],
            localCall(assembly),
          )
        ).envelope,
      ).toMatchObject({ ok: true, result: { valid: true } });
      expect(
        assembly.catalog.list().some((entry) => entry.op === "check.list"),
      ).toBe(true);
      // A small selection remains usable when running every declaration would exceed one receipt.
      writeFileSync(
        file,
        JSON.stringify({
          blocks: {
            check: {
              commands: Object.fromEntries(
                Array.from({ length: 20 }, (_, i) => [`test${i}`, "tool"]),
              ),
            },
          },
        }),
      );
      expect(
        (
          await runCli(
            assembly.catalog,
            ["config", "show"],
            localCall(assembly),
          )
        ).envelope,
      ).toMatchObject({ ok: true, result: { valid: true } });
    } finally {
      await assembly.close();
      capture.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
