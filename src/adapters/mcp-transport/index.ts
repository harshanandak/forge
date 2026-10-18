import { Readable, Writable } from "node:stream";
import { Server, ProtocolError } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import type { McpTransportPort } from "../../ports/mcp-transport.ts";

/** SDK owns framing, negotiation, era-specific wire codecs and connection cleanup. */
export function createMcpTransport(): McpTransportPort {
  return {
    open: (options) => {
      try {
        let instance: Server | undefined;
        const transport = new StdioServerTransport(
          Readable.fromWeb(options.input),
          Writable.fromWeb(options.output),
        );
        const handle = serveStdio(
          () => {
            const server = new Server(
              { name: options.serverName, version: options.serverVersion },
              { capabilities: { tools: { listChanged: true } } },
            );
            instance = server;
            server.setRequestHandler("tools/list", () => ({
              tools: options.handlers.listTools().map((tool) => ({
                ...tool,
                inputSchema: { ...tool.inputSchema, type: "object" as const },
              })),
            }));
            server.setRequestHandler("tools/call", async (request) => {
              const result = await options.handlers.callTool(
                request.params.name,
                request.params.arguments ?? {},
              );
              if (result === undefined)
                throw new ProtocolError(-32602, "Unknown tool.");
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                structuredContent: { ...result },
                isError: !result.ok,
              };
            });
            return server;
          },
          { transport },
        );
        let closed = false;
        return Promise.resolve({
          ok: true,
          handle: {
            ownership: "owned",
            value: {
              notifyToolsChanged: async () => {
                await instance?.sendToolListChanged();
              },
            },
            close: async () => {
              if (!closed) {
                closed = true;
                await handle.close();
              }
            },
          },
        });
      } catch {
        return Promise.resolve({
          ok: false,
          unavailable: {
            kind: "unavailable",
            reason: "MCP stdio transport could not open.",
            remedy: "Check that the input and output streams are available.",
          },
        });
      }
    },
  };
}
