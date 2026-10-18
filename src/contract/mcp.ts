// MCP projection rules. One tool per exposed operation, named noun_verb; annotations come from
// declared effects; human-only operations never appear; the list is sorted and fixed per catalog.
import type {
  McpExposure,
  McpTool,
  McpToolAnnotations,
  OperationDeclaration,
  OperationDocs,
} from "../generated/types.ts";
import type { SchemaObject } from "./schema.ts";
import { mcpToolName, parseOperationName } from "./naming.ts";

export const DEFAULT_MCP_BUDGET = 40;

export interface McpCandidate {
  readonly op: string;
  readonly declaration: OperationDeclaration;
  /** Only admitted operations are listed; others stay reachable as ADMISSION_REQUIRED refusals. */
  readonly admitted: boolean;
  readonly docs: OperationDocs;
  readonly inputSchema: SchemaObject;
  readonly outputSchema?: SchemaObject;
}

export interface McpSelection {
  readonly tools: readonly McpTool[];
  /** Exposable operations beyond the budget, reachable through catalog_call. */
  readonly overflow: readonly string[];
}

export function mcpAnnotations(
  declaration: OperationDeclaration,
): McpToolAnnotations {
  const readOnly = declaration.effects.length === 0;
  const openWorld = declaration.effects.some((e) => e.startsWith("external:"));
  return readOnly
    ? {
        readOnlyHint: true,
        idempotentHint: declaration.idempotent,
        openWorldHint: openWorld,
      }
    : {
        readOnlyHint: false,
        destructiveHint: declaration.destructive ?? true,
        idempotentHint: declaration.idempotent,
        openWorldHint: openWorld,
      };
}

/** Agents never mint trust: an operation without the agent caller is never an MCP tool. */
export function isAgentCallable(declaration: OperationDeclaration): boolean {
  return declaration.callers.includes("agent");
}

export function projectMcpTool(
  candidate: McpCandidate,
  prefix?: string,
): McpTool | undefined {
  const name = mcpToolName(candidate.op, prefix);
  if (name === undefined || !isAgentCallable(candidate.declaration))
    return undefined;
  const { docs, declaration } = candidate;
  const replacement = declaration.deprecated?.use;
  const notice =
    replacement === undefined
      ? ""
      : `Deprecated: use ${mcpToolName(replacement, prefix) ?? replacement}. `;
  const description = [docs.summary, docs.description]
    .filter(Boolean)
    .join(" ");
  return {
    name,
    title: docs.title,
    description: `${notice}${description}`,
    inputSchema: candidate.inputSchema,
    ...(candidate.outputSchema === undefined
      ? {}
      : { outputSchema: candidate.outputSchema }),
    annotations: mcpAnnotations(declaration),
  };
}

function explicitlySelected(op: string, expose: readonly string[]): boolean {
  const noun = parseOperationName(op)?.noun;
  return expose.includes(op) || (noun !== undefined && expose.includes(noun));
}

/**
 * Select the tools to list. By default: stable, admitted, agent-callable operations. With
 * `expose`: the named nouns and operations of any stability. `readOnly` drops anything with effects.
 * The budget caps the list; the rest stays reachable through catalog_call.
 */
export function selectMcpTools(
  candidates: readonly McpCandidate[],
  exposure: McpExposure = {},
): McpSelection {
  const budget = exposure.budget ?? DEFAULT_MCP_BUDGET;
  const exposable = candidates
    .filter((c) => c.admitted && isAgentCallable(c.declaration))
    .filter(
      (c) => exposure.readOnly !== true || c.declaration.effects.length === 0,
    )
    .filter((c) =>
      exposure.expose === undefined
        ? c.declaration.stability === "stable"
        : explicitlySelected(c.op, exposure.expose),
    )
    .sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));
  const tools: McpTool[] = [];
  const overflow: string[] = [];
  for (const candidate of exposable) {
    const tool =
      tools.length < budget
        ? projectMcpTool(candidate, exposure.toolPrefix)
        : undefined;
    if (tool === undefined) overflow.push(candidate.op);
    else tools.push(tool);
  }
  return { tools, overflow };
}
