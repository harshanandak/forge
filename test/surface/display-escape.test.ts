import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { operationTimeoutProblems } from "../../src/contract/operation-timeouts.ts";
import type {
  BlockManifest,
  ResultEnvelope,
} from "../../src/generated/types.ts";
import { runCli } from "../../src/surface/cli.ts";
import { runCommand } from "../../src/surface/command.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

function expectNoControls(text: string): void {
  expect(
    Array.from(text, (c) => c.charCodeAt(0)).filter(
      (code) =>
        (code < 32 && code !== 10) ||
        (code >= 127 && code <= 159) ||
        code === 0x2028 ||
        code === 0x2029,
    ),
  ).toEqual([]);
}

function expectEscaped(envelope: ResultEnvelope, escaped: string): void {
  expect(envelope.ok).toBe(false);
  if (envelope.ok) throw new Error("Expected a failure envelope");
  expectNoControls(envelope.error.message);
  expect(envelope.error.message).toContain(escaped);
}

test("different failure paths escape controls in CLI text and shared envelopes", async () => {
  for (const [control, escaped] of [
    ["\u0085", "\\u0085"],
    ["\u009b", "\\u009b"],
    ["\u007f", "\\u007f"],
    ["\u2028", "\\u2028"],
    ["\u2029", "\\u2029"],
  ] as const) {
    const entry = candidate("sample.echo", { args: [] });
    const key = `unexpected${control}key`;
    const manifest: BlockManifest = {
      schemaVersion: "forge.block/1",
      id: "example.org/sample",
      version: "1.0.0",
      authorAbi: "forge.author/v1",
      profile: "trusted-action-sync/v1",
      entry: "index.cjs",
      docs: "docs.json",
      operations: { "sample.echo": entry.declaration },
    };
    const [error] = operationTimeoutProblems(
      {
        schemaVersion: "forge.config/1",
        blocks: {
          sample: {
            source: { path: "./sample" },
            operationTimeouts: { [key]: 1000 },
          },
        },
      },
      new Map([["sample", manifest]]),
    );
    if (error === undefined) throw new Error("Expected an unknown timeout key");
    const catalog = fakeCatalog([entry], {
      ok: false,
      status: "FAIL",
      error,
      warnings: [],
    });
    const positional = await runCli(catalog, [entry.op, key, "--text"]);
    expect(positional.envelope.ok).toBe(false);
    if (positional.envelope.ok) throw new Error("Expected a failure envelope");
    const { error: positionalError } = positional.envelope;
    expect(positionalError.code).toBe("INPUT_INVALID");
    const { problems } = positionalError.observed as {
      problems: { received: string }[];
    };
    expect(problems.map(({ received }) => received)).toEqual(["[redacted]"]);
    for (const text of [
      positionalError.message,
      ...problems.map(({ received }) => received),
      positional.stdout,
    ]) {
      expectNoControls(text);
      expect(text).not.toContain(key);
      expect(text).not.toContain(escaped);
    }

    const input = { op: entry.op, [key]: true };
    for (const argv of [
      ["catalog.describe", "--input", JSON.stringify(input)],
      [entry.op, "--value", "hello"],
    ]) {
      const response = await runCli(catalog, [...argv, "--text"]);
      expectEscaped(response.envelope, escaped);
      expectNoControls(response.stdout);
      expect(response.stdout).toContain(escaped);
    }
    const handlers = createMcpHandlers(catalog);
    for (const [tool, args] of [
      ["catalog_describe", input],
      ["sample_echo", { value: "hello" }],
    ] as const) {
      const envelope = await handlers.callTool(tool, args);
      if (envelope === undefined) throw new Error("Expected a callable tool");
      expectEscaped(envelope, escaped);
    }
  }
}, 10_000);

test("display escaping preserves layout, escaped text and successful result data", async () => {
  const controls = [
    ...Array.from({ length: 32 }, (_, code) => code).filter(
      (code) => code !== 10,
    ),
    ...Array.from({ length: 33 }, (_, offset) => 127 + offset),
    0x2028,
    0x2029,
  ];
  const raw = controls.map((code) => String.fromCharCode(code)).join("");
  const escaped = controls
    .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
    .join("");
  const message = `first\n\tsecond \\u009b ${raw}`;
  const expected = `first\n\\u0009second \\u009b ${escaped}`;
  for (const ok of [true, false]) {
    const answer: ResultEnvelope = {
      ...(ok
        ? {
            ok: true as const,
            status: "OK" as const,
            op: "sample.echo",
            result: raw,
          }
        : {
            ok: false as const,
            status: "FAIL" as const,
            error: { code: "INPUT_INVALID", message, retry: "never" as const },
          }),
      warnings: [{ code: "NOTICE", message }],
    };
    const catalog = fakeCatalog([candidate()], answer);
    const cli = await runCli(catalog, ["sample.echo", "hello", "--text"]);
    const mcp = await createMcpHandlers(catalog).callTool("sample_echo", {
      value: "hello",
    });
    expectNoControls(cli.stdout);
    for (const envelope of [cli.envelope, mcp]) {
      if (envelope === undefined) throw new Error("Expected a result envelope");
      expect(envelope.warnings[0]?.message).toBe(expected);
      if (envelope.ok) expect(envelope.result).toBe(raw);
      else expect(envelope.error.message).toBe(expected);
    }
    expect(answer.warnings[0]?.message).toBe(message);
  }
}, 10_000);

