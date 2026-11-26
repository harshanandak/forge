import { expect, test } from "bun:test";
import { validateWithSchema } from "../../../src/contract/schema.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { withReportAssembly } from "./fixtures.ts";

test("FR-CREATE1 and FR-NET1 expose one admitted device filing contract on CLI and MCP", async () => {
  await withReportAssembly(async (assembly, options) => {
    const entries = assembly.catalog
      .list()
      .filter((entry) => entry.blockId === "forge/report");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      op: "report.create",
      builtin: true,
      admitted: true,
      declaration: {
        context: "device",
        effects: ["report:write"],
        args: ["message"],
        callers: ["agent", "human"],
        idempotent: false,
        stability: "experimental",
      },
    });
    const help = await runCli(
      assembly.catalog,
      ["report", "create", "--help"],
      options,
    );
    expect(help.envelope).toMatchObject({
      ok: true,
      result: {
        operations: [expect.objectContaining({ op: "report.create" })],
      },
    });
    const mcp = createMcpHandlers(
      assembly.catalog,
      { expose: ["report"] },
      options,
    );
    const tool = mcp.listTools().find((tool) => tool.name === "report_create");
    expect(tool).toMatchObject({
      annotations: {
        openWorldHint: false,
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: { additionalProperties: false },
    });
    expect(tool?.outputSchema).toBeDefined();
    const readOnly = createMcpHandlers(assembly.catalog, {
      expose: ["report"],
      readOnly: true,
    });
    expect(readOnly.listTools().map((tool) => tool.name)).not.toContain(
      "report_create",
    );
  });
}, 30_000);

test("FR-CREATE2 accepts four kinds and declares bug as the default", async () => {
  await withReportAssembly(({ catalog }) => {
    const entry = catalog.list().find(({ op }) => op === "report.create");
    expect(entry).toBeDefined();
    const schema = entry!.inputSchema;
    expect(schema).toMatchObject({ properties: { kind: { default: "bug" } } });
    for (const kind of ["bug", "wrong", "suggest", "missing", undefined]) {
      const input = {
        message: "Show the next action",
        ...(kind === undefined ? {} : { kind }),
      };
      expect(validateWithSchema(schema, input)).toEqual([]);
    }
    return Promise.resolve();
  });
}, 30_000);

test("FR-CREATE3 refuses malformed inputs before creating the device store", async () => {
  await withReportAssembly(async (assembly, options) => {
    const mcp = createMcpHandlers(
      assembly.catalog,
      { expose: ["report"] },
      options,
    );
    for (const input of [
      {},
      { message: "" },
      { message: "   " },
      { message: "line one\nline two" },
      { message: "line one\u2028line two" },
      { message: "x".repeat(4097) },
      { message: "A report", kind: "confusing" },
      { message: "A report", project: "private" },
    ]) {
      expect(await mcp.callTool("report_create", input)).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
    }
    expect(
      await Bun.file(`${assembly.deviceRoot}/records.sqlite`).exists(),
    ).toBe(false);
  });
}, 30_000);
