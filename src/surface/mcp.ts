import {
  selectMcpTools,
  projectMcpTool,
  type McpCandidate,
} from "../contract/mcp.ts";
import { mcpToolName } from "../contract/naming.ts";
import { bundleSchema } from "../contract/schema-bundle.ts";
import { SchemaRegistry, type SchemaObject } from "../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../generated/schemas.ts";
import type { McpExposure, McpTool } from "../generated/types.ts";
import type { McpHandlers } from "../ports/mcp-transport.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { dispatch, type CallOptions } from "./dispatch.ts";
import { discoveryOperations } from "./discovery.ts";

const STANDALONE_ID = "https://mcp.invalid/schema.json";

function projected(
  candidate: McpCandidate,
  side: "input" | "output",
): SchemaObject {
  if (candidate.projectSchema !== undefined)
    return candidate.projectSchema(side);
  const schema =
    side === "input" ? candidate.inputSchema : candidate.outputSchema!;
  const id = typeof schema.$id === "string" ? schema.$id : STANDALONE_ID;
  return bundleSchema(
    new SchemaRegistry([...SCHEMA_DOCUMENTS, { ...schema, $id: id }]),
    id,
  );
}

function publishable(
  tool: McpTool,
  candidate: McpCandidate,
  side: "input" | "output",
): SchemaObject {
  try {
    return projected(candidate, side);
  } catch (error) {
    throw new Error(
      `MCP tool ${tool.name} cannot publish its ${side} schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** MCP output schemas describe the shared result envelope, including failures. */
function enveloped(tool: McpTool, candidate: McpCandidate): McpTool {
  const inputSchema = publishable(tool, candidate, "input");
  if (candidate.outputSchema === undefined) return { ...tool, inputSchema };
  const { $schema, $defs, ...result } = publishable(tool, candidate, "output");
  const local = { $schema, ...($defs === undefined ? {} : { $defs }) };
  // The generic dispatcher already returns the target's canonical envelope.
  if (candidate.op === "catalog.call")
    return {
      ...tool,
      inputSchema,
      outputSchema: { type: "object", ...local, ...result },
    };
  return {
    ...tool,
    inputSchema,
    outputSchema: {
      type: "object",
      ...local,
      oneOf: [
        {
          properties: {
            ok: { const: true },
            status: { const: "OK" },
            result,
          },
          required: ["ok", "op", "status", "result", "warnings"],
        },
        {
          properties: {
            ok: { const: false },
            status: { enum: ["FAIL", "INCOMPLETE"] },
            result,
          },
          required: ["ok", "status", "error", "warnings"],
        },
      ],
    },
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
  const selected = selectMcpTools(candidates, exposure);
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
    invoke: (request, signal) => catalog.invoke(request, signal),
    ...(catalog.admit === undefined
      ? {}
      : {
          admit: (blockId, op, dryRun, input) =>
            catalog.admit!(blockId, op, dryRun, input),
        }),
  };
  return {
    listTools: () => [
      ...selected.tools.map((tool) => enveloped(tool, byName.get(tool.name)!)),
      ...discoveryOperations.flatMap((c) => {
        if (exposure.readOnly && c.declaration.effects.length > 0) return [];
        const tool = projectMcpTool(c);
        return tool === undefined ? [] : [enveloped(tool, c)];
      }),
    ],
    callTool: async (name, args, signal) => {
      const call = signal === undefined ? options : { ...options, signal };
      const core = discoveryOperations.find(
        (entry) =>
          entry.declaration.callers.includes("agent") &&
          name === mcpToolName(entry.op),
      );
      if (core !== undefined) {
        if (exposure.readOnly && core.declaration.effects.length > 0)
          return undefined;
        return dispatch(restricted, core.op, args, {
          ...call,
          caller: "agent",
          ...(exposure.readOnly === undefined
            ? {}
            : { readOnly: exposure.readOnly }),
        });
      }
      const candidate = byName.get(name);
      return candidate === undefined
        ? undefined
        : dispatch(catalog, candidate.op, args, {
            ...call,
            caller: "agent",
            ...(exposure.readOnly === undefined
              ? {}
              : { readOnly: exposure.readOnly }),
          });
    },
  };
}
