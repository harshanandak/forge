import {
  DIRECT_SUBSCHEMAS,
  SCHEMA_DIALECT,
  pointerFragment,
  schemaBudget,
  type JsonSchema,
  type SchemaObject,
  type SchemaRegistry,
} from "./schema.ts";

const LISTS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf"]);
const SAME_VALUE: ReadonlySet<string> = new Set(["not", "if", "then", "else"]);
const DESCENDING: ReadonlySet<string> = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
]);
const RESOURCES: ReadonlySet<string> = new Set(["$id", "$schema", "$defs"]);

interface Target {
  readonly uri: string;
  readonly name: string;
  readonly schema: JsonSchema;
}

function split(uri: string): [string, string] {
  const hash = uri.indexOf("#");
  return hash === -1 ? [uri, ""] : [uri.slice(0, hash), uri.slice(hash + 1)];
}

function entries(value: unknown): [string, unknown][] {
  return typeof value === "object" && value !== null
    ? Object.entries(value)
    : [];
}

export function bundleSchema(
  registry: SchemaRegistry,
  reference: string,
): SchemaObject {
  const spend = schemaBudget();
  const targets = new Map<string, Target>();
  const names = new Set<string>();
  const queue: Target[] = [];
  const locate = (ref: string, base?: string): [string, string, JsonSchema] => {
    const uri = registry.resolve(ref, base);
    const [document, fragment] = split(uri);
    let segments: string[] | undefined;
    try {
      segments = pointerFragment(fragment);
    } catch {
      segments = undefined;
    }
    const schema = segments === undefined ? undefined : registry.lookup(uri);
    if (segments === undefined || schema === undefined)
      throw new Error(`Schema reference ${uri} does not resolve`);
    return [`${document}#${JSON.stringify(segments)}`, uri, schema];
  };
  const target = (ref: string, base: string): string => {
    const [key, uri, schema] = locate(ref, base);
    const known = targets.get(key);
    if (known !== undefined) return known.name;
    const [document, fragment] = split(uri);
    const last =
      pointerFragment(fragment)?.at(-1) ?? document.split("/").at(-1) ?? "";
    const label = last.replace(/[^A-Za-z0-9_.-]/g, "_") || "schema";
    let name = label;
    for (let count = 1; names.has(name); count += 1) name = `${label}-${count}`;
    names.add(name);
    const found = { uri, name, schema };
    targets.set(key, found);
    queue.push(found);
    return name;
  };
  const literal = (value: unknown, depth: number): unknown => {
    const pending: unknown[] = [value];
    while (pending.length > 0) {
      const next = pending.pop();
      spend(depth);
      if (typeof next === "string")
        spend(depth, Math.ceil(Math.max(0, next.length - 64) / 8));
      for (const [, child] of entries(next)) pending.push(child);
    }
    return value;
  };
  const copy = (
    schema: JsonSchema,
    base: string,
    depth: number,
  ): JsonSchema => {
    spend(depth);
    if (typeof schema === "boolean") return schema;
    const out: [string, unknown][] = [];
    for (const key in schema) {
      if (!Object.hasOwn(schema, key) || RESOURCES.has(key)) continue;
      spend(depth);
      const value = schema[key];
      const child = (node: unknown) =>
        copy(node as JsonSchema, base, depth + 1);
      if (key === "$ref")
        out.push([key, `#/$defs/${target(String(value), base)}`]);
      else if (key === "properties") {
        const properties: [string, unknown][] = [];
        for (const [name, node] of entries(value))
          properties.push([name, child(node)]);
        out.push([key, Object.fromEntries(properties)]);
      } else if (LISTS.has(key) && Array.isArray(value))
        out.push([key, value.map(child)]);
      else if (DIRECT_SUBSCHEMAS.has(key)) out.push([key, child(value)]);
      else out.push([key, literal(value, depth + 1)]);
    }
    return Object.fromEntries(out);
  };
  const [, uri, schema] = locate(reference);
  const root = copy(schema, split(uri)[0], 0);
  const definitions: [string, JsonSchema][] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    definitions.push([next.name, copy(next.schema, split(next.uri)[0], 0)]);
  }
  const defs = new Map(definitions);
  const heights = new Map<string, number>();
  const active = new Set<string>();
  const height = (node: unknown, incoming: number): number => {
    spend(incoming, 0);
    let max = 0;
    for (const [key, value] of entries(node)) {
      if (key === "$ref") {
        const name = String(value).slice("#/$defs/".length);
        let known = heights.get(name);
        if (known === undefined) {
          if (active.has(name))
            throw new Error(
              `Schema reference cycle at ${queue.find((next) => next.name === name)?.uri ?? name} does not descend into the value`,
            );
          active.add(name);
          known = height(defs.get(name), incoming + 1);
          active.delete(name);
          heights.set(name, known);
        }
        spend(incoming + 1 + known, 0);
        max = Math.max(max, 1 + known);
      } else if (LISTS.has(key) && Array.isArray(value))
        for (const child of value)
          max = Math.max(max, 1 + height(child, incoming + 1));
      else if (SAME_VALUE.has(key))
        max = Math.max(max, 1 + height(value, incoming + 1));
    }
    return max;
  };
  const visit = (node: unknown): void => {
    for (const [key, value] of entries(node)) {
      if (key === "properties")
        for (const [, child] of entries(value)) {
          height(child, 0);
          visit(child);
        }
      else if (DESCENDING.has(key)) {
        height(value, 0);
        visit(value);
      } else if (LISTS.has(key) && Array.isArray(value)) value.forEach(visit);
      else if (SAME_VALUE.has(key)) visit(value);
    }
  };
  height(root, 0);
  visit(root);
  definitions.forEach(([, definition]) => visit(definition));
  return {
    $schema: SCHEMA_DIALECT,
    ...(typeof root === "boolean" ? { allOf: [root] } : root),
    ...(definitions.length === 0
      ? {}
      : { $defs: Object.fromEntries(definitions) }),
  };
}
