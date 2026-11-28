import {
  DIRECT_SUBSCHEMAS,
  MAX_SCHEMA_VISITS_PER_VALUE,
  SCHEMA_DIALECT,
  pointerFragment,
  schemaBudget,
  type JsonSchema,
  type SchemaObject,
  type SchemaRegistry,
} from "./schema.ts";

const LISTS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf"]);
const SAME_VALUE: ReadonlySet<string> = new Set(["not", "if", "then", "else"]);
const CHILDREN: ReadonlyMap<string, string> = new Map([
  ["items", "[]"],
  ["additionalProperties", "*"],
  ["propertyNames", "*"],
]);
const RESOURCES: ReadonlySet<string> = new Set(["$id", "$schema", "$defs"]);
const CAP = MAX_SCHEMA_VISITS_PER_VALUE;

interface Target {
  readonly uri: string;
  readonly name: string;
  readonly schema: JsonSchema;
}

type State = Map<JsonSchema, number>;

interface Summary {
  readonly height: number;
  readonly work: number;
  readonly kids: ReadonlyMap<string, State>;
}

function split(uri: string): [string, string] {
  const hash = uri.indexOf("#");
  return hash === -1 ? [uri, ""] : [uri.slice(0, hash), uri.slice(hash + 1)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function bundleSchema(
  registry: SchemaRegistry,
  reference: string,
): SchemaObject {
  const spend = schemaBudget();
  const text = (depth: number, value: string): void =>
    spend(depth, 1 + Math.ceil(Math.max(0, value.length - 64) / 8));
  const registryBase = registry.base;
  text(0, registryBase);
  const targets = new Map<string, Target>();
  const names = new Set<string>();
  const suffixes = new Map<string, number>();
  const queue: Target[] = [];
  const locate = (
    ref: string,
    base?: string,
  ): [string, string, JsonSchema, string[]] => {
    text(0, ref);
    if (base !== undefined) text(0, base);
    const uri = registry.resolve(ref, base ?? registryBase);
    text(0, uri);
    const [document, fragment] = split(uri);
    let segments: string[] | undefined;
    try {
      segments = pointerFragment(fragment);
    } catch {
      segments = undefined;
    }
    const schema =
      segments === undefined ? undefined : registry.lookup(uri, registryBase);
    if (segments === undefined || schema === undefined)
      throw new Error(`Schema reference ${uri} does not resolve`);
    return [`${document}#${JSON.stringify(segments)}`, uri, schema, segments];
  };
  const target = (ref: string, base: string): string => {
    const [key, uri, schema, segments] = locate(ref, base);
    const known = targets.get(key);
    if (known !== undefined) return known.name;
    const last = segments.at(-1) ?? split(uri)[0].split("/").at(-1) ?? "";
    const label = last.replace(/[^A-Za-z0-9_.-]/g, "_") || "schema";
    let count = suffixes.get(label) ?? 0;
    let name = count === 0 ? label : `${label}-${count}`;
    while (names.has(name)) {
      text(0, name);
      count += 1;
      name = `${label}-${count}`;
    }
    suffixes.set(label, count + 1);
    names.add(name);
    const found = { uri, name, schema };
    targets.set(key, found);
    queue.push(found);
    return name;
  };
  const literal = (value: unknown, depth: number): unknown => {
    const pending: [unknown, number][] = [[value, depth]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [node, at] = next;
      if (typeof node === "string") text(at, node);
      else spend(at);
      if (!isRecord(node)) continue;
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        text(at + 1, key);
        pending.push([node[key], at + 1]);
      }
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
      text(depth, key);
      const value = schema[key];
      const child = (node: unknown) =>
        copy(node as JsonSchema, base, depth + 1);
      if (key === "$ref") {
        const name = target(String(value), base);
        text(depth, name);
        out.push([key, `#/$defs/${name}`]);
      } else if (key === "properties" && isRecord(value)) {
        const properties: [string, unknown][] = [];
        for (const name in value) {
          if (!Object.hasOwn(value, name)) continue;
          text(depth + 1, name);
          properties.push([name, child(value[name])]);
        }
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
    const found = queue[index]!;
    definitions.push([found.name, copy(found.schema, split(found.uri)[0], 1)]);
  }
  const defs = new Map(definitions);
  const put = (
    into: Map<string, State>,
    edge: string,
    child: JsonSchema,
    count: number,
  ): void => {
    spend(0);
    const state = into.get(edge) ?? new Map<JsonSchema, number>();
    state.set(child, Math.min(CAP + 1, (state.get(child) ?? 0) + count));
    into.set(edge, state);
  };
  const memo = new Map<JsonSchema, Summary>();
  const active = new Set<JsonSchema>();
  const summary = (node: JsonSchema, incoming: number): Summary => {
    spend(incoming);
    const known = memo.get(node);
    if (known !== undefined) {
      spend(incoming + known.height, 0);
      return known;
    }
    let height = 0;
    let work = 1;
    const kids = new Map<string, State>();
    const merge = (part: Summary): void => {
      height = Math.max(height, 1 + part.height);
      work = Math.min(CAP + 1, work + part.work);
      for (const [edge, state] of part.kids)
        for (const [child, count] of state) put(kids, edge, child, count);
    };
    if (typeof node !== "boolean") {
      active.add(node);
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        const value = node[key];
        if (key === "$ref") {
          const name = String(value).slice("#/$defs/".length);
          const def = defs.get(name)!;
          if (active.has(def))
            throw new Error(
              `Schema reference cycle at ${queue.find((next) => next.name === name)?.uri ?? name} does not descend into the value`,
            );
          merge(summary(def, incoming + 1));
        } else if (LISTS.has(key) && Array.isArray(value))
          for (const child of value)
            merge(summary(child as JsonSchema, incoming + 1));
        else if (SAME_VALUE.has(key))
          merge(summary(value as JsonSchema, incoming + 1));
        else if (key === "properties" && isRecord(value)) {
          for (const name in value)
            if (Object.hasOwn(value, name))
              put(kids, `.${name}`, value[name] as JsonSchema, 1);
        } else if (CHILDREN.has(key))
          put(kids, CHILDREN.get(key)!, value as JsonSchema, 1);
      }
      active.delete(node);
    }
    const result = { height, work, kids };
    memo.set(node, result);
    return result;
  };
  const ids = new Map<JsonSchema, number>();
  const seen = new Set<string>();
  const states: State[] = [new Map([[root, 1]])];
  for (let state = states.pop(); state !== undefined; state = states.pop()) {
    const counts: [number, number][] = [];
    for (const [node, count] of state) {
      spend(0);
      if (!ids.has(node)) ids.set(node, ids.size);
      counts.push([ids.get(node)!, count]);
    }
    const key = counts.sort((a, b) => a[0] - b[0]).join(";");
    if (seen.has(key)) continue;
    seen.add(key);
    let visits = 0;
    const children = new Map<string, State>();
    for (const [node, count] of state) {
      const part = summary(node, 0);
      visits += count * part.work;
      if (visits > CAP)
        throw new Error(`Schema work budget exceeded (${CAP} visits)`);
      for (const [edge, kids] of part.kids)
        for (const [child, n] of kids) put(children, edge, child, count * n);
    }
    const rest = children.get("*");
    for (const [edge, kids] of children) {
      if (rest !== undefined && edge.startsWith("."))
        for (const [child, n] of rest) put(children, edge, child, n);
      states.push(kids);
    }
  }
  return {
    $schema: SCHEMA_DIALECT,
    ...(typeof root === "boolean" ? { allOf: [root] } : root),
    ...(definitions.length === 0
      ? {}
      : { $defs: Object.fromEntries(definitions) }),
  };
}
