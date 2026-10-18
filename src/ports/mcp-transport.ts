// The MCP protocol transport. It frames and negotiates; every tool and result comes from the catalog
// through these handlers, so the transport holds no domain logic.
import type { McpTool, ResultEnvelope } from "../generated/types.ts";
import type { LifetimeProvider } from "./lifetime.ts";

export interface McpHandlers {
  listTools(): readonly McpTool[];
  /** undefined for an unknown tool, which the transport reports as a protocol error. */
  callTool(name: string, args: unknown): Promise<ResultEnvelope | undefined>;
}

export interface McpServeOptions {
  readonly handlers: McpHandlers;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
}

export interface McpServer {
  /** Tell subscribed clients the tool list changed. */
  notifyToolsChanged(): Promise<void>;
}

export type McpTransportPort = LifetimeProvider<McpServer, McpServeOptions>;
