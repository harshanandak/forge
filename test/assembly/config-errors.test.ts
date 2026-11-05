import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { blockCapture } from "../../src/assembly/capture.ts";
import { yamlConfigCodec } from "../../src/assembly/config.ts";

setDefaultTimeout(30_000);

for (const [name, config, refused] of [
  ["newer key", { lanes: { discardIgnored: ["cache"] } }, false],
  ["distance-one typo", { labls: [] }, true],
  ["case typo", { LABELS: [] }, true],
  ["known key type", { labels: 1 }, true],
  [
    "nested newer key",
    { settings: { lanes: { discardIgnored: ["cache"] } } },
    false,
  ],
  ["nested typo", { settings: { labls: [] } }, true],
  ["known key value", { settings: { mode: "invalid" } }, true],
  [
    "many newer keys",
    {
      lanes: { discardIgnored: ["cache"] },
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`futureOption${i}`, true]),
      ),
    },
    false,
  ],
] as const) {
  test(`older block config schema handles ${name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-newer-config-"));
    mkdirSync(join(root, ".forge"));
    const file = join(root, ".forge/config.yaml");
    const text = yamlConfigCodec.encode({
      schemaVersion: "forge.config/1",
      blocks: {
        work: { source: { builtin: "forge/work" }, config },
        check: { source: { builtin: "forge/check" }, config: { commands: {} } },
      },
    });
    writeFileSync(file, text);
    const open = blockCapture.open.bind(blockCapture);
    const capture = spyOn(blockCapture, "open").mockImplementation((path) => {
      const handle = open(path);
      return {
        ...handle,
        value: {
          ...handle.value,
          read: (name, budget) =>
            path.replaceAll("\\", "/").replace(/\/$/, "").endsWith("/work") &&
            name === "schemas/config.json"
              ? new TextEncoder().encode(
                  JSON.stringify({
                    type: "object",
                    properties: {
                      idPrefix: { type: "string" },
                      labels: { type: "array", items: { type: "string" } },
                      settings: {
                        type: "object",
                        properties: {
                          labels: { type: "array", items: { type: "string" } },
                          mode: { enum: ["auto", "manual"] },
                        },
                        additionalProperties: false,
                      },
                    },
                    additionalProperties: false,
                  }),
                )
              : name.endsWith(".cjs")
                ? new TextEncoder().encode(
                    "module.exports={'check.list':()=>({commands:[],receiptChecks:[]})};",
                  )
                : handle.value.read(name, budget),
        },
      };
    });
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
      providers: { env: {} },
    });
    try {
      for (const args of refused
        ? [["config", "show"]]
        : [
            ["config", "show"],
            ["check", "list"],
            ["check", "list"],
            ["config", "show"],
          ]) {
        const { envelope } = await runCli(
          assembly.catalog,
          args,
          localCall(assembly),
        );
        if (refused) {
          expect(envelope).toMatchObject({
            ok: false,
            error: { code: "INPUT_INVALID" },
          });
          if (envelope.ok) throw Error("Expected invalid config");
          expect(envelope.error.message).toContain("blocks.work.config");
          if (name.includes("typo"))
            expect(envelope.error.message).toContain("did you mean labels?");
        } else {
          expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
          expect(envelope.warnings, args.join(" ")).toHaveLength(1);
          expect(envelope.warnings[0]?.message).toContain(
            `blocks.work.config.${name === "nested newer key" ? "settings." : ""}lanes`,
          );
          expect(envelope.warnings[0]?.message).toContain(
            "newer Forge version",
          );
          expect(envelope.warnings[0]?.message).toContain("ignored");
          expect(envelope.warnings[0]?.message).toContain("upgrade");
          if (args[0] === "config")
            expect(envelope.result).not.toHaveProperty(
              `effective.blocks.work.config.${name === "nested newer key" ? "settings." : ""}lanes`,
            );
          if (name === "many newer keys")
            for (let i = 0; i < 40; i++)
              expect(envelope.warnings[0]?.message).toContain(
                `blocks.work.config.futureOption${i}`,
              );
        }
      }
      if (!refused) {
        const preview = await runCli(
          assembly.catalog,
          [
            "config",
            "preview",
            "--input",
            JSON.stringify({
              patch: [{ op: "set", path: "work.labels", value: ["p2"] }],
            }),
          ],
          localCall(assembly),
        );
        expect(preview.envelope).toMatchObject({
          ok: true,
          result: { valid: true },
        });
        expect(
          preview.envelope.warnings,
          JSON.stringify(preview.envelope.warnings),
        ).toHaveLength(1);
        expect(preview.envelope.warnings[0]?.code).toBe("CONFIG_KEY_IGNORED");
        expect((preview.envelope.result as { text: string }).text).toContain(
          "discardIgnored",
        );
        const { caller, context } = localCall(assembly);
        const failed = await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: "invalid-input",
          op: "check.list",
          input: { unexpected: true },
          caller,
          context: context ?? {},
        });
        expect(failed).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID" },
          warnings: [{ code: "CONFIG_KEY_IGNORED" }],
        });
        expect(failed.warnings).toHaveLength(1);
      }
      expect(readFileSync(file, "utf8")).toBe(text);
      if (name === "newer key") {
        const localBlock = join(root, "blocks/work");
        cpSync(
          resolve(import.meta.dirname, "../../src/blocks/work"),
          localBlock,
          { recursive: true },
        );
        const added = await runCli(
          assembly.catalog,
          ["block", "add", "./blocks/work"],
          localCall(assembly),
        );
        expect(added.envelope.ok, JSON.stringify(added.envelope)).toBe(true);
        expect(added.envelope.warnings).toHaveLength(1);
        expect(added.envelope.warnings[0]?.code).toBe("CONFIG_KEY_IGNORED");
        expect(readFileSync(file, "utf8")).toContain("discardIgnored");
      }
    } finally {
      await assembly.close();
      capture.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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
