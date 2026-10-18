import type { McpCandidate } from "../contract/mcp.ts";

/** Surface discovery operations have one declaration shared by help, argv and MCP. */
export const discoveryOperations: readonly McpCandidate[] = (
  ["list", "describe", "call"] as const
).map((verb) => ({
  op: `catalog.${verb}`,
  admitted: true,
  declaration: {
    input: "catalog-input.json",
    output: "catalog-output.json",
    context: "stateless",
    effects: verb === "call" ? ["external:network", "state:write"] : [],
    destructive: verb === "call",
    idempotent: verb !== "call",
    callers: ["human", "agent"],
    stability: "stable",
    args: verb === "list" ? [] : ["op"],
  },
  docs: {
    title: `Catalog ${verb}`,
    summary: `Catalog ${verb}; operations are resolved from the current catalog.`,
  },
  inputSchema: {
    type: "object",
    properties:
      verb === "list"
        ? {}
        : { op: { type: "string" }, ...(verb === "call" ? { input: {} } : {}) },
    required: verb === "list" ? [] : ["op"],
    additionalProperties: false,
  },
}));
