import { createMcpHandlers } from "../surface/mcp.ts";
import { dispatch } from "../surface/dispatch.ts";
import { createMcpTransport } from "../adapters/mcp-transport/index.ts";
import { mcpToolName } from "../contract/naming.ts";
import { isAgentCallable, selectMcpTools } from "../contract/mcp.ts";
import type { McpTransportPort } from "../ports/mcp-transport.ts";
import type { Assembly } from "./index.ts";
import { randomUUID } from "node:crypto";
import { localContext, localSession } from "./index.ts";

/** Hidden, unadmitted names still reach the same runtime refusal through direct MCP calls. */
export function assemblyMcp(assembly: Assembly): McpTransportPort {
  return {
    async open(options) {
      await assembly.prepareTrust();
      const context = localContext(
        assembly,
        { kind: "agent", id: "mcp" },
        localSession(`mcp-${randomUUID()}`),
      );
      const exposure = assembly.exposure;
      const handlers = () =>
        createMcpHandlers(assembly.catalog, exposure, {
          context,
        });
      return createMcpTransport().open({
        ...options,
        handlers: {
          listTools: () => handlers().listTools(),
          async callTool(name, args) {
            const result = await handlers().callTool(name, args);
            if (result !== undefined) return result;
            const reachable = new Set(
              selectMcpTools(
                assembly.catalog
                  .list()
                  .map((entry) => ({ ...entry, admitted: true })),
                { ...exposure, budget: 0 },
              ).overflow,
            );
            const candidate = assembly.catalog
              .list()
              .find(
                (entry) =>
                  !entry.admitted &&
                  reachable.has(entry.op) &&
                  (!exposure.readOnly ||
                    entry.declaration.effects.length === 0) &&
                  isAgentCallable(entry.declaration) &&
                  mcpToolName(entry.op, exposure.toolPrefix) === name,
              );
            return candidate === undefined
              ? undefined
              : dispatch(assembly.catalog, candidate.op, args, {
                  caller: "agent",
                  context,
                  ...(exposure.readOnly === undefined
                    ? {}
                    : { readOnly: exposure.readOnly }),
                });
          },
        },
      });
    },
  };
}
