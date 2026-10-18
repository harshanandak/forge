import { readdirSync, readFileSync } from "node:fs";
import {
  SchemaRegistry,
  type SchemaObject,
  type JsonSchema,
} from "../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../generated/schemas.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import type { OperationDeclaration } from "../generated/types.ts";

const BASE =
  "https://raw.githubusercontent.com/harshanandak/forge/main/src/core/config/";
const fragment = JSON.parse(
  readFileSync(
    new URL("../core/config/operations.json", import.meta.url),
    "utf8",
  ),
) as { operations: Record<string, OperationDeclaration> };
const schemas = readdirSync(new URL("../core/config/schemas/", import.meta.url))
  .filter((name) => name.endsWith(".json"))
  .map(
    (name) =>
      JSON.parse(
        readFileSync(
          new URL(`../core/config/schemas/${name}`, import.meta.url),
          "utf8",
        ),
      ) as SchemaObject,
  );
export const configRegistry: SchemaRegistry = new SchemaRegistry([
  ...SCHEMA_DOCUMENTS,
  ...schemas,
]);

/** Catalog schemas are self-contained for every generated transport. */
function inline(
  value: unknown,
  base: string,
  ancestors: readonly string[] = [],
): unknown {
  if (Array.isArray(value))
    return value.map((child) => inline(child, base, ancestors));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  const reference =
    typeof object.$ref === "string"
      ? configRegistry.resolve(object.$ref, base)
      : undefined;
  if (reference && ancestors.includes(reference))
    throw new Error("Recursive config schema cannot be inlined");
  const target = reference ? configRegistry.lookup(reference) : undefined;
  if (reference && target === undefined)
    throw new Error(`Missing schema ${reference}`);
  const expanded =
    target === undefined
      ? undefined
      : inline(target, reference!.split("#")[0]!, [...ancestors, reference!]);
  if (
    expanded !== undefined &&
    (typeof expanded !== "object" ||
      expanded === null ||
      Array.isArray(expanded))
  )
    throw new Error("Schema reference must resolve to an object");
  return {
    ...expanded,
    ...Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== "$ref" && key !== "$id")
        .map(([key, child]) => [key, inline(child, base, ancestors)]),
    ),
  };
}
export const configCandidates: readonly McpCandidate[] = Object.entries(
  fragment.operations,
).map(([op, declaration]) => ({
  op,
  admitted: true,
  declaration,
  docs: { title: op, summary: `Core operation ${op}.` },
  inputSchema: inline(
    configRegistry.lookup(`${BASE}${declaration.input}`),
    `${BASE}${declaration.input}`,
  ) as McpCandidate["inputSchema"],
  outputSchema: inline(
    configRegistry.lookup(`${BASE}${declaration.output}`),
    `${BASE}${declaration.output}`,
  ) as JsonSchema & McpCandidate["inputSchema"],
}));
export function validateConfigValue(
  declaration: OperationDeclaration,
  side: "input" | "output",
  value: unknown,
): boolean {
  return (
    configRegistry.validate(`${BASE}${declaration[side]}`, value).length === 0
  );
}
