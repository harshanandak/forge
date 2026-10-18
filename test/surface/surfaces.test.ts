import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { runHook } from "../../src/surface/hook.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { exitCode, failure } from "../../src/surface/result.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";
import { SchemaRegistry } from "../../src/contract/schema.ts";
import { PassThrough } from "node:stream";
import { runCommand } from "../../src/surface/command.ts";

test("catalog_call refuses operations outside the listed MCP exposure", async () => {
  const catalog = fakeCatalog([
    candidate("sample.allowed"),
    candidate("sample.hidden"),
    candidate("sample.private", { callers: ["human"] }),
    candidate("sample.experimental", { stability: "experimental" }),
  ]);
  for (const [exposure, op] of [
    [{ expose: ["sample.allowed"] }, "sample.hidden"],
    [{ budget: 1 }, "sample.hidden"],
    [{}, "sample.private"],
    [{}, "sample.experimental"],
  ] as const) {
    const handlers = createMcpHandlers(catalog, exposure);
    expect(await handlers.callTool("catalog_call", { op })).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
  }
  expect(catalog.calls).toHaveLength(0);
  expect(
    await createMcpHandlers(catalog, { expose: ["sample.allowed"] }).callTool(
      "catalog_call",
      { op: "sample.allowed" },
    ),
  ).toMatchObject({ ok: true });
}, 30_000);

test("CLI positionals follow declaration args rather than schema order", async () => {
  const entry = candidate("sample.ordered", { args: ["count", "value"] });
  const catalog = fakeCatalog([entry]);
  expect(
    (await runCli(catalog, [entry.op, "2", "hello"])).envelope,
  ).toMatchObject({
    ok: true,
    result: { count: 2, value: "hello" },
  });
}, 30_000);

test("CLI refuses positionals when no args are declared and explains the alternative", async () => {
  const { args: _args, ...declaration } = candidate().declaration;
  const catalog = fakeCatalog([{ ...candidate(), declaration }]);
  const reply = await runCli(catalog, ["sample.echo", "hello"]);
  expect(reply.envelope).toMatchObject({
    ok: false,
    error: { code: "INPUT_INVALID" },
  });
  expect(reply.stdout).toContain("--input");
  expect(catalog.calls).toHaveLength(0);
  expect(
    (await runCli(catalog, ["sample.echo", "--value", "hello"])).envelope.ok,
  ).toBe(true);
}, 30_000);

test("unadmitted operations stay out of discovery but named calls reach admission refusal", async () => {
  const entry = { ...candidate("pending.inspect"), admitted: false };
  const refusal = {
    ...failure("ADMISSION_REQUIRED", "Run block admit pending."),
    status: "INCOMPLETE" as const,
  };
  const catalog = fakeCatalog([entry], refusal);
  expect((await runCli(catalog, ["--help"])).stdout).not.toContain(entry.op);
  expect((await runCli(catalog, ["catalog.list"])).stdout).not.toContain(
    entry.op,
  );
  expect(
    (await runCli(catalog, ["catalog.describe", "--op", entry.op])).envelope,
  ).toMatchObject({ ok: false, error: { code: "UNKNOWN_COMMAND" } });
  expect((await runCli(catalog, ["pending.inspec"])).stdout).not.toContain(
    '"pending.inspect"',
  );
  expect(
    createMcpHandlers(catalog)
      .listTools()
      .some((tool) => tool.name === "pending_inspect"),
  ).toBe(false);
  expect(catalog.calls).toHaveLength(0);
  expect((await runCli(catalog, [entry.op, "--input", "{}"])).envelope).toEqual(
    refusal,
  );
  expect(
    (
      await runCli(catalog, [
        "catalog.call",
        "--input",
        JSON.stringify({ op: entry.op }),
      ])
    ).envelope,
  ).toEqual(refusal);
  expect(catalog.calls).toHaveLength(2);
}, 30_000);

