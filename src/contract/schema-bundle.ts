import {
  DIRECT_SUBSCHEMAS,
  SCHEMA_DIALECT,
  pointerFragment,
  schemaBudget,
  type JsonSchema,
  type SchemaObject,
  type SchemaRegistry,
} from "./schema.ts";

const COMPOSITIONS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf"]);
const SAME_VALUE: ReadonlySet<string> = new Set([
  "$ref",
  ...COMPOSITIONS,
  "not",
  "if",
  "then",
  "else",
]);
const RESOURCE_KEYWORDS: ReadonlySet<string> = new Set([
  "$id",
  "$schema",
  "$defs",
]);

interface Target {
  readonly uri: string;
  readonly name: string;
  readonly edges: Set<Target>;
}

function documentOf(uri: string): string {
  const hash = uri.indexOf("#");
  return hash === -1 ? uri : uri.slice(0, hash);
}

function label(uri: string): string {
  const hash = uri.indexOf("#");
  const pointer =
    hash === -1 ? [] : (pointerFragment(uri.slice(hash + 1)) ?? []);
  const last = pointer.at(-1) ?? documentOf(uri).split("/").at(-1) ?? "";
  return last.replace(/[^A-Za-z0-9_.-]/g, "_") || "schema";
}

export function bundleSchema(
  registry: SchemaRegistry,
  reference: string,
): SchemaObject {
  const spend = schemaBudget();
  const targets = new Map<string, Target>();
  const counts = new Map<string, number>();
  const names = new Set<string>();
  const queue: Target[] = [];
  const locate = (ref: string, base?: string): [string, JsonSchema] => {
    const resolved = registry.resolve(ref, base);
    const uri = resolved.endsWith("#") ? resolved.slice(0, -1) : resolved;
    const schema = registry.lookup(uri);
    if (schema === undefined)
      throw new Error(`Schema reference ${uri} does not resolve`);
    return [uri, schema];
  };
  const target = (uri: string): Target => {
    let found = targets.get(uri);
    if (found !== undefined) return found;
    const base = label(uri);
    let count = counts.get(base) ?? 0;
    let name = base;
    while (names.has(name)) name = `${base}-${++count}`;
    counts.set(base, count);
    names.add(name);
    found = { uri, name, edges: new Set() };
    targets.set(uri, found);
    queue.push(found);
    return found;
  };
  const walk = (
    schema: JsonSchema,
    base: string,
    depth: number,
    edges?: Set<Target>,
  ): JsonSchema => {
    spend(depth);
    if (typeof schema === "boolean") return schema;
    const copy: [string, unknown][] = [];
    for (const [key, value] of Object.entries(schema)) {
      if (RESOURCE_KEYWORDS.has(key)) continue;
      const same = SAME_VALUE.has(key) ? edges : undefined;
      if (key === "$ref") {
        const found = target(locate(value as string, base)[0]);
        same?.add(found);
        copy.push([key, `#/$defs/${found.name}`]);
      } else if (key === "properties")
        copy.push([
          key,
          Object.fromEntries(
            Object.entries(value as SchemaObject).map(([name, child]) => [
              name,
              walk(child as JsonSchema, base, depth + 1),
            ]),
          ),
        ]);
      else if (COMPOSITIONS.has(key))
        copy.push([
          key,
          (value as JsonSchema[]).map((child) =>
            walk(child, base, depth + 1, same),
          ),
        ]);
      else if (DIRECT_SUBSCHEMAS.has(key))
        copy.push([key, walk(value as JsonSchema, base, depth + 1, same)]);
      else copy.push([key, value]);
    }
    return Object.fromEntries(copy);
  };
  const [uri, schema] = locate(reference);
  const root = walk(schema, documentOf(uri), 0);
  const definitions: [string, JsonSchema][] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    const [, found] = locate(next.uri);
    definitions.push([
      next.name,
      walk(found, documentOf(next.uri), 0, next.edges),
    ]);
  }
  const done = new Map<Target, boolean>();
  const progress = (next: Target, depth: number): void => {
    spend(depth);
    const state = done.get(next);
    if (state === false)
      throw new Error(
        `Schema reference cycle at ${next.uri} does not descend into the value`,
      );
    if (state) return;
    done.set(next, false);
    for (const edge of next.edges) progress(edge, depth + 1);
    done.set(next, true);
  };
  for (const next of queue) progress(next, 0);
  return {
    $schema: SCHEMA_DIALECT,
    ...(typeof root === "boolean" ? { allOf: [root] } : root),
    ...(definitions.length === 0
      ? {}
      : { $defs: Object.fromEntries(definitions) }),
  };
}
