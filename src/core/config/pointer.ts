// JSON Pointer (RFC 6901) helpers over plain JSON trees, plus the short dotted form people type:
// `check.commands.test` addresses `/blocks/check/config/commands/test`. A dotted key segment needs
// the pointer form, so dots in real keys are never split.
import { createHash } from "node:crypto";

export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePointer(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(raw)) return undefined;
    segments.push(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return segments;
}

export function formatPointer(segments: readonly string[]): string {
  return segments
    .map((s) => `/${s.replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
}

/** A pointer, or `<instance>.<key>...` meaning that instance's config. */
export function toPointer(path: string): string[] | undefined {
  if (path.startsWith("/")) return parsePointer(path);
  const parts = path.split(".");
  if (parts.length < 2 || parts.some((p) => p === "")) return undefined;
  const [instance, ...keys] = parts as [string, ...string[]];
  return ["blocks", instance, "config", ...keys];
}

export function getIn(root: unknown, segments: readonly string[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (!isObject(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

export function hasIn(root: unknown, segments: readonly string[]): boolean {
  let node = root;
  for (const segment of segments) {
    if (!isObject(node) || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  return true;
}

/** Set a value, creating objects on the way; a non-object on the way is replaced. */
export function setIn(
  root: JsonObject,
  segments: readonly string[],
  value: unknown,
): void {
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (isObject(next)) {
      node = next;
    } else {
      const created: JsonObject = {};
      defineKey(node, segment, created);
      node = created;
    }
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) defineKey(node, leaf, value);
}

function defineKey(node: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(node, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Remove a key and prune objects the removal left empty, up to (not including) `keepDepth`. */
export function removeIn(
  root: JsonObject,
  segments: readonly string[],
  keepDepth = 0,
): boolean {
  const chain: JsonObject[] = [root];
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (!isObject(next)) return false;
    node = next;
    chain.push(node);
  }
  const leaf = segments.at(-1);
  if (leaf === undefined || !Object.hasOwn(node, leaf)) return false;
  delete node[leaf];
  for (let depth = chain.length - 1; depth > keepDepth; depth -= 1) {
    const child = chain[depth];
    const parent = chain[depth - 1];
    const key = segments[depth - 1];
    if (child === undefined || parent === undefined || key === undefined) break;
    if (Object.keys(child).length > 0) break;
    delete parent[key];
  }
  return true;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Leaves of a JSON tree: scalars, arrays and empty objects, each with its pointer segments.
 * `atomic(segments)` marks objects to keep whole.
 */
export function leaves(
  root: unknown,
  atomic: (segments: readonly string[]) => boolean = () => false,
  prefix: readonly string[] = [],
): Array<{ segments: string[]; value: unknown }> {
  const branch =
    isObject(root) && Object.keys(root).length > 0 && !atomic(prefix);
  if (!branch) {
    const emptyRoot = prefix.length === 0 && isObject(root);
    return emptyRoot ? [] : [{ segments: [...prefix], value: root }];
  }
  const found: Array<{ segments: string[]; value: unknown }> = [];
  for (const [key, child] of Object.entries(root)) {
    found.push(...leaves(child, atomic, [...prefix, key]));
  }
  return found;
}

/** JSON with object keys sorted, so equal values have equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digestBytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestValue(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

export function isPrefix(
  prefix: readonly string[],
  segments: readonly string[],
): boolean {
  return (
    prefix.length <= segments.length &&
    prefix.every((s, i) => segments[i] === s)
  );
}