test("a new catalog entry appears in help, describe and MCP with no surface changes", async () => {
  const catalog = fakeCatalog([candidate("fresh.inspect")]);
  expect((await runCli(catalog, ["--help"])).stdout).toContain("fresh.inspect");
  expect(
    (await runCli(catalog, ["catalog", "describe", "fresh.inspect"])).envelope,
  ).toMatchObject({ ok: true, result: { op: "fresh.inspect" } });
  expect(
    createMcpHandlers(catalog)
      .listTools()
      .map((t) => t.name),
  ).toContain("fresh_inspect");
  expect(catalog.calls).toHaveLength(0);
}, 30_000);

test("argv maps schema fields, kebab flags, JSON input and dry-run without flag leaks", async () => {
  const catalog = fakeCatalog();
  const reply = await runCli(catalog, [
    "--json",
    "sample",
    "echo",
    "hello",
    "--count=2",
    "--pre-release",
    "--dry-run",
  ]);
  expect(reply.envelope).toMatchObject({
    ok: true,
    result: { value: "hello", count: 2, preRelease: true },
  });
  expect(catalog.calls[0]).toMatchObject({
    caller: "agent",
    dryRun: true,
    input: { value: "hello", count: 2, preRelease: true },
  });
  expect(
    (await runCli(catalog, ["sample.echo", "--input", '{"value":"--text"}']))
      .envelope,
  ).toMatchObject({ ok: true, result: { value: "--text" } });
  expect(
    (await runCli(catalog, ["sample.echo", "--", "--text"])).envelope,
  ).toMatchObject({ ok: true, result: { value: "--text" } });
  for (const args of [
    ["sample.echo", "x", "--nope"],
    ["sample.echo", "--input"],
    ["sample.echo", "x", "--count", "oops"],
    ["sample.echo", "--input", "{}", "x"],
  ]) {
    expect((await runCli(catalog, args)).exitCode).toBe(6);
  }
}, 30_000);

test("MCP output schemas describe the full shared envelope", () => {
  const base = candidate();
  const handlers = createMcpHandlers(
    fakeCatalog([
      {
        ...base,
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ]),
  );
  const tool = handlers.listTools().find((t) => t.name === "sample_echo");
  const registry = new SchemaRegistry([
    { $id: "urn:tool", ...tool?.outputSchema },
  ]);
  expect(
    registry.validate("urn:tool", {
      ok: true,
      op: base.op,
      status: "OK",
      result: { value: "hello" },
      warnings: [],
    }),
  ).toEqual([]);
  expect(
    registry.validate("urn:tool", failure("NOT_FOUND", "Missing")),
  ).toEqual([]);
  expect(
    registry.validate("urn:tool", { value: "hello" }).length,
  ).toBeGreaterThan(0);
}, 30_000);

test("command entry routes hook stdin, version and absent transport into observable exits", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = "";
  output.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const options = { catalog: fakeCatalog(), version: "1.2.3", input, output };
  expect(await runCommand(["--version"], options)).toBe(0);
  expect(stdout).toBe("1.2.3\n");
  stdout = "";
  input.end('{"value":"from stdin"}');
  expect(await runCommand(["--hook", "sample.echo"], options)).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    ok: true,
    result: { value: "from stdin" },
  });
  stdout = "";
  expect(await runCommand(["--mcp"], options)).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
  input.destroy();
  output.destroy();
}, 30_000);

