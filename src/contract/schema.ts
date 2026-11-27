// A JSON Schema (2020-12) validator for the bounded keyword profile Forge's own schemas use.
// Schemas are data; nothing here evaluates code. A schema using a keyword outside the profile is
// refused when the registry is built, so a validator can never silently skip a rule.
import { nameDistance } from "./distance.ts";

export type SchemaObject = Readonly<Record<string, unknown>>;
export type JsonSchema = boolean | SchemaObject;

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export const DIRECT_SUBSCHEMAS: ReadonlySet<string> = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

class SchemaLimit extends Error {}
type SchemaBudget = (depth: number, units?: number) => void;
type ValidationBudget = (
  depth: number,
  pointer?: string,
  units?: number,
) => void;
type Charge = (units: number) => void;

export function schemaBudget(maxDepth = 64, maxNodes = 20_000): SchemaBudget {
  let remaining = maxNodes;
  return (depth, units = 1) => {
    if (depth > maxDepth)
      throw new SchemaLimit(`Schema depth limit exceeded (${maxDepth})`);
    remaining -= units;
    if (remaining < 0)
      throw new SchemaLimit(`Schema work budget exceeded (${maxNodes} nodes)`);
  };
}

const MAX_VALIDATION_DEPTH = 256;
const MAX_VALIDATION_VISITS = 1_000_000;
const MAX_SCHEMA_VISITS_PER_VALUE = 4_096;

function validationBudget(): ValidationBudget {
  const spend = schemaBudget(MAX_VALIDATION_DEPTH, MAX_VALIDATION_VISITS);
  const visits = new Map<string, number>();
  return (depth, pointer, units) => {
    spend(depth, units);
    if (pointer === undefined) return;
    const count = (visits.get(pointer) ?? 0) + 1;
    if (count > MAX_SCHEMA_VISITS_PER_VALUE) {
      throw new SchemaLimit(
        `Schema work budget exceeded (${MAX_SCHEMA_VISITS_PER_VALUE} visits)`,
      );
    }
    visits.set(pointer, count);
  };
}

function diagnosticJson(
  value: unknown,
  spend: ValidationBudget,
  depth: number,
): string {
  const inspect = (node: unknown, level: number): void => {
    spend(
      level,
      undefined,
      typeof node === "string" ? 1 + Math.ceil(node.length / 8) : 1,
    );
    if (Array.isArray(node))
      for (const child of node as unknown[]) inspect(child, level + 1);
    else if (isObject(node))
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        spend(level, undefined, 1 + Math.ceil(key.length / 8));
        inspect(node[key], level + 1);
      }
  };
  inspect(value, depth);
  return JSON.stringify(value) ?? "missing";
}

function suggestionDistance(
  name: string,
  option: string,
  charge?: Charge,
  limit?: number,
): number {
  if (limit !== undefined && Math.abs(name.length - option.length) > limit) {
    charge?.(1);
    return limit + 1;
  }
  charge?.((name.length + 1) * (option.length + 1));
  return nameDistance(name, option, limit);
}

function compareNames(a: string, b: string, charge?: Charge): number {
  charge?.(1 + Math.ceil((a.length + b.length) / 8));
  return a.localeCompare(b);
}

export interface SchemaProblem {
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
  readonly suggestion?: string;
  /** Names declared at this object position across reachable schema branches. */
  readonly knownProperties?: readonly string[];
  /** Failed object alternatives, retained for config compatibility without changing diagnostics. */
  readonly alternatives?: readonly (readonly SchemaProblem[])[];
}

/** Closest declared spelling; the schema, rather than a list of special cases, owns the names. */
export function closestNames(
  name: string,
  names: readonly string[],
  charge?: Charge,
): string[] {
  const limit = Math.max(2, Math.floor(name.length / 3));
  return names
    .map((key) => ({
      key,
      score: suggestionDistance(name, key, charge, limit),
    }))
    .filter(({ score }) => score <= limit)
    .sort((a, b) => a.score - b.score || compareNames(a.key, b.key, charge))
    .slice(0, 8)
    .map(({ key }) => key);
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly SchemaProblem[] };

export type Validator<T> = (value: unknown) => ValidationResult<T>;

