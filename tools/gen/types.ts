// Generate src/generated/** from schemas/**: TypeScript types, the embedded schema documents and
// one typed validator per named shape. The schemas are the one source of truth.
// The output is gitignored and never committed: `bun run check`, `lint`, `build` and `bun test` generate it
// first, so a clean checkout works. Usage: bun tools/gen/types.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGenerated } from "./write.ts";

type Schema = boolean | Readonly<Record<string, unknown>>;
type SchemaObject = Readonly<Record<string, unknown>>;

const PRINT_WIDTH = 80;
const HEADER =
  "// Generated from schemas/ by tools/gen/types.ts. Do not edit; regenerate instead.\n";

export const OUTPUTS = {
  types: "src/generated/types.ts",
  schemas: "src/generated/schemas.ts",
  validators: "src/generated/validators.ts",
} as const;

export const repoRoot: string = fileURLToPath(
  new URL("../../", import.meta.url),
);

interface Document {
  readonly file: string;
  readonly schema: SchemaObject;
}

function isObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFiles(dir: string): { file: string; value: SchemaObject }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((file) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!isObject(value)) throw new Error(`${file}: expected a JSON object`);
      return { file, value };
    });
}

/** A named shape: a document root with a title, or an entry under $defs. */
interface Named {
  readonly name: string;
  readonly file: string;
  readonly pointer: string;
  readonly schema: SchemaObject;
}

function collectNames(documents: readonly Document[]): Named[] {
  const named: Named[] = [];
  for (const { file, schema } of documents) {
    if (typeof schema.title === "string") {
      named.push({ name: schema.title, file, pointer: "", schema });
    }
    const defs = isObject(schema.$defs) ? schema.$defs : {};
    for (const [name, def] of Object.entries(defs)) {
      if (!isObject(def))
        throw new Error(`${file}#/$defs/${name}: not an object`);
      named.push({ name, file, pointer: `/$defs/${name}`, schema: def });
    }
  }
  const seen = new Set<string>();
  for (const { name, file } of named) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(`${file}: type name "${name}" must be PascalCase`);
    }
    if (seen.has(name)) throw new Error(`type name "${name}" is defined twice`);
    seen.add(name);
  }
  return named;
}

class TypeWriter {
  readonly #names = new Map<string, string>();

  constructor(named: ReadonlyArray<Named>) {
    for (const { name, file, pointer } of named) {
      this.#names.set(`${file}#${pointer}`, name);
    }
  }

  refName(reference: string, file: string): string {
    const [target = "", fragment = ""] = reference.split("#");
    const key = `${target === "" ? file : target}#${fragment}`;
    const name = this.#names.get(key);
    if (name === undefined) {
      throw new Error(`${file}: $ref ${reference} names no generated type`);
    }
    return name;
  }

  /** The TypeScript type of a schema, written for a line that starts at `indent`. */
  type(schema: Schema, file: string, indent: string): string {
    if (typeof schema === "boolean") return schema ? "unknown" : "never";
    if (typeof schema.$ref === "string") return this.refName(schema.$ref, file);
    if ("const" in schema) return literal(schema.const);
    if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ");
    const union = schema.oneOf ?? schema.anyOf;
    if (Array.isArray(union)) {
      return union.map((s) => this.type(s as Schema, file, indent)).join(" | ");
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const parts = types.map((t) =>
      this.#typeFor(String(t), schema, file, indent),
    );
    return parts.join(" | ");
  }

  #typeFor(
    type: string,
    schema: SchemaObject,
    file: string,
    indent: string,
  ): string {
    switch (type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const item =
          schema.items === undefined
            ? "unknown"
            : this.type(schema.items as Schema, file, indent);
        return item.includes(" ")
          ? `readonly (${item})[]`
          : `readonly ${item}[]`;
      }
      case "object":
        return this.#objectType(schema, file, indent);
      case "undefined":
        return "unknown";
      default:
        throw new Error(`${file}: unsupported type ${type}`);
    }
  }

  #objectType(schema: SchemaObject, file: string, indent: string): string {
    if (isObject(schema.properties)) {
      if (isObject(schema.additionalProperties)) {
        throw new Error(`${file}: properties with schema additionalProperties`);
      }
      return `{\n${this.members(schema, file, `${indent}  `)}${indent}}`;
    }
    const value = isObject(schema.additionalProperties)
      ? this.type(schema.additionalProperties, file, indent)
      : "unknown";
    return `Readonly<Record<string, ${value}>>`;
  }

  /** Interface members, one property per line, each preceded by its description. */
  members(schema: SchemaObject, file: string, indent: string): string {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    let out = "";
    for (const [key, sub] of Object.entries(properties)) {
      const property = sub as Schema;
      if (isObject(property) && typeof property.description === "string") {
        out += `${indent}${docComment(property.description)}\n`;
      }
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      const head = `${indent}readonly ${name}${required.has(key) ? "" : "?"}:`;
      out += `${unionLine(head, this.type(property, file, indent), indent)}\n`;
    }
    return out;
  }
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) {
    return JSON.stringify(value);
  }
  throw new Error(`unsupported literal ${JSON.stringify(value)}`);
}

function docComment(text: string): string {
  if (text.includes("*/")) throw new Error(`description contains */: ${text}`);
  return `/** ${text} */`;
}

