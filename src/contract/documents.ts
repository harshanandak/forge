import {
  isSchemaObject,
  markBuildChecked,
  type SchemaObject,
} from "./schema.ts";

/** Base URI of every schema in schemas/; each schema's $id is this plus its file name. */
export const SCHEMA_BASE: string =
  "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/";

/** Check that embedded schema text parsed to a list of schema objects. */
export function asSchemaDocuments(value: unknown): readonly SchemaObject[] {
  if (!Array.isArray(value) || !value.every(isSchemaObject)) {
    throw new Error("embedded schema documents are not a list of objects");
  }
  return value;
}

/** The generated schema list: the build checked every document, so a registry need not. */
export function asBuildCheckedDocuments(
  value: unknown,
): readonly SchemaObject[] {
  return markBuildChecked(asSchemaDocuments(value));
}