/** Keywords that only annotate; they never change whether a value is valid. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
]);

/** Keywords that constrain a value. Anything else is refused. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$ref",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
]);

const TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Bound on remembered references; a registry sees a fixed set, but callers may pass any reference. */
const MEMO_LIMIT = 4096;

const DATE_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|[+-]([0-9]{2}):([0-9]{2}))$/u;

/**
 * An RFC 3339 date-time whose fields are real: a month 1-12, a day that exists in that month and
 * year, an hour below 24, a minute and second below 60 and an offset within a day. A leap second
 * (`:60`) is refused because `Date.parse` cannot read it, and lease fencing compares parsed times.
 */
export function isRfc3339DateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offsetHour === undefined ||
    offsetMinute === undefined
  ) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = DAYS_IN_MONTH[month - 1];
  if (monthDays === undefined) return false;
  return (
    day >= 1 &&
    day <= (month === 2 && leap ? 29 : monthDays) &&
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    offsetHour < 24 &&
    offsetMinute < 60
  );
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSchemaObject(value: unknown): value is SchemaObject {
  return isObject(value);
}

export function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function budgetedPointer(
  at: string,
  key: string | number,
  spend: ValidationBudget,
  depth: number,
): string {
  const segment = String(key);
  spend(depth, undefined, Math.ceil((at.length + 1 + 2 * segment.length) / 64));
  return `${at}/${escapePointer(segment)}`;
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Decode a URI fragment before interpreting its JSON Pointer separators and escapes. */
export function pointerFragment(fragment: string): string[] | undefined {
  const decoded = decodeURIComponent(fragment);
  if (decoded === "") return [];
  if (!decoded.startsWith("/")) return undefined;
  return decoded.slice(1).split("/").map(unescapePointer);
}

/** Structural equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return equalJson(a, b);
}

function equalJson(
  a: unknown,
  b: unknown,
  spend?: SchemaBudget,
  depth = 0,
): boolean {
  spend?.(depth);
  if (typeof a === "string" && typeof b === "string" && a.length === b.length) {
    spend?.(depth, Math.ceil(Math.max(0, a.length - 64) / 8));
  }
  if (a === b) return true;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => equalJson(item, b[index], spend, depth + 1))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = equalityKeys(a, spend, depth);
    return (
      keys.length === equalityKeys(b, spend, depth).length &&
      keys.every(
        (key) =>
          Object.hasOwn(b, key) && equalJson(a[key], b[key], spend, depth + 1),
      )
    );
  }
  return false;
}

function equalityKeys(
  value: SchemaObject,
  spend: SchemaBudget | undefined,
  depth: number,
): string[] {
  if (spend === undefined) return Object.keys(value);
  const keys: string[] = [];
  for (const key in value) {
    spend(depth);
    if (Object.hasOwn(value, key)) keys.push(key);
  }
  return keys;
}

const hasPrototype = (value: object, prototype: object | null): boolean =>
  Object.getPrototypeOf(value) === prototype;

/** What a value is, when it is not JSON: a short name for the refusal message. */
function nonJsonKind(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(value) ? undefined : String(value);
    case "object":
      if (value === null || Array.isArray(value)) return undefined;
      return hasPrototype(value, Object.prototype) || hasPrototype(value, null)
        ? undefined
        : "a non-plain object";
    default:
      return typeof value;
  }
}

/**
 * The first place a value leaves the JSON domain: undefined, functions, symbols, bigints,
 * non-finite numbers, objects that are not plain, array holes and cycles. These pass an
 * unconstrained schema yet change or vanish when serialized, so they are refused before any schema
 * keyword runs. Iterative, so a deeply nested value cannot overflow the stack.
 */
