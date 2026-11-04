import { expect, test } from "bun:test";
import { operationTimeoutProblems } from "../../src/contract/operation-timeouts.ts";
import type {
  BlockManifest,
  ResultEnvelope,
} from "../../src/generated/types.ts";
import { runCli } from "../../src/surface/cli.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

function expectNoControls(text: string): void {
  expect(
    Array.from(text, (c) => c.charCodeAt(0)).filter(
      (code) =>
        (code < 32 && code !== 9 && code !== 10) ||
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
    const input = { op: entry.op, [key]: true };
    for (const argv of [
      [entry.op, key],
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
      (code) => code !== 9 && code !== 10,
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
  const expected = `first\n\tsecond \\u009b ${escaped}`;
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
