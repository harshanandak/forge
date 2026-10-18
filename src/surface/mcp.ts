import {
  selectMcpTools,
  projectMcpTool,
  type McpCandidate,
} from "../contract/mcp.ts";
import { mcpToolName } from "../contract/naming.ts";
import type { McpExposure } from "../generated/types.ts";
import type { McpHandlers } from "../ports/mcp-transport.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { dispatch, type CallOptions } from "./dispatch.ts";
import { discoveryOperations } from "./discovery.ts";

/** MCP output schemas describe the shared result envelope, including failures. */
function enveloped(candidate: McpCandidate): McpCandidate {
  return {
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
  };
}

/** Core discovery tools are generated alongside the configured operation budget. */
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
  const selected = selectMcpTools(catalog.list().map(enveloped), exposure);
  const byName = new Map(
    selected.tools.map((tool) => [
      tool.name,
      catalog.list().find((c) => {
        const name = mcpToolName(c.op, exposure.toolPrefix);
        return name === tool.name;
      }),
    ]),
  );
  // Discovery ignores the direct-tool budget. Keep unadmitted names callable so
  // the runtime can return ADMISSION_REQUIRED; visible() still hides their metadata.
  const reachable = new Set(
    selectMcpTools(
      catalog.list().map((candidate) => ({ ...candidate, admitted: true })),
      { ...exposure, budget: 0 },
    ).overflow,
  );
  const exposed = catalog
    .list()
    .filter((candidate) => reachable.has(candidate.op));
  const restricted: SurfaceCatalog = {
    list: () => exposed,
    invoke: (request) => catalog.invoke(request),
  };
  return {
    listTools: () => [
      ...selected.tools,
      ...discoveryOperations.flatMap((c) => {
        const tool = projectMcpTool(enveloped(c));
        return tool === undefined ? [] : [tool];
      }),
    ],
    callTool: async (name, args) => {
      const core = discoveryOperations.find(
        (entry) =>
          entry.declaration.callers.includes("agent") &&
          name === mcpToolName(entry.op),
      );
      if (core !== undefined) {
        return dispatch(restricted, core.op, args, {
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