export function findNonJson(root: unknown): SchemaProblem | undefined {
  interface Frame {
    readonly value: unknown;
    readonly pointer: string;
    readonly exit?: true;
  }
  const refuse = (pointer: string, what: string): SchemaProblem => ({
    pointer,
    keyword: "json",
    message: `${what} is not a JSON value`,
  });
  const ancestors = new Set<object>();
  const verified = new Set<object>();
  const stack: Frame[] = [{ value: root, pointer: "" }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { value, pointer } = frame;
    if (frame.exit === true) {
      ancestors.delete(value as object);
      verified.add(value as object);
      continue;
    }
    const kind = nonJsonKind(value);
    if (kind !== undefined) return refuse(pointer, kind);
    if (typeof value !== "object" || value === null) continue;
    if (ancestors.has(value)) return refuse(pointer, "a cycle");
    if (verified.has(value)) continue;
    ancestors.add(value);
    stack.push({ value, pointer, exit: true });
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) return refuse(`${pointer}/${index}`, "a hole");
        stack.push({ value: value[index], pointer: `${pointer}/${index}` });
      }
    } else {
      for (const [key, child] of Object.entries(value)) {
        stack.push({
          value: child,
          pointer: `${pointer}/${escapePointer(key)}`,
        });
      }
    }
  }
  return undefined;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function hasType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function documentUri(uri: string): string {
  const hash = uri.indexOf("#");
  return hash === -1 ? uri : uri.slice(0, hash);
}

interface Located {
  readonly schema: JsonSchema;
  readonly base: string;
}

/** Documents the build already checked in full; a registry that holds them skips checking them again. */
const BUILD_CHECKED = new WeakSet<object>();

/**
 * Mark documents as fully checked at build time (tools/gen/types.ts runs the same check over the
 * same bytes and fails the build on a problem), so startup does not walk them on every command.
 * Only the generated schema list uses this; a document from a block or project is always checked.
 */
export function markBuildChecked<T extends readonly SchemaObject[]>(
  documents: T,
): T {
  for (const document of documents) BUILD_CHECKED.add(document);
  return documents;
}

/**
 * Every schema document Forge knows, by `$id`. Built once; refuses unknown keywords, unresolvable
 * `$ref`s and invalid patterns up front.
 */
export class SchemaRegistry {
  readonly #documents = new Map<string, SchemaObject>();
  readonly #patterns = new Map<string, RegExp>();
  readonly #validators = new Map<string, Validator<unknown>>();
  // Documents never change after construction, so a reference resolves and locates the same
  // way every time; validating one value follows the same few references over and over.
  readonly #resolved = new Map<string, string>();
  readonly #located = new Map<string, Located | undefined>();
  readonly #base: string;

  /** `base` resolves short references such as `block.json#/$defs/X` given to `validator`. */
  constructor(
    documents: ReadonlyArray<SchemaObject>,
    base = "urn:forge:inline",
  ) {
    this.#base = base;
    for (const document of documents) {
      const id = document.$id;
      const uri = typeof id === "string" ? documentUri(id) : base;
      if (this.#documents.has(uri)) {
        throw new Error(`schema ${uri} is registered twice`);
      }
      this.#documents.set(uri, document);
    }
    for (const [uri, document] of this.#documents) {
      if (!BUILD_CHECKED.has(document))
        this.#check(document, uri, "", 0, schemaBudget());
    }
  }

