import { Readable, Writable } from "node:stream";
import {
  Server,
  ProtocolError,
  specTypeSchemas,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { mcpObjectInput } from "../../contract/mcp.ts";
import type { McpTransportPort } from "../../ports/mcp-transport.ts";
import type { FailureEnvelope } from "../../generated/types.ts";

const MCP_TOOL_CONCURRENCY_LIMIT = 8;
const MCP_BUSY: FailureEnvelope = {
  ok: false,
  status: "FAIL",
  error: {
    code: "MCP_BUSY",
    message: `Forge is running ${MCP_TOOL_CONCURRENCY_LIMIT} MCP tool calls. Wait for a call to finish, then retry.`,
    retry: "safe",
  },
  warnings: [],
};

/** SDK owns framing, negotiation, era-specific wire codecs and connection cleanup. */
export function createMcpTransport(): McpTransportPort {
  return {
    open: (options) => {
      try {
        let activeToolCalls = 0;
        const callTool = async (
          name: string,
          args: unknown,
          signal: AbortSignal,
        ) => {
          signal.throwIfAborted();
          if (name === "catalog_list" || name === "catalog_describe")
            return options.handlers.callTool(name, args, signal);
          if (activeToolCalls >= MCP_TOOL_CONCURRENCY_LIMIT) return MCP_BUSY;
          activeToolCalls++;
          try {
            return await options.handlers.callTool(name, args, signal);
          } finally {
            activeToolCalls--;
          }
        };
        const input = Readable.fromWeb(options.input);
        const output = Writable.fromWeb(options.output);
        const transport = new StdioServerTransport(input, output);
        output.once("error", () => {
          input.destroy();
          options.onOutputError?.();
        });
        const handle = serveStdio(
          () => {
            const server = new Server(
              { name: options.serverName, version: options.serverVersion },
              { capabilities: { tools: {} } },
            );
            server.setRequestHandler(
              "tools/list",
              { params: specTypeSchemas.PaginatedRequestParams },
              ({ cursor }) => {
                if (cursor !== undefined && cursor !== "")
                  throw new ProtocolError(-32602, "Unknown cursor.");
                return {
                  tools: options.handlers.listTools().map((tool) => ({
                    ...tool,
                    inputSchema: mcpObjectInput(tool.inputSchema),
                  })),
                };
              },
            );
            server.setRequestHandler("tools/call", async (request, ctx) => {
              const result = await callTool(
                request.params.name,
                request.params.arguments ?? {},
                ctx.mcpReq.signal,
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
            value: {},
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
