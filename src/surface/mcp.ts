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
import { failure } from "./result.ts";

/** MCP output schemas describe the shared result envelope, including failures. */
function enveloped(candidate: McpCandidate): McpCandidate {
  // The generic dispatcher already returns the target's canonical envelope.
  if (candidate.op === "catalog.call")
    return {
      ...candidate,
      outputSchema: { type: "object", ...candidate.outputSchema },
    };
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
                  result: candidate.outputSchema,
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
  const candidates = catalog.list();
  const selected = selectMcpTools(candidates.map(enveloped), exposure);
  const byName = new Map(
    selected.tools.map((tool) => [
      tool.name,
      candidates.find((c) => {
        const name = mcpToolName(c.op, exposure.toolPrefix);
        return name === tool.name;
      }),
    ]),
  );
  // Discovery ignores the direct-tool budget. Keep unadmitted names callable so
  // the runtime can return ADMISSION_REQUIRED; visible() still hides their metadata.
  const reachable = new Set(
    selectMcpTools(
      candidates.map((candidate) => ({ ...candidate, admitted: true })),
      { ...exposure, budget: 0 },
    ).overflow,
  );
  const exposed = candidates.filter((candidate) => reachable.has(candidate.op));
  const restricted: SurfaceCatalog = {
    list: () => exposed,
    invoke: (request) => catalog.invoke(request),
  };
  return {
    listTools: () => [
      ...selected.tools,
      ...discoveryOperations.flatMap((c) => {
        if (exposure.readOnly && c.declaration.effects.length > 0) return [];
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
          ...(exposure.readOnly === undefined
            ? {}
            : { readOnly: exposure.readOnly }),
        });
      }
      const candidate = byName.get(name);
      if (
        candidate === undefined &&
        exposure.readOnly &&
        catalog
          .list()
          .some(
            (entry) =>
              entry.declaration.effects.length > 0 &&
              mcpToolName(entry.op, exposure.toolPrefix) === name,
          )
      )
        return failure("UNKNOWN_COMMAND", `Unknown tool: ${name}`);
      return candidate === undefined
        ? undefined
        : dispatch(catalog, candidate.op, args, {
            ...options,
            caller: "agent",
            ...(exposure.readOnly === undefined
              ? {}
              : { readOnly: exposure.readOnly }),
          });
    },
  };
}