  /** The full URI a short reference resolves to. */
  resolve(reference: string, base: string = this.#base): string {
    const key = `${base}\u0000${reference}`;
    let uri = this.#resolved.get(key);
    if (uri === undefined) {
      uri = new URL(reference, base).href;
      if (this.#resolved.size < MEMO_LIMIT) this.#resolved.set(key, uri);
    }
    return uri;
  }

  /** The schema a reference points at, or undefined. */
  lookup(reference: string, base: string = this.#base): JsonSchema | undefined {
    return this.#locate(this.resolve(reference, base))?.schema;
  }

  validate(
    reference: string,
    value: unknown,
    detailed = false,
  ): SchemaProblem[] {
    const uri = this.resolve(reference);
    const located = this.#locate(uri);
    if (located === undefined) throw new Error(`no schema at ${uri}`);
    const outside = findNonJson(value);
    if (outside !== undefined) return [outside];
    try {
      return this.#validateValue(located, value, detailed);
    } catch (error) {
      if (!(error instanceof SchemaLimit)) throw error;
      return [{ pointer: "", keyword: "budget", message: error.message }];
    }
  }

  #validateValue(
    located: Located,
    value: unknown,
    detailed: boolean,
  ): SchemaProblem[] {
    const spend = validationBudget();
    const problems = this.#evaluate(
      located.schema,
      located.base,
      value,
      "",
      spend,
      0,
      detailed,
    );
    if (problems.length === 0) return problems;
    const declared = this.#declaredProperties(
      located.schema,
      located.base,
      value,
      spend,
    );
    const protect = (
      entries: readonly SchemaProblem[],
      depth = 0,
    ): SchemaProblem[] =>
      entries.map((problem) => {
        spend(depth);
        const alternatives = problem.alternatives?.map((branch) =>
          protect(branch, depth + 1),
        );
        if (problem.knownProperties === undefined)
          return alternatives === undefined
            ? problem
            : { ...problem, alternatives };
        const charge = (units: number) => spend(depth, undefined, units);
        charge(1 + Math.ceil(problem.pointer.length / 8));
        const parent = problem.pointer.slice(
          0,
          problem.pointer.lastIndexOf("/"),
        );
        const otherNames = declared.get(parent);
        charge(problem.knownProperties.length + (otherNames?.size ?? 0));
        const names = [
          ...new Set([...problem.knownProperties, ...(otherNames ?? [])]),
        ];
        const key = unescapePointer(
          problem.pointer.slice(problem.pointer.lastIndexOf("/") + 1),
        );
        const lower = key.toLowerCase();
        const caseMatch = names.find((name) => {
          charge(1 + Math.ceil(name.length / 8));
          return name.toLowerCase() === lower;
        });
        const suggestion = names.includes(key)
          ? undefined
          : (caseMatch ??
            (detailed
              ? closestName(key, names, charge)
              : closestNames(key, names, charge)[0]));
        const { suggestion: _suggestion, ...rest } = problem;
        return {
          ...rest,
          knownProperties: names,
          ...(suggestion === undefined ? {} : { suggestion }),
          ...(alternatives === undefined ? {} : { alternatives }),
        };
      });
    return protect(problems);
  }

  /** All declarations at each value position, including sibling alternatives and referenced branches. */
  #declaredProperties(
    schema: JsonSchema,
    base: string,
    value: unknown,
    spend: ValidationBudget,
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const declared = new Map<string, Set<string>>();
    const seen = new Set<string>();
    const visit = (
      node: unknown,
      uri: string,
      current: unknown,
      at: string,
      depth: number,
    ): void => {
      spend(depth);
      if (!isObject(node)) return;
      const descend = (
        child: unknown,
        base: string,
        value: unknown,
        pointer: string,
      ) => visit(child, base, value, pointer, depth + 1);
      if (typeof node.$ref === "string") {
        const reference = this.resolve(node.$ref, uri);
        spend(
          depth,
          undefined,
          Math.ceil((6 * (reference.length + at.length) + 7) / 8),
        );
        const key = JSON.stringify([reference, at]);
        if (!seen.has(key)) {
          seen.add(key);
          const target = this.#locate(reference);
          if (target) descend(target.schema, target.base, current, at);
        }
      }
      if (isObject(current)) {
        const properties = isObject(node.properties) ? node.properties : {};
        const names = declared.get(at) ?? new Set<string>();
        for (const name of Object.keys(properties)) {
          spend(depth, undefined, 1 + Math.ceil(name.length / 8));
          names.add(name);
        }
        declared.set(at, names);
        for (const [key, child] of Object.entries(current))
          descend(
            Object.hasOwn(properties, key)
              ? properties[key]
              : node.additionalProperties,
            uri,
            child,
            budgetedPointer(at, key, spend, depth),
          );
      } else if (Array.isArray(current)) {
        current.forEach((child, index) =>
          descend(
            node.items,
            uri,
            child,
            budgetedPointer(at, index, spend, depth),
          ),
        );
      }
      for (const keyword of ["allOf", "oneOf", "anyOf"])
        if (Array.isArray(node[keyword]))
          for (const branch of node[keyword]) descend(branch, uri, current, at);
      for (const keyword of ["if", "then", "else", "not"])
        if (node[keyword] !== undefined)
          descend(node[keyword], uri, current, at);
    };
    visit(schema, base, value, "", 0);
    return declared;
  }

  validator<T>(reference: string): Validator<T> {
    const uri = this.resolve(reference);
    const cached = this.#validators.get(uri);
    if (cached !== undefined) return cached as Validator<T>;
    if (this.#locate(uri) === undefined) throw new Error(`no schema at ${uri}`);
    const validator: Validator<T> = (value) => {
      const problems = this.validate(uri, value);
      return problems.length === 0
        ? { ok: true, value: value as T }
        : { ok: false, problems };
    };
    this.#validators.set(uri, validator);
    return validator;
  }

  #locate(uri: string): Located | undefined {
    if (this.#located.has(uri)) return this.#located.get(uri);
    const found = this.#find(uri);
    if (this.#located.size < MEMO_LIMIT) this.#located.set(uri, found);
    return found;
  }

  #find(uri: string): Located | undefined {
    const base = documentUri(uri);
    const document = this.#documents.get(base);
    if (document === undefined) return undefined;
    const hash = uri.indexOf("#");
    const segments = pointerFragment(hash === -1 ? "" : uri.slice(hash + 1));
    if (segments === undefined) return undefined;
    let node: unknown = document;
    for (let index = 0; index < segments.length;) {
      const keyword = segments[index++]!;
      if (!isObject(node) || !Object.hasOwn(node, keyword)) return undefined;
      node = node[keyword];
      if (keyword === "$defs" || keyword === "properties") {
        const name = segments[index++];
        if (name === undefined || !isObject(node) || !Object.hasOwn(node, name))
          return undefined;
        node = node[name];
      } else if (!DIRECT_SUBSCHEMAS.has(keyword)) return undefined;
    }
    return typeof node === "boolean" || isObject(node)
      ? { schema: node, base }
      : undefined;
  }

  #check(
    schema: unknown,
    base: string,
    at: string,
    depth: number,
    spend: SchemaBudget,
  ): void {
    spend(depth);
    if (typeof schema === "boolean") return;
    if (!isObject(schema)) {
      throw new Error(`${base}#${at}: a schema must be an object or boolean`);
    }
    for (const [keyword, value] of Object.entries(schema)) {
      if (keyword.startsWith("x-")) continue;
      if (ANNOTATIONS.has(keyword)) {
        if (keyword === "$schema" && value !== SCHEMA_DIALECT) {
          throw new Error(
            `${base}#${at}: unsupported schema dialect ${String(value)}`,
          );
        }
        if (keyword === "$id" && depth !== 0) {
          throw new Error(`${base}#${at}: $id is allowed only at a root`);
        }
        if (keyword === "$defs" && !isObject(value)) {
          throw new Error(`${base}#${at}: $defs must be an object`);
        }
        continue;
      }
      if (!SUPPORTED_KEYWORDS.has(keyword)) {
        throw new Error(
          `${base}#${at}: keyword "${keyword}" is outside the supported profile`,
        );
      }
      this.#checkKeyword(
        keyword,
        value,
        base,
        `${at}/${keyword}`,
        depth,
        spend,
      );
    }
    if (isObject(schema.$defs)) {
      for (const [name, def] of Object.entries(schema.$defs)) {
        this.#check(
          def,
          base,
          `${at}/$defs/${escapePointer(name)}`,
          depth + 1,
          spend,
        );
      }
    }
  }

  #checkKeyword(
    keyword: string,
    value: unknown,
    base: string,
    at: string,
    depth: number,
    spend: SchemaBudget,
  ): void {
    const fail = (message: string): never => {
      throw new Error(`${base}#${at}: ${message}`);
    };
    switch (keyword) {
      case "$ref": {
        if (typeof value !== "string") fail("$ref must be a string");
        const target = this.resolve(value as string, base);
        if (this.#locate(target) === undefined) {
          fail(`$ref ${String(value)} does not resolve`);
        }
        return;
      }
      case "type": {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || !types.every((t) => TYPES.has(String(t)))) {
          fail("type must name JSON types");
        }
        return;
      }
      case "enum":
        if (!Array.isArray(value) || value.length === 0) {
          fail("enum must be a non-empty array");
        }
        return;
      case "pattern":
        if (typeof value !== "string") fail("pattern must be a string");
        this.#pattern(value as string);
        return;
      case "format":
        if (value !== "date-time") {
          fail(
            `format ${JSON.stringify(value)} is outside the supported profile`,
          );
        }
        return;
      case "required":
        if (
          !Array.isArray(value) ||
          !value.every((v) => typeof v === "string")
        ) {
          fail("required must list property names");
        }
        return;
      case "properties":
        if (!isObject(value)) fail("properties must be an object");
        for (const [name, sub] of Object.entries(value as SchemaObject)) {
          this.#check(
            sub,
            base,
            `${at}/${escapePointer(name)}`,
            depth + 1,
            spend,
          );
        }
        return;
      case "oneOf":
      case "anyOf":
      case "allOf":
        if (!Array.isArray(value) || value.length === 0) {
          fail(`${keyword} must be a non-empty array`);
        }
        (value as unknown[]).forEach((sub, index) => {
          this.#check(sub, base, `${at}/${index}`, depth + 1, spend);
        });
        return;
      case "additionalProperties":
      case "propertyNames":
      case "items":
      case "not":
      case "if":
      case "then":
      case "else":
        this.#check(value, base, at, depth + 1, spend);
        return;
      case "uniqueItems":
        if (typeof value !== "boolean") fail("uniqueItems must be a boolean");
        return;
      case "const":
        return;
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
      case "exclusiveMaximum":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail(`${keyword} must be a finite number`);
        }
        return;
      default:
        if (!Number.isInteger(value) || (value as number) < 0) {
          fail(`${keyword} must be a non-negative integer`);
        }
    }
  }

  #pattern(source: string): RegExp {
    let regex = this.#patterns.get(source);
    if (regex === undefined) {
      regex = new RegExp(source, "u");
      this.#patterns.set(source, regex);
    }
    return regex;
  }

  #evaluate(
    schema: JsonSchema,
    base: string,
    value: unknown,
    at: string,
    spend: ValidationBudget,
    depth: number,
    detailed = false,
  ): SchemaProblem[] {
    spend(depth, at);
    if (schema === true) return [];
    const charge = (units: number) => spend(depth, undefined, units);
    const render = (data: unknown) => diagnosticJson(data, spend, depth);
    const problems: SchemaProblem[] = [];
    const append = (entries: readonly SchemaProblem[]) => {
      charge(entries.length);
      for (const entry of entries) problems.push(entry);
    };
    const add = (
      keyword: string,
      message: string,
      pointer = at,
      expected: string | (() => string) = message,
      received: string | (() => string) = () => render(value),
      suggestion?: string,
      knownProperties?: readonly string[],
      alternatives?: readonly (readonly SchemaProblem[])[],
    ): void => {
      spend(depth);
      problems.push({
        pointer,
        keyword,
        message,
        ...(suggestion === undefined ? {} : { suggestion }),
        ...(knownProperties === undefined ? {} : { knownProperties }),
        ...(alternatives === undefined ? {} : { alternatives }),
        ...(detailed
          ? {
              expected: typeof expected === "string" ? expected : expected(),
              received: typeof received === "string" ? received : received(),
            }
          : {}),
      });
    };
    if (schema === false) {
      add("false", "no value is allowed here", at, "no value");
      return problems;
    }
    const sub = (s: unknown, v: unknown, p: string): SchemaProblem[] =>
      this.#evaluate(s as JsonSchema, base, v, p, spend, depth + 1, detailed);
    const equal = (left: unknown, right: unknown) =>
      equalJson(
        left,
        right,
        (level, units) => spend(level, undefined, units),
        depth + 1,
      );

    if (typeof schema.$ref === "string") {
      const uri = this.resolve(schema.$ref, base);
      const target = this.#locate(uri);
      if (target === undefined) {
        charge(Math.ceil(uri.length / 8));
        add("$ref", `unresolvable reference ${uri}`);
      } else
        append(
          this.#evaluate(
            target.schema,
            target.base,
            value,
            at,
            spend,
            depth + 1,
            detailed,
          ),
        );
    }

    if (schema.type !== undefined) {
      const types = (
        Array.isArray(schema.type) ? schema.type : [schema.type]
      ).map(String);
      if (!types.some((type) => hasType(value, type))) {
        add(
          "type",
          `expected ${types.join(" or ")}, got ${typeOf(value)}`,
          at,
          types.join(" or "),
        );
        return problems;
      }
    }
    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((e) => equal(e, value))
    ) {
      charge(schema.enum.length);
      const suggested =
        typeof value === "string"
          ? closestNames(
              value,
              schema.enum.filter(
                (entry): entry is string => typeof entry === "string",
              ),
              charge,
            )[0]
          : undefined;
      const options = render(schema.enum);
      add(
        "enum",
        `expected one of ${options}`,
        at,
        `one of ${options}`,
        undefined,
        suggested,
      );
    }
    if ("const" in schema && !equal(schema.const, value)) {
      const expected = render(schema.const);
      add("const", `expected ${expected}`, at, expected);
    }

    if (typeof value === "string") {
      const stringWork = Math.ceil(Math.max(0, value.length - 64) / 8);
      if (
        typeof schema.minLength === "number" ||
        typeof schema.maxLength === "number"
      ) {
        charge(stringWork);
        let length = 0;
        for (const _point of value) length++;
        if (typeof schema.minLength === "number" && length < schema.minLength)
          add("minLength", `must be at least ${schema.minLength} characters`);
        if (typeof schema.maxLength === "number" && length > schema.maxLength)
          add("maxLength", `must be at most ${schema.maxLength} characters`);
      }
      if (typeof schema.pattern === "string") {
        charge(stringWork);
        if (!this.#pattern(schema.pattern).test(value)) {
          charge(Math.ceil(schema.pattern.length / 8));
          add("pattern", `must match ${schema.pattern}`);
        }
      }
      if (schema.format === "date-time") {
        charge(stringWork);
        if (!isRfc3339DateTime(value))
          add("format", "must be an RFC 3339 date-time with real field values");
      }
    }

    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        add("minimum", `must be at least ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        add("maximum", `must be at most ${schema.maximum}`);
      }
      if (
        typeof schema.exclusiveMinimum === "number" &&
        value <= schema.exclusiveMinimum
      ) {
        add("exclusiveMinimum", `must be more than ${schema.exclusiveMinimum}`);
      }
      if (
        typeof schema.exclusiveMaximum === "number" &&
        value >= schema.exclusiveMaximum
      ) {
        add("exclusiveMaximum", `must be less than ${schema.exclusiveMaximum}`);
      }
    }

    if (Array.isArray(value)) {
      if (
        typeof schema.minItems === "number" &&
        value.length < schema.minItems
      ) {
        add("minItems", `must have at least ${schema.minItems} items`);
      }
      if (
        typeof schema.maxItems === "number" &&
        value.length > schema.maxItems
      ) {
        add("maxItems", `must have at most ${schema.maxItems} items`);
      }
      if (schema.uniqueItems === true) {
        const scalars = new Set<unknown>();
        const compounds: object[] = [];
        const duplicate = value.findIndex((item: unknown) => {
          spend(depth);
          if (typeof item === "object" && item !== null) {
            if (compounds.some((earlier) => equal(earlier, item))) return true;
            compounds.push(item);
          } else {
            if (scalars.has(item)) return true;
            scalars.add(item);
          }
          return false;
        });
        if (duplicate !== -1) {
          add(
            "uniqueItems",
            "items must be unique",
            budgetedPointer(at, duplicate, spend, depth),
          );
        }
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          append(
            sub(schema.items, item, budgetedPointer(at, index, spend, depth)),
          );
        });
      }
    }

    if (isObject(value)) {
      const keys = Object.keys(value);
      const properties = isObject(schema.properties) ? schema.properties : {};
      if (
        typeof schema.minProperties === "number" &&
        keys.length < schema.minProperties
      ) {
        add(
          "minProperties",
          `must have at least ${schema.minProperties} properties`,
        );
      }
      if (
        typeof schema.maxProperties === "number" &&
        keys.length > schema.maxProperties
      ) {
        add(
          "maxProperties",
          `must have at most ${schema.maxProperties} properties`,
        );
      }
      if (Array.isArray(schema.required)) {
        for (const name of schema.required) {
          if (typeof name === "string" && !Object.hasOwn(value, name)) {
            charge(Math.ceil(name.length / 8));
            add(
              "required",
              `missing required property "${name}"`,
              budgetedPointer(at, name, spend, depth),
              () =>
                this.#expected(
                  properties[name] as JsonSchema | undefined,
                  base,
                  render,
                ),
              "missing",
            );
          }
        }
      }
      for (const key of keys) {
        const pointer = budgetedPointer(at, key, spend, depth);
        if (schema.propertyNames !== undefined) {
          for (const problem of sub(schema.propertyNames, key, pointer)) {
            charge(Math.ceil((key.length + problem.message.length) / 8));
            add(
              "propertyNames",
              `property name "${key}": ${problem.message}`,
              pointer,
            );
          }
        }
        if (Object.hasOwn(properties, key)) {
          append(sub(properties[key], value[key], pointer));
        } else if (schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) {
            charge(Math.ceil(key.length / 8));
            const known = Object.keys(properties);
            for (const name of known) charge(1 + Math.ceil(name.length / 8));
            add(
              "additionalProperties",
              `unknown property "${key}"`,
              pointer,
              () => `one of ${known.join(", ") || "no properties"}`,
              () => render(value[key]),
              undefined,
              known,
            );
          } else {
            append(sub(schema.additionalProperties, value[key], pointer));
          }
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf) append(sub(part, value, at));
    }
    if (Array.isArray(schema.anyOf)) {
      const results = schema.anyOf.map((part) => sub(part, value, at));
      if (!results.some((r) => r.length === 0)) {
        add(
          "anyOf",
          "matches none of the allowed alternatives",
          at,
          undefined,
          undefined,
          undefined,
          undefined,
          isObject(value) ? results : undefined,
        );
        append(closest(results));
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const results = schema.oneOf.map((part) => sub(part, value, at));
      const matches = results.filter((r) => r.length === 0).length;
      if (matches === 0) {
        add(
          "oneOf",
          "matches none of the allowed alternatives",
          at,
          undefined,
          undefined,
          undefined,
          undefined,
          isObject(value) ? results : undefined,
        );
        append(closest(results));
      } else if (matches > 1) {
        add("oneOf", `matches ${matches} alternatives; exactly one is allowed`);
      }
    }
    if (schema.not !== undefined && sub(schema.not, value, at).length === 0) {
      add("not", "matches a shape that is not allowed here");
    }
    if (schema.if !== undefined) {
      const branch =
        sub(schema.if, value, at).length === 0 ? schema.then : schema.else;
      if (branch !== undefined) append(sub(branch, value, at));
    }
    return problems;
  }

  #expected(
    schema: JsonSchema | undefined,
    base: string,
    render: (value: unknown) => string,
    hops = 0,
  ): string {
    if (!isObject(schema)) return schema === false ? "no value" : "a value";
    if (Array.isArray(schema.enum)) return `one of ${render(schema.enum)}`;
    if (typeof schema.type === "string") return schema.type;
    if (Array.isArray(schema.type)) return schema.type.join(" or ");
    if (typeof schema.$ref === "string" && hops < 8) {
      const target = this.#locate(this.resolve(schema.$ref, base));
      if (target)
        return this.#expected(target.schema, target.base, render, hops + 1);
    }
    return "a value matching the declared schema";
  }
}

function closestName(
  name: string,
  choices: readonly string[],
  charge: Charge,
): string | undefined {
  return choices
    .map((candidate) => ({
      name: candidate,
      score: suggestionDistance(name, candidate, charge),
    }))
    .sort(
      (a, b) => a.score - b.score || compareNames(a.name, b.name, charge),
    )[0]?.name;
}

/** The problems of the alternative that came closest, so a refusal says what to fix. */
function closest(results: readonly SchemaProblem[][]): SchemaProblem[] {
  let best: SchemaProblem[] = [];
  for (const result of results) {
    if (best.length === 0 || result.length < best.length) best = result;
  }
  return best;
}

/** Validate a value against one standalone schema, such as a block's configSchema. */
export function validateWithSchema(
  schema: JsonSchema,
  value: unknown,
  detailed = false,
): SchemaProblem[] {
  const outside = findNonJson(value);
  if (outside !== undefined) return [outside];
  if (typeof schema === "boolean") {
    return schema
      ? []
      : [{ pointer: "", keyword: "false", message: "no value is allowed" }];
  }
  const id = typeof schema.$id === "string" ? schema.$id : "#";
  return new SchemaRegistry([schema]).validate(id, value, detailed);
}
