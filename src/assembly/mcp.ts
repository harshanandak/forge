import { createMcpHandlers } from "../surface/mcp.ts";
import { dispatch } from "../surface/dispatch.ts";
import { mcpToolName } from "../contract/naming.ts";
import { isAgentCallable, selectMcpTools } from "../contract/mcp.ts";
import type { McpTransportPort } from "../ports/mcp-transport.ts";
import type { Assembly } from "./index.ts";
import { randomUUID } from "node:crypto";
import { localContext, localSession } from "./index.ts";
import { StateUnavailable } from "./state.ts";

/** Hidden, unadmitted names still reach the same runtime refusal through direct MCP calls. */
export function assemblyMcp(assembly: Assembly): McpTransportPort {
  return {
    async open(options) {
      try {
        await assembly.prepareTrust();
      } catch (error) {
        return {
          ok: false,
          unavailable:
            error instanceof StateUnavailable
              ? error.unavailable
              : {
                  kind: "unavailable",
                  reason:
                    error instanceof Error
                      ? error.message
                      : "Trust preparation failed",
                  remedy: "Check that the local trust store is readable.",
                },
        };
      }
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
      const { createMcpTransport } =
        await import("../adapters/mcp-transport/index.ts");
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
