import { Readable, Writable } from "node:stream";
import {
  Server,
  ProtocolError,
  ResourceNotFoundError,
  specTypeSchemas,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { mcpObjectInput } from "../../contract/mcp.ts";
import { SkillCatalogLimit } from "../../contract/skill-resource.ts";
import type { McpTransportPort } from "../../ports/mcp-transport.ts";
import type { SkillResourceProvider } from "../../ports/skill-resources.ts";
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

const PRIVATE_RESOURCE = {
  resultType: "complete",
  ttlMs: 0,
  cacheScope: "private",
} as const;
const SKILL_CAPABILITIES = {
  resources: {},
  extensions: { "io.modelcontextprotocol/skills": {} },
};

function resourceMimeType(path: string): string {
  return /\.md$/i.test(path) ? "text/markdown" : "application/octet-stream";
}

function resourceText(bytes: Uint8Array): string | undefined {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

async function loadSkillCatalog<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof SkillCatalogLimit) {
      const { message, expected } = error.error;
      throw new ProtocolError(-32603, message, expected);
    }
    throw new ProtocolError(-32603, "Skill resource catalog unavailable.");
  }
}

function registerResources(
  server: Server,
  skills: SkillResourceProvider,
): void {
  const catalog = () => loadSkillCatalog(() => skills.catalog());
  server.setRequestHandler(
    "resources/list",
    { params: specTypeSchemas.PaginatedRequestParams },
    async ({ cursor }) => {
      if (cursor !== undefined && cursor !== "")
        throw new ProtocolError(-32602, "Unknown cursor.");
      const resources = [...(await catalog())].map(([uri, file]) => ({
        uri,
        name: file.path.split("/").at(-1)!,
        mimeType: resourceMimeType(file.path),
        size: file.bytes.byteLength,
      }));
      return { ...PRIVATE_RESOURCE, resources };
    },
  );
  server.setRequestHandler(
    "resources/read",
    { params: specTypeSchemas.ReadResourceRequestParams },
    async ({ uri }) => {
      const file = uri.startsWith("skill://")
        ? (await catalog()).get(uri)
        : undefined;
      if (file === undefined) throw new ResourceNotFoundError(uri);
      const mimeType = resourceMimeType(file.path);
      const text =
        mimeType === "text/markdown" ? resourceText(file.bytes) : undefined;
      const content =
        text === undefined
          ? { blob: Buffer.from(file.bytes).toString("base64") }
          : { text };
      const contents = [{ uri, mimeType, ...content }];
      return { ...PRIVATE_RESOURCE, contents };
    },
  );
}

function registerSkills(server: Server, provider: SkillResourceProvider): void {
  const manifests = () => loadSkillCatalog(() => provider.manifests());
  server.setRequestHandler(
    "skills/list",
    { params: specTypeSchemas.PaginatedRequestParams },
    async ({ cursor }) => {
      if (cursor !== undefined && cursor !== "")
        throw new ProtocolError(-32602, "Unknown cursor.");
      return { ...PRIVATE_RESOURCE, skills: [...(await manifests()).values()] };
    },
  );
  server.setRequestHandler(
    "skills/get",
    { params: specTypeSchemas.ReadResourceRequestParams },
    async ({ uri }) => {
      const skill = uri.startsWith("skill://")
        ? (await manifests()).get(uri)
        : undefined;
      if (skill === undefined) throw new ResourceNotFoundError(uri);
      return { ...PRIVATE_RESOURCE, skill };
    },
  );
}

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
              {
                capabilities: {
                  tools: {},
                  ...(options.skills === undefined ? {} : SKILL_CAPABILITIES),
                },
              },
            );
            if (options.skills !== undefined) {
              registerResources(server, options.skills);
              registerSkills(server, options.skills);
            }
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