/** Split a top-level union into its members, ignoring bars nested in brackets or strings. */
function unionMembers(type: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < type.length; i += 1) {
    const ch = type[i];
    if (ch === '"' && type[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "(" || ch === "{" || ch === "<" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === ">" || ch === "]") depth -= 1;
    if (depth === 0 && type.startsWith(" | ", i)) {
      members.push(type.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  members.push(type.slice(start));
  return members;
}

/** `head type;` on one line when it fits, else one union member per line, as the formatter prints it. */
function unionLine(head: string, type: string, indent: string): string {
  const oneLine = `${head} ${type};`;
  const members = unionMembers(type);
  if (
    oneLine.length <= PRINT_WIDTH ||
    members.length < 2 ||
    type.includes("\n")
  ) {
    return oneLine;
  }
  return `${head}\n${members.map((m) => `${indent}  | ${m}`).join("\n")};`;
}

function generateTypes(
  documents: readonly Document[],
  named: readonly Named[],
): string {
  const writer = new TypeWriter(named);
  const blocks: string[] = [];
  for (const { name, file, schema } of named) {
    let text = "";
    if (typeof schema.description === "string") {
      text += `${docComment(schema.description)}\n`;
    }
    const isInterface =
      isObject(schema.properties) &&
      schema.$ref === undefined &&
      schema.oneOf === undefined &&
      schema.anyOf === undefined;
    if (isInterface) {
      text += `export interface ${name} {\n${writer.members(schema, file, "  ")}}\n`;
    } else {
      text += `${unionLine(`export type ${name} =`, writer.type(schema, file, ""), "")}\n`;
    }
    blocks.push(text);
  }
  if (documents.length === 0) throw new Error("no schemas found");
  return `${HEADER}\n${blocks.join("\n")}`;
}

function embed(name: string, values: readonly SchemaObject[]): string {
  const json = JSON.stringify(values, null, 2);
  if (json.includes("`") || json.includes("${")) {
    throw new Error(`${name}: embedded JSON may not contain a backtick or \${`);
  }
  return `const ${name}Text = String.raw\`${json}\`;\n`;
}

function generateSchemas(
  documents: readonly Document[],
  interfaces: readonly Document[],
): string {
  return [
    HEADER,
    'import { asSchemaDocuments } from "../contract/documents.ts";',
    'import type { SchemaObject } from "../contract/schema.ts";',
    "",
    embed(
      "schema",
      documents.map((d) => d.schema),
    ),
    embed(
      "interface",
      interfaces.map((d) => d.schema),
    ),
    "/** Every schema document in schemas/, by $id. */",
    "export const SCHEMA_DOCUMENTS: readonly SchemaObject[] = asSchemaDocuments(",
    "  JSON.parse(schemaText),",
    ");",
    "",
    "/** Every interface document in schemas/interfaces/. */",
    "export const INTERFACE_DOCUMENTS: readonly SchemaObject[] = asSchemaDocuments(",
    "  JSON.parse(interfaceText),",
    ");",
    "",
  ].join("\n");
}

function generateValidators(named: readonly Named[]): string {
  const imports = named.map((n) => `  ${n.name},`).join("\n");
  const lines = named.map(({ name, file, pointer }) => {
    const reference = `${file}${pointer === "" ? "" : `#${pointer}`}`;
    const head = `export const validate${name}: Validator<${name}> =`;
    const call = `registry.validator(${JSON.stringify(reference)});`;
    const oneLine = `${head} ${call}`;
    if (oneLine.length <= PRINT_WIDTH) return oneLine;
    // The formatter breaks inside the call when its opening fits and the argument is not a short
    // lone string; otherwise it breaks after the `=`.
    const open = `${head} registry.validator(`;
    const shortArgument = JSON.stringify(reference).length <= PRINT_WIDTH / 4;
    return open.length <= PRINT_WIDTH && !shortArgument
      ? `${open}\n  ${JSON.stringify(reference)},\n);`
      : `${head}\n  ${call}`;
  });
  return [
    HEADER,
    'import { SchemaRegistry, type Validator } from "../contract/schema.ts";',
    'import { SCHEMA_BASE } from "../contract/documents.ts";',
    'import { SCHEMA_DOCUMENTS } from "./schemas.ts";',
    "import type {",
    imports,
    '} from "./types.ts";',
    "",
    "/** The registry of every Forge schema; short references resolve against schemas/. */",
    "export const registry: SchemaRegistry = new SchemaRegistry(",
    "  SCHEMA_DOCUMENTS,",
    "  SCHEMA_BASE,",
    ");",
    "",
    lines.join("\n\n"),
    "",
  ].join("\n");
}

/** Generated files by repository path. */
export function generate(root: string = repoRoot): Map<string, string> {
  const schemaDir = join(root, "schemas");
  const documents: Document[] = readJsonFiles(schemaDir).map(
    ({ file, value }) => ({
      file,
      schema: value,
    }),
  );
  const interfaces: Document[] = readJsonFiles(
    join(schemaDir, "interfaces"),
  ).map(({ file, value }) => ({ file, schema: value }));
  const named = collectNames(documents);
  return new Map([
    [OUTPUTS.types, generateTypes(documents, named)],
    [OUTPUTS.schemas, generateSchemas(documents, interfaces)],
    [OUTPUTS.validators, generateValidators(named)],
  ]);
}

/** Write generated outputs under `root`, leaving current files untouched. */
export function write(root: string = repoRoot): void {
  for (const [path, text] of generate(root)) {
    writeGenerated(join(root, path), text);
  }
}

if (import.meta.main) {
  write();
  const { writeCoreManifest } = await import("./core.ts");
  writeCoreManifest();
}
