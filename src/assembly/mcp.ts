import { createMcpHandlers } from "../surface/mcp.ts";
import { dispatch } from "../surface/dispatch.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { mcpToolName } from "../contract/naming.ts";
import { isAgentCallable, selectMcpTools } from "../contract/mcp.ts";
import type { McpTransportPort } from "../ports/mcp-transport.ts";
import type { Assembly } from "./index.ts";
import { randomUUID } from "node:crypto";
import { localContext, localSession } from "./index.ts";
import { StateUnavailable } from "./state.ts";
import { localIdentityResolver } from "./identity.ts";

/** Hidden, unadmitted names still reach the same runtime refusal through direct MCP calls. */
export function assemblyMcp(assembly: Assembly): McpTransportPort {
  return {
    async open(options) {
      try {
        void assembly.exposure;
      } catch (error) {
        if (!(error instanceof ForgeFailure)) throw error;
        return {
          ok: false,
          unavailable: {
            kind: "unavailable",
            reason: error.message,
            remedy: error.error.repair ?? "Check the project config.",
          },
        };
      }
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
      const resolveContext = localIdentityResolver(
        assembly.deviceRoot,
        { ...process.env },
        process.stdin.isTTY === true,
      );
      const request = () => {
        const candidates = assembly.mcpCatalog.list();
        const exposure = assembly.exposure;
        const catalog = { ...assembly.mcpCatalog, list: () => candidates };
        const handlers = createMcpHandlers(catalog, exposure, {
          context,
          resolveContext,
        });
        return { candidates, catalog, exposure, handlers };
      };
      const { createMcpTransport } =
        await import("../adapters/mcp-transport/index.ts");
      return createMcpTransport().open({
        ...options,
        handlers: {
          listTools: () => request().handlers.listTools(),
          async callTool(name, args, signal) {
            const { candidates, catalog, exposure, handlers } = request();
            const result = await handlers.callTool(name, args, signal);
            if (result !== undefined) return result;
            const reachable = new Set(
              selectMcpTools(
                candidates.map((entry) => ({ ...entry, admitted: true })),
                { ...exposure, budget: 0 },
              ).overflow,
            );
            const candidate = candidates.find(
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
              : dispatch(catalog, candidate.op, args, {
                  caller: "agent",
                  context,
                  resolveContext,
                  ...(signal === undefined ? {} : { signal }),
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
