import {
  COMPOSITION_KEYWORDS,
  SCHEMA_CHILD_KEYWORDS,
  SCHEMA_DIALECT,
  schemaBudget,
  isSchemaObject,
  type JsonSchema,
  type SchemaObject,
  type SchemaRegistry,
} from "./schema.ts";

interface Definition {
  name: string;
  edges: Definition[];
}

export function bundleSchema(
  registry: SchemaRegistry,
  reference: string,
): SchemaObject {
  const targets = new Map<string, Definition>();
  const definitions: Record<string, JsonSchema> = {};
  const spend = schemaBudget();

  const bundle = (
    uri: string,
    depth: number,
    edges?: Definition[],
  ): JsonSchema => {
    const schema = registry.lookup(uri);
    if (schema === undefined) throw new Error(`Missing schema ${uri}`);
    return walk(schema, uri.split("#")[0]!, depth, edges);
  };

  const walk = (
    schema: JsonSchema,
    base: string,
    depth: number,
    edges?: Definition[],
  ): JsonSchema => {
    spend(depth);
    if (typeof schema === "boolean") return schema;
    const entries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$id" || key === "$schema" || key === "$defs") continue;
      if (key === "$ref" && typeof value === "string") {
        const uri = registry.resolve(value, base);
        let target = targets.get(uri);
        if (target === undefined) {
          target = { name: `ref${targets.size}`, edges: [] };
          targets.set(uri, target);
          definitions[target.name] = bundle(uri, depth + 1, target.edges);
        }
        edges?.push(target);
        entries.push([key, `#/$defs/${target.name}`]);
      } else if (key === "properties" && isSchemaObject(value)) {
        entries.push([
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              walk(child as JsonSchema, base, depth + 1),
            ]),
          ),
        ]);
      } else if (COMPOSITION_KEYWORDS.has(key) && Array.isArray(value)) {
        entries.push([
          key,
          (value as JsonSchema[]).map((child) =>
            walk(child, base, depth + 1, edges),
          ),
        ]);
      } else if (SCHEMA_CHILD_KEYWORDS.has(key)) {
        const sameValue =
          key === "not" || key === "if" || key === "then" || key === "else";
        entries.push([
          key,
          walk(
            value as JsonSchema,
            base,
            depth + 1,
            sameValue ? edges : undefined,
          ),
        ]);
      } else {
        entries.push([key, value]);
      }
    }
    return Object.fromEntries(entries);
  };

  const root = bundle(registry.resolve(reference), 0);
  const active = new Set<Definition>();
  const checked = new Set<Definition>();
  const checkProgress = (target: Definition, depth: number): void => {
    spend(depth);
    if (active.has(target))
      throw new Error("Schema reference cycle does not descend into the value");
    if (checked.has(target)) return;
    active.add(target);
    for (const edge of target.edges) checkProgress(edge, depth + 1);
    active.delete(target);
    checked.add(target);
  };
  for (const target of targets.values()) checkProgress(target, 0);
  return {
    $schema: SCHEMA_DIALECT,
    ...(typeof root === "boolean" ? { allOf: [root] } : root),
    ...(targets.size === 0 ? {} : { $defs: definitions }),
  };
}
