import { expect, setDefaultTimeout, test } from "bun:test";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";
import { runCommand } from "../../src/surface/command.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

setDefaultTimeout(30_000);
const catalog = fakeCatalog([
  candidate("sample.read"),
  candidate("sample.write", { effects: ["external:network"] }),
]);
const clientInfo = { name: "safe", version: "0.0.0" };
const transport = createMcpTransport();
const failure = (code: string) => ({ ok: false, error: { code } });

async function checkProtocol(era: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const handlers = createMcpHandlers(catalog, { readOnly: true });
  const opened = await transport.open({
    handlers,
    serverName: clientInfo.name,
    serverVersion: clientInfo.version,
    input: Readable.toWeb(input),
    output: Writable.toWeb(output),
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  const modern = era === "2026-07-28";
  const capabilities = {};
  const init = { protocolVersion: era, capabilities, clientInfo };
  const meta = {
    "io.modelcontextprotocol/protocolVersion": era,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": capabilities,
  };
  let id = 0;
  const rpc = async (method: string, params = {}) => {
    if (modern) params = { ...params, _meta: meta };
    const request = { jsonrpc: "2.0", id: ++id, method, params };
    input.write(JSON.stringify(request) + "\n");
    const reply = await replies.next();
    if (reply.done) throw new Error(`MCP closed before answering ${method}`);
    const message = JSON.parse(String(reply.value)) as Record<string, unknown>;
    expect(message.id).toBe(id);
    return message;
  };
  try {
    await rpc(modern ? "server/discover" : "initialize", modern ? {} : init);
    if (!modern)
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    for (const name of ["sample_write", "block_add", "never_existed"]) {
      const args = { path: "./hello" };
      const reply = await rpc("tools/call", { name, arguments: args });
      expect(reply).toMatchObject({ error: { code: -32602 } });
      expect(reply.result).toBeUndefined();
    }
    const names = handlers.listTools().map((tool) => tool.name);
    for (const params of [{}, { cursor: "" }]) {
      const reply = await rpc("tools/list", params);
      const result = reply.result as { tools: { name: string }[] };
      expect(result.tools.map((tool) => tool.name)).toEqual(names);
    }
    const unissued = await rpc("tools/list", { cursor: "unissued-cursor" });
    expect(unissued).toMatchObject({ error: { code: -32602 } });
    const name = "catalog_describe";
    for (const op of [undefined, "sample.write"]) {
      const args = op === undefined ? {} : { op };
      const reply = await rpc("tools/call", { name, arguments: args });
      const code = op === undefined ? "INPUT_INVALID" : "UNKNOWN_COMMAND";
      expect(reply.result).toMatchObject({
        isError: true,
        structuredContent: failure(code),
      });
    }
  } finally {
    lines.close();
    await opened.handle.close();
  }
}

for (const era of ["2025-11-25", "2026-07-28"])
  test(`MCP ${era} tool calls and cursors`, () => checkProtocol(era));

test("MCP transport open failure reports on stderr", async () => {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const badInput = null as unknown as ReadableStream<Uint8Array>;
  const exit = await runCommand(["--mcp"], {
    catalog,
    version: clientInfo.version,
    input: new PassThrough(),
    output,
    errorOutput,
    mcp: { open: (opts) => transport.open({ ...opts, input: badInput }) },
  });
  expect([exit, output.read()]).toEqual([1, null]);
  const diagnostic: unknown = JSON.parse(String(errorOutput.read()));
  expect(diagnostic).toMatchObject(failure("UNAVAILABLE"));
});
