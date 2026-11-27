import type { SchemaObject, SchemaRegistry } from "./schema.ts";

export function bundleSchema(
  _registry: SchemaRegistry,
  _reference: string,
): SchemaObject {
  throw new Error("bundleSchema is not implemented");
}