test("05538ad7: failures retain their full envelope and contract exit, batches stay enveloped", async () => {
  for (const [code, exit] of [
    ["NOT_FOUND", 3],
    ["REVISION_CONFLICT", 4],
    ["INPUT_INVALID", 6],
    ["INTERNAL", 1],
  ] as const) {
    const answer = failure(code, "Refused", ["sample.echo"]);
    const catalog = fakeCatalog([candidate()], answer);
    const cli = await runCli(catalog, ["sample", "echo", "x"]);
    const hook = await runHook(catalog, "sample.echo", chunks('{"value":"x"}'));
    const mcp = await createMcpHandlers(catalog).callTool("sample_echo", {
      value: "x",
    });
    expect(JSON.parse(cli.stdout)).toEqual(answer);
    expect(hook.envelope).toEqual(answer);
    expect(mcp).toEqual(answer);
    expect(cli.exitCode).toBe(exit);
    expect(hook.exitCode).toBe(exit);
    expect(exitCode(answer)).toBe(exit);
  }
  const batch = {
    ok: true as const,
    op: "sample.echo",
    status: "OK" as const,
    result: { count: 2, results: [{ ok: true }, { ok: true }] },
    warnings: [],
  };
  expect(
    (await runCli(fakeCatalog([candidate()], batch), ["sample.echo"])).envelope,
  ).toEqual(batch);
  expect(
    exitCode({
      ...failure("PROVIDER_MISSING", "Unavailable"),
      status: "INCOMPLETE",
    }),
  ).toBe(2);
}, 30_000);

test("stable budget is configurable; discovery preserves human and read-only boundaries", async () => {
  const entries = Array.from({ length: 45 }, (_, i) =>
    candidate(`sample.op${i}`),
  );
  entries.push(
    candidate("sample.private", { callers: ["human"] }),
    candidate("sample.experimental", { stability: "experimental" }),
    candidate("sample.write", { effects: ["external:network"] }),
  );
  const catalog = fakeCatalog(entries);
  const handlers = createMcpHandlers(catalog);
  expect(handlers.listTools()).toHaveLength(43);
  expect(
    handlers
      .listTools()
      .some(
        (t) => t.name === "sample_private" || t.name === "sample_experimental",
      ),
  ).toBe(false);
  expect(createMcpHandlers(catalog, { budget: 0 }).listTools()).toHaveLength(3);
  expect(
    (await handlers.callTool("catalog_call", { op: "sample.op44", input: {} }))
      ?.ok,
  ).toBe(true);
  expect(
    (await handlers.callTool("catalog_call", { op: "sample.op9", input: {} }))
      ?.ok,
  ).toBe(false);
  expect(
    (await handlers.callTool("catalog_call", { op: "sample.private" }))?.ok,
  ).toBe(false);
  expect(
    (await handlers.callTool("catalog_describe", { op: "sample.private" }))?.ok,
  ).toBe(false);
  expect(
    JSON.stringify(await handlers.callTool("catalog_list", {})),
  ).not.toContain("sample.private");
  const readonly = createMcpHandlers(catalog, { readOnly: true });
  expect(
    (await readonly.callTool("catalog_call", { op: "sample.write" }))?.ok,
  ).toBe(false);
  const write = createMcpHandlers(catalog, {
    expose: ["sample.write"],
  }).listTools()[0];
  expect(write?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
  expect(await handlers.callTool("missing_tool", {})).toBeUndefined();
  expect(() => createMcpHandlers(catalog, { budget: -1 })).toThrow();
}, 30_000);

test("generic text, suggestions and bounded hook stdin preserve actionable failures", async () => {
  const catalog = fakeCatalog();
  const typo = await runCli(catalog, ["sample", "echp"]);
  expect(typo.envelope).toMatchObject({
    ok: false,
    error: { suggest: ["sample.echo"] },
  });
  expect(
    (await runCli(catalog, ["sample.echo", "hello", "--text"])).stdout,
  ).toContain("value: hello");
  expect(
    (await runHook(catalog, "sample.echo", chunks("invalid"))).exitCode,
  ).toBe(6);
  expect(
    (await runHook(catalog, "sample.echo", chunks("{}"), {}, 1)).envelope,
  ).toMatchObject({ ok: false, error: { code: "LIMIT_EXCEEDED" } });
  expect(
    (await runHook(catalog, "sample.echo", chunks('{"value":"✓"}'))).envelope,
  ).toMatchObject({ ok: true, result: { value: "✓" } });
}, 30_000);

async function* chunks(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) yield await Promise.resolve(Uint8Array.of(byte));
}
