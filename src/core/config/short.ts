// The short config form. A file may leave out schemaVersion, name a built-in by its short name
// (`check:` is forge/check), name an outside block with `use:`, and put a block's settings straight
// under its instance; it is read as the long form. Nothing here applies defaults: those are the
// lowest layer of the one resolver (layers.ts), read from the block's own configSchema.
import type { JsonSchema } from "../../contract/schema.ts";
import { jsonEqual } from "../../contract/schema.ts";
import type { BlockLookup } from "./document.ts";
import { clone, formatPointer, isObject, type JsonObject } from "./pointer.ts";

/** Project the validated document back into each instance's original spelling. */
export function keepForm(
  next: JsonObject,
  original: JsonObject,
  lookup: BlockLookup,
): JsonObject {
  const result = clone(next);
  const short = !Object.hasOwn(original, "schemaVersion");
  if (short) delete result.schemaVersion;
  const blocks = isObject(result.blocks) ? result.blocks : {};
  const previous = isObject(original.blocks) ? original.blocks : {};
  for (const [name, instance] of Object.entries(blocks)) {
    if (!isObject(instance)) continue;
    const was = isObject(previous[name]) ? previous[name] : {};
    const sourceOwned =
      isObject(next.owners) &&
      Object.hasOwn(next.owners, formatPointer(["blocks", name, "source"]));
    const compact = Object.hasOwn(previous, name)
      ? !Object.hasOwn(was, "config")
      : short;
    if (
      (Object.hasOwn(previous, name) || short) &&
      !Object.hasOwn(was, "source") &&
      !(sourceOwned && !Object.hasOwn(previous, name)) &&
      jsonEqual(instance.source, lookup.builtinSource?.(name))
    )
      delete instance.source;
    if (
      (typeof was.use === "string" ||
        (short && !Object.hasOwn(previous, name))) &&
      isObject(instance.source)
    ) {
      const path = instance.source.path;
      const use =
        typeof path === "string"
          ? path.startsWith(".")
            ? path
            : `./${path}`
          : instance.source.package;
      if (typeof use === "string") {
        instance.use = use;
        delete instance.source;
      }
    }
    if (isObject(instance.config)) {
      const remaining: JsonObject = {};
      for (const [key, value] of Object.entries(instance.config)) {
        if (!INSTANCE_KEYS.has(key) && (compact || Object.hasOwn(was, key)))
          instance[key] = value;
        else remaining[key] = value;
      }
      if (Object.keys(remaining).length > 0 || Object.hasOwn(was, "config"))
        instance.config = remaining;
      else delete instance.config;
    }
    if (previous[name] === null && Object.keys(instance).length === 0)
      blocks[name] = null;
  }
  return result;
}

/** Instance keys that configure the instance itself; every other key belongs to the block's config. */
export const INSTANCE_KEYS: ReadonlySet<string> = new Set([
  "source",
  "use",
  "enabled",
  "config",
  "bind",
  "rename",
  "operationTimeouts",
]);

/** A `use` that names a location outside the project: a root, a drive, a share or a home folder. */
function isAbsoluteUse(use: string): boolean {
  return /^[/\\~]|^[A-Za-z]:/.test(use);
}

/** One problem per instance whose `use` is absolute; only paths relative to the project are blocks. */
export function absoluteUses(
  document: JsonObject,
): Array<{ pointer: string; message: string }> {
  const blocks = isObject(document.blocks) ? document.blocks : {};
  return Object.entries(blocks).flatMap(([name, instance]) =>
    isObject(instance) &&
    typeof instance.use === "string" &&
    isAbsoluteUse(instance.use)
      ? [
          {
            pointer: formatPointer(["blocks", name, "use"]),
            message: `must be a path relative to the project, like ./blocks/${name}`,
          },
        ]
      : [],
  );
}

/**
 * Rewrite a decoded document from the short form to the long form, in place. Anything that cannot
 * be rewritten without guessing (`use` beside `source`, a key set both inline and under `config`)
 * is left where it is, so the document schema refuses it at its own pointer.
 */
export function expandShortForm(document: JsonObject): JsonObject {
  if (!Object.hasOwn(document, "schemaVersion"))
    document.schemaVersion = "forge.config/1";
  const blocks = isObject(document.blocks) ? document.blocks : {};
  for (const [name, value] of Object.entries(blocks)) {
    // `check:` with nothing under it switches the block on with its defaults
    if (value === null) blocks[name] = {};
    const instance = blocks[name];
    if (!isObject(instance)) continue;
    // An absolute `use` stays as written, so the edit and load checks refuse it with its own message.
    if (
      typeof instance.use === "string" &&
      !isAbsoluteUse(instance.use) &&
      !Object.hasOwn(instance, "source")
    ) {
      instance.source = instance.use.startsWith(".")
        ? { path: instance.use }
        : { package: instance.use };
      delete instance.use;
    }
    const inline = Object.keys(instance).filter(
      (key) => !INSTANCE_KEYS.has(key),
    );
    if (inline.length === 0) continue;
    if (instance.config !== undefined && !isObject(instance.config)) continue;
    const config = isObject(instance.config) ? instance.config : {};
    for (const key of inline) {
      if (Object.hasOwn(config, key)) continue;
      config[key] = instance[key];
      delete instance[key];
    }
    instance.config = config;
  }
  return document;
}

/**
 * Top-level properties a config schema declares as maps (named entries, no fixed keys). A map is
 * declared as a whole: once a higher layer sets any entry, detected entries no longer fill it.
 */
export function schemaMaps(schema: JsonSchema | undefined): string[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([key, property]) =>
    isObject(property) &&
    property.type === "object" &&
    (property.properties === undefined ||
      (isObject(property.properties) &&
        Object.keys(property.properties).length === 0)) &&
    property.additionalProperties !== false
      ? [key]
      : [],
  );
}

/** Every `default` a config schema declares on its top-level properties. */
export function schemaDefaults(
  schema: JsonSchema | undefined,
): Array<{ key: string; value: unknown }> {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([key, property]) =>
    isObject(property) && Object.hasOwn(property, "default")
      ? [{ key, value: property.default }]
      : [],
  );
}
