// The short config form and schema defaults. A file may leave out schemaVersion, name an outside
// block with `use:`, and put a block's settings straight under its instance; it is read as the long
// form. Defaults declared in a block's configSchema fill keys nothing else sets, as their own layer,
// so `config explain` can say a value came from the schema.
import type { JsonSchema } from "../../contract/schema.ts";
import { clone, formatPointer, isObject, type JsonObject } from "./pointer.ts";

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
  for (const instance of Object.values(blocks)) {
    if (!isObject(instance)) continue;
    // An absolute `use` stays as written, so checkDocument refuses it with its own message.
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

export interface DefaultValue {
  readonly segments: readonly string[];
  readonly value: unknown;
}

/** Every `default` a config schema declares on its top-level properties, under one prefix. */
export function schemaDefaults(
  schema: JsonSchema | undefined,
  prefix: readonly string[],
): DefaultValue[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([key, property]) =>
    isObject(property) && Object.hasOwn(property, "default")
      ? [{ segments: [...prefix, key], value: property.default }]
      : [],
  );
}

/** A config with its schema's defaults filled in for keys it leaves out; explicit values win. */
export function withDefaults(
  schema: JsonSchema | undefined,
  config: JsonObject,
): JsonObject {
  const filled: JsonObject = { ...config };
  for (const { segments, value } of schemaDefaults(schema, [])) {
    const [key = ""] = segments;
    if (!Object.hasOwn(filled, key)) filled[key] = clone(value);
  }
  return filled;
}
