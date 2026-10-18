import { selectMcpTools, projectMcpTool } from "../contract/mcp.ts";
import { mcpToolName } from "../contract/naming.ts";
import type { McpExposure } from "../generated/types.ts";
import type { McpHandlers } from "../ports/mcp-transport.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { dispatch, type CallOptions } from "./dispatch.ts";
import { discoveryOperations } from "./discovery.ts";

/** The three discovery tools are in addition to the configured operation budget. */
export function createMcpHandlers(
  catalog: SurfaceCatalog,
  exposure: McpExposure = {},
  options: Omit<CallOptions, "caller"> = {},
): McpHandlers {
  if (
    exposure.budget !== undefined &&
    (!Number.isSafeInteger(exposure.budget) || exposure.budget < 0)
  )
    throw new RangeError("MCP budget must be a non-negative safe integer.");
  const selected = selectMcpTools(
    catalog.list().map((candidate) => ({
      ...candidate,
      ...(candidate.outputSchema === undefined
        ? {}
        : {
            outputSchema: {
              type: "object",
              oneOf: [
                {
                  properties: {
                    ok: { const: true },
                    status: { const: "OK" },
                    result: candidate.outputSchema,
                  },
                  required: ["ok", "op", "status", "result", "warnings"],
                },
                {
                  properties: {
                    ok: { const: false },
                    status: { enum: ["FAIL", "INCOMPLETE"] },
                  },
                  required: ["ok", "status", "error", "warnings"],
                },
              ],
            },
          }),
    })),
    exposure,
  );
  const byName = new Map(
    selected.tools.map((tool) => [
      tool.name,
      catalog.list().find((c) => {
        const name = mcpToolName(c.op, exposure.toolPrefix);
        return name === tool.name;
      }),
    ]),
  );
  const exposed = catalog
    .list()
    .filter((candidate) =>
      byName.has(mcpToolName(candidate.op, exposure.toolPrefix) ?? ""),
    );
  const restricted: SurfaceCatalog = {
    list: () => exposed,
    invoke: (request) => catalog.invoke(request),
  };
  return {
    listTools: () => [
      ...selected.tools,
      ...discoveryOperations.flatMap((c) => {
        const tool = projectMcpTool(c);
        return tool === undefined ? [] : [tool];
      }),
    ],
    callTool: async (name, args) => {
      if (discoveryOperations.some((entry) => name === mcpToolName(entry.op))) {
        return dispatch(restricted, name.replace("_", "."), args, {
          ...options,
          caller: "agent",
        });
      }
      const candidate = byName.get(name);
      return candidate === undefined
        ? undefined
        : dispatch(catalog, candidate.op, args, {
            ...options,
            caller: "agent",
          });
    },
  };
}
