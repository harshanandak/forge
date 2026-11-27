import {
  selectMcpTools,
  projectMcpTool,
  type McpCandidate,
} from "../contract/mcp.ts";
import { mcpToolName } from "../contract/naming.ts";
import { bundleSchema } from "../contract/schema-bundle.ts";
import { SchemaRegistry, type JsonSchema } from "../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../generated/schemas.ts";
import type { McpExposure, McpTool } from "../generated/types.ts";
import type { McpHandlers } from "../ports/mcp-transport.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { dispatch, type CallOptions } from "./dispatch.ts";
import { discoveryOperations } from "./discovery.ts";

/** MCP output schemas describe the shared result envelope, including failures. */
function enveloped(tool: McpTool, candidate: McpCandidate): McpTool {
  const project = (side: "input" | "output", schema: JsonSchema) => {
    if (candidate.projectSchema !== undefined)
      return candidate.projectSchema(side);
    const document = typeof schema === "boolean" ? { allOf: [schema] } : schema;
    const id =
      typeof document.$id === "string"
        ? document.$id
        : "https://mcp.invalid/schema";
    return bundleSchema(
      new SchemaRegistry([...SCHEMA_DOCUMENTS, { ...document, $id: id }]),
      id,
    );
  };
  const inputSchema = project("input", tool.inputSchema);
  if (tool.outputSchema === undefined) return { ...tool, inputSchema };
  const output = project("output", tool.outputSchema);
  // The generic dispatcher already returns the target's canonical envelope.
  if (candidate.op === "catalog.call")
    return {
      ...tool,
      inputSchema,
      outputSchema: { type: "object", ...output },
    };
  const { $defs, $schema, ...result } = output;
  return {
    ...tool,
    inputSchema,
    outputSchema: {
      type: "object",
      $schema,
      ...($defs === undefined ? {} : { $defs }),
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
