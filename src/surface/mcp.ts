import {
  selectMcpTools,
  projectMcpTool,
  type McpCandidate,
} from "../contract/mcp.ts";
import { mcpToolName } from "../contract/naming.ts";
import { bundleSchema } from "../contract/schema-bundle.ts";
import {
  DIRECT_SUBSCHEMAS,
  SchemaRegistry,
  type SchemaObject,
} from "../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../generated/schemas.ts";
import type { McpExposure } from "../generated/types.ts";
import type { McpHandlers } from "../ports/mcp-transport.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { dispatch, type CallOptions } from "./dispatch.ts";
import { discoveryOperations } from "./discovery.ts";

const STANDALONE_ID = "https://mcp.invalid/schema.json";
const COMPOSITIONS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf"]);
const MAPS: ReadonlySet<string> = new Set(["properties", "$defs"]);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsafeExtension(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(unsafeExtension);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "$anchor" || key === "$id" || unsafeExtension(child),
  );
}

function checkExtensions(schema: unknown): void {
  if (!isObject(schema)) return;
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-") && unsafeExtension(value)) {
      throw new Error(
        "MCP schema publication refuses $anchor or $id inside x-* extension values",
      );
    }
    if (MAPS.has(key) && isObject(value))
      Object.values(value).forEach(checkExtensions);
    else if (COMPOSITIONS.has(key) && Array.isArray(value))
      value.forEach(checkExtensions);
    else if (DIRECT_SUBSCHEMAS.has(key)) checkExtensions(value);
  }
}

function bundle(
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

function project(
  candidate: McpCandidate,
  side: "input" | "output",
): SchemaObject {
  try {
    const schema = bundle(candidate, side);
    checkExtensions(schema);
    return schema;
  } catch (error) {
    const name = mcpToolName(candidate.op) ?? candidate.op;
    throw new Error(
      `MCP tool ${name} cannot publish its ${side} schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function published(candidate: McpCandidate): McpCandidate {
  return {
    ...candidate,
    inputSchema: project(candidate, "input"),
    ...(candidate.outputSchema === undefined
      ? {}
      : { outputSchema: project(candidate, "output") }),
  };
}

/** MCP output schemas describe the shared result envelope, including failures. */
function enveloped(candidate: McpCandidate): McpCandidate {
  // The generic dispatcher already returns the target's canonical envelope.
  if (candidate.op === "catalog.call")
    return {
      ...candidate,
      outputSchema: { type: "object", ...candidate.outputSchema },
    };
  if (candidate.outputSchema === undefined) return candidate;
  const { $schema, $defs, ...result } = candidate.outputSchema;
  const local = {
    ...($schema === undefined ? {} : { $schema }),
    ...($defs === undefined ? {} : { $defs }),
  };
  return {
    ...candidate,
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

function publishable(candidate: McpCandidate): McpCandidate {
  return enveloped(published(candidate));
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
  const catalogCandidates = catalog.list();
  const selected = selectMcpTools(catalogCandidates, exposure);
  const byName = new Map(
    selected.tools.map((tool) => [
      tool.name,
      catalogCandidates.find((c) => {
        const name = mcpToolName(c.op, exposure.toolPrefix);
        return name === tool.name;
      }),
    ]),
  );
  // Discovery ignores the direct-tool budget. Keep unadmitted names callable so
  // the runtime can return ADMISSION_REQUIRED; visible() still hides their metadata.
  const reachable = new Set(
    selectMcpTools(
      catalogCandidates.map((candidate) => ({ ...candidate, admitted: true })),
      { ...exposure, budget: 0 },
    ).overflow,
  );
  const exposed = catalogCandidates.filter((candidate) =>
    reachable.has(candidate.op),
  );
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
  const listed = (candidate: McpCandidate, prefix?: string) => {
    const tool = projectMcpTool(publishable(candidate), prefix);
    return tool === undefined ? [] : [tool];
  };
  return {
    listTools: () => [
      ...selected.tools.flatMap((tool) => {
        const candidate = byName.get(tool.name);
        return candidate === undefined
          ? []
          : listed(candidate, exposure.toolPrefix);
      }),
      ...discoveryOperations.flatMap((c) =>
        exposure.readOnly && c.declaration.effects.length > 0 ? [] : listed(c),
      ),
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