test("display modes preserve selected code units and ordinary Unicode", async () => {
  const path = new URL("../../src/contract/display-text.ts", import.meta.url);
  expect(existsSync(path)).toBe(true);
  const { escapeDisplayText, quoteDisplayText } = (await import(path.href)) as {
    escapeDisplayText: (text: string, mode?: "sink" | "fragment") => string;
    quoteDisplayText: (text: string) => string;
  };
  const codes = [
    ...Array.from({ length: 32 }, (_, code) => code),
    ...Array.from({ length: 33 }, (_, offset) => 127 + offset),
    ..."\u2028\u2029\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u00ad\u200b\u200c\u200d\u2060\ufeff\u034f\ufe0f\ud800\udc00"
      .split("")
      .map((character) => character.charCodeAt(0)),
  ];
  const pairs: [string, string][] = codes.map((code) => [
    String.fromCharCode(code),
    `\\u${code.toString(16).padStart(4, "0")}`,
  ]);
  pairs.push(
    ["\u{e0001}", "\\udb40\\udc01"],
    ["\u{e0020}", "\\udb40\\udc20"],
    ["\u{e0100}", "\\udb40\\udd00"],
    ["\u{e0101}", "\\udb40\\udd01"],
    ["é e\u0301 漢 \u{1f642}", "é e\u0301 漢 \u{1f642}"],
    ["one\r\ntwo", "one\\u000d\\u000atwo"],
  );
  for (const [input, expected] of pairs) {
    const quoted = quoteDisplayText(input);
    expect(quoted).toBe(`"${expected}"`);
    expect(JSON.parse(quoted)).toBe(input);
    expect(escapeDisplayText(input)).toBe(expected.replaceAll("\\u000a", "\n"));
    expect(escapeDisplayText(quoted)).toBe(quoted);
  }
  expect(escapeDisplayText('"\\u0009', "fragment")).toBe('\\"\\\\u0009');
  expect(quoteDisplayText("\\u0009")).toBe('"\\\\u0009"');
}, 10_000);

const inputText = "é漢\u202e\u{e0020}\u009b\\u0009\u{1f642}";
const escapedText = "é漢\\u202e\\udb40\\udc20\\u009b\\u0009\u{1f642}";
const base = candidate();
const quotedAsk =
  'Forget note "example\\u0009\\\\u0009". Its text is hidden and kept only as a private backup.';
const catalog = fakeCatalog([
  { ...base, docs: { ...base.docs, summary: inputText } },
]);

const commands = {
  JSON: ["sample.echo", inputText],
  hook: ["--hook", "sample.echo"],
  text: ["sample.echo", inputText, "--text"],
  approval: ["sample.echo", quotedAsk, "--text"],
  help: ["sample.echo", "--help"],
  version: ["--version"],
  MCP: ["--mcp"],
};
test.each(Object.entries(commands))(
  "the command writes the expected %s bytes",
  async (mode, argv) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const response = await runCli(catalog, ["sample.echo", inputText]);
    input.end(JSON.stringify({ value: inputText }));
    try {
      expect(
        await runCommand(argv, {
          catalog,
          version: inputText,
          input,
          output,
          mcp: {
            async open({ output: transport }) {
              const writer = transport.getWriter();
              await writer.write(Buffer.from(response.stdout));
              writer.releaseLock();
              input.destroy();
              return {
                ok: true,
                handle: {
                  ownership: "owned",
                  value: { notifyToolsChanged: async () => {} },
                  close: async () => {},
                },
              };
            },
          },
        }),
      ).toBe(0);
      if (mode === "JSON" || mode === "hook") {
        expect(JSON.parse(written)).toEqual(response.envelope);
        expect(written).toBe(
          response.stdout.replaceAll(
            "\u202e\u{e0020}\u009b",
            "\\u202e\\udb40\\udc20\\u009b",
          ),
        );
      } else if (mode === "text")
        expect(written).toContain(`value: ${escapedText}\n`);
      else if (mode === "approval")
        expect(written).toContain(`value: ${quotedAsk}\n`);
      else if (mode === "help")
        expect(written).toContain(`    ${escapedText}\n`);
      else if (mode === "version") expect(written).toBe(`${escapedText}\n`);
      else expect(written).toBe(response.stdout);
    } finally {
      input.destroy();
      output.destroy();
    }
  },
  10_000,
);
