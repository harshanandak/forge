import type { Tool } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, setDefaultTimeout, test } from "bun:test";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";
import {
  isRfc3339DateTime,
  SchemaRegistry,
  validateWithSchema,
} from "../../src/contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

setDefaultTimeout(30_000);
const common = SCHEMA_DOCUMENTS.find((doc) =>
  String(doc.$id).endsWith("/schemas/common.json"),
) as { $defs: Record<string, object> };
const dated = {
  $defs: { Text: { type: "string", minLength: 6 } },
  type: "object",
  required: ["text", "at"],
  properties: {
    text: { $ref: "#/$defs/Text" },
    at: common.$defs.Timestamp,
    seen: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};
const scalar = { type: "string" };
const entry = (
  op: string,
  inputSchema: Readonly<Record<string, unknown>>,
  builtin: boolean,
) => ({
  ...candidate(op),
  blockId: "example.org/sample",
  declaredOp: op,
  builtin,
  inputSchema,
});
const catalog = fakeCatalog([
  entry("sample.dated", dated, false),
  entry("sample.text", scalar, true),
]);
const valid = "2016-12-31T23:59:59Z";
const args = (patch: object) => ({ text: "abcdef", at: valid, ...patch });
const dates = [
  "2016-12-31T23:59:59Z 2016-12-31T23:59:60Z 2016-02-29T00:00:00Z 2015-02-29T00:00:00Z",
  "1900-02-29T00:00:00Z 0000-02-29T00:00:00Z 2000-02-29T00:00:00+05:30 2016-04-31T00:00:00Z",
  "2016-13-01T00:00Z 2016-04-30t00:00:00.123z 2016-00-10T00:00:00Z 2016-01-00T00:00:00Z",
  "2016-01-01T24:00:00Z 2016-01-01T23:60:00Z 2016-01-01T00:00:00-23:59 2016-01-01T00:00",
  "2016-01-01T00:00:00+24:00 2016-01-01T00:00:00+00:60 2016-01-01T00:00:00+0530 2016-01-01T00:00:00+05",
]
  .flatMap((line) => line.split(" "))
  .concat("2016-01-01 00:00:00Z");

function compile(schema: object | undefined) {
  if (schema === undefined) throw new Error("Missing tool schema");
  return new AjvJsonSchemaValidator().getValidator(schema);
}

function offline(schema: Readonly<Record<string, unknown>> | undefined) {
  const documents = SCHEMA_DOCUMENTS.map(
    ({ $schema: _dialect, ...doc }) => [String(doc.$id), doc] as const,
  );
  const local = schema?.$defs as object | undefined;
  return compile({
    ...schema,
    $defs: { ...local, ...Object.fromEntries(documents) },
  });
}

async function withWire(
  era: string,
  run: (
    tool: (name: string) => Tool,
    call: (name: string, args: object) => Promise<unknown>,
  ) => Promise<void> | void,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const opened = await createMcpTransport().open({
    handlers: createMcpHandlers(catalog, { expose: ["sample"] }),
    serverName: "contracts",
    serverVersion: "0.0.0",
    input: Readable.toWeb(input),
    output: Writable.toWeb(output),
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  const modern = era === "2026-07-28";
  const clientInfo = { name: "contracts", version: "0.0.0" };
  const init = { protocolVersion: era, capabilities: {}, clientInfo };
  const meta = {
    "io.modelcontextprotocol/protocolVersion": era,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": init.capabilities,
  };
  let id = 0;
  const rpc = async (method: string, params: object = {}) => {
    if (modern) params = { ...params, _meta: meta };
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`,
    );
    const reply = await replies.next();
    if (reply.done) throw new Error(`MCP closed before answering ${method}`);
    const message = JSON.parse(String(reply.value)) as {
      result: { tools: Tool[]; structuredContent: unknown };
    };
    expect(message).toMatchObject({ id });
    return message.result;
  };
  try {
    await rpc(modern ? "server/discover" : "initialize", modern ? {} : init);
    if (!modern)
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const { tools } = await rpc("tools/list");
    await run(
      (name) => tools.find((tool) => tool.name === name)!,
      async (name, args) =>
        (await rpc("tools/call", { name, arguments: args })).structuredContent,
    );
  } finally {
    lines.close();
    await opened.handle.close();
  }
}

test("admission refuses a nested type array and keeps a type list", () => {
  const schema = (type: unknown) => ({
    $id: "https://contracts.invalid/input",
    type: "object",
    properties: { text: { type } },
  });
  expect(() => new SchemaRegistry([schema([["string"]])])).toThrow(
    "type must name JSON types",
  );
  expect(() => new SchemaRegistry([schema(["string", "null"])])).not.toThrow();
  const list = compile(schema(["string", "null"]));
  expect(list({ text: null })).toMatchObject({ valid: true });
  expect(list({ text: 1 })).toMatchObject({ valid: false });
});

for (const era of ["2025-11-25", "2026-07-28"]) {
  test(`MCP ${era} date-time assertions match Forge`, async () => {
    await withWire(era, (tool) => {
      const wire = compile(tool("sample_dated").inputSchema);
      expect(wire(args({}))).toMatchObject({ valid: true });
      expect(validateWithSchema(dated, args({}))).toEqual([]);
      for (const at of ["2016-12-31T23:59:60Z", "2016-12-31t23:59:59Z"]) {
        expect(wire(args({ at })), at).toMatchObject({ valid: false });
        expect(validateWithSchema(dated, args({ at })), at).not.toEqual([]);
      }
      const verdicts = dates.map((seen) => [seen, wire(args({ seen })).valid]);
      expect(verdicts).toEqual(
        dates.map((seen) => [seen, isRfc3339DateTime(seen)]),
      );
      expect(new Set(verdicts.map(([, verdict]) => verdict)).size).toBe(2);
    });
  });

  test(`MCP ${era} keeps root input constraints on the wire`, async () => {
    await withWire(era, (tool) => {
      const text = tool("sample_text").inputSchema;
      expect(text.type).toBe("object");
      expect(compile(text)({})).toMatchObject({ valid: false });
      expect(validateWithSchema(scalar, {})).not.toEqual([]);
      const wire = compile(tool("sample_dated").inputSchema);
      expect(wire(args({ text: "abcde" }))).toMatchObject({ valid: false });
      expect(wire(args({ text: "abcdef" }))).toMatchObject({ valid: true });
    });
  });

  test(`MCP ${era} catalog replies match their result schemas`, async () => {
    await withWire(era, async (tool, call) => {
      const seen: { op: string; builtin?: boolean }[] = [];
      for (const [name, input] of [
        ["catalog_describe", { op: "sample.dated" }],
        ["catalog_describe", { op: "sample.text" }],
        ["catalog_list", {}],
      ] as const) {
        const envelope = (await call(name, input)) as { result: unknown };
        expect(envelope, name).toMatchObject({ ok: true, status: "OK" });
        const check = offline(tool(name).outputSchema);
        expect(check(envelope), name).toMatchObject({ valid: true });
        seen.push(...([envelope.result].flat() as typeof seen));
      }
      for (const [op, builtin] of [
        ["sample.dated", false],
        ["sample.text", true],
      ] as const) {
        const found = seen.filter((entry) => entry.op === op);
        expect(
          found.map((entry) => entry.builtin),
          op,
        ).toEqual([builtin, builtin]);
      }
    });
  });
}
