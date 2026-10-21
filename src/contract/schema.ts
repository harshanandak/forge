// A JSON Schema (2020-12) validator for the bounded keyword profile Forge's own schemas use.
// Schemas are data; nothing here evaluates code. A schema using a keyword outside the profile is
// refused when the registry is built, so a validator can never silently skip a rule.
import { nameDistance } from "./distance.ts";

export type SchemaObject = Readonly<Record<string, unknown>>;
export type JsonSchema = boolean | SchemaObject;

export interface SchemaProblem {
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
  readonly suggestion?: string;
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

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Structural equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
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

/**
 * Every schema document Forge knows, by `$id`. Built once; refuses unknown keywords, unresolvable
 * `$ref`s and invalid patterns up front.
 */
export class SchemaRegistry {
  readonly #documents = new Map<string, SchemaObject>();
  readonly #patterns = new Map<string, RegExp>();
  readonly #validators = new Map<string, Validator<unknown>>();
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
      this.#check(document, uri, "", true);
    }
  }

  /** The full URI a short reference resolves to. */
  resolve(reference: string, base: string = this.#base): string {
    return new URL(reference, base).href;
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
    return this.#evaluate(located.schema, located.base, value, "", detailed);
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
    const base = documentUri(uri);
    const document = this.#documents.get(base);
    if (document === undefined) return undefined;
    const hash = uri.indexOf("#");
    const fragment = hash === -1 ? "" : decodeURIComponent(uri.slice(hash + 1));
    if (fragment === "") return { schema: document, base };
    if (!fragment.startsWith("/")) return undefined;
    let node: unknown = document;
    for (const raw of fragment.slice(1).split("/")) {
      const segment = unescapePointer(raw);
      if (!isObject(node) || !Object.hasOwn(node, segment)) return undefined;
      node = node[segment];
    }
    return typeof node === "boolean" || isObject(node)
      ? { schema: node, base }
      : undefined;
  }

  #check(schema: unknown, base: string, at: string, root: boolean): void {
    if (typeof schema === "boolean") return;
    if (!isObject(schema)) {
      throw new Error(`${base}#${at}: a schema must be an object or boolean`);
    }
    for (const [keyword, value] of Object.entries(schema)) {
      if (keyword.startsWith("x-")) continue;
      if (ANNOTATIONS.has(keyword)) {
        if (keyword === "$id" && !root) {
          throw new Error(`${base}#${at}: $id is allowed only at a root`);
        }
        continue;
      }
      if (!SUPPORTED_KEYWORDS.has(keyword)) {
        throw new Error(
          `${base}#${at}: keyword "${keyword}" is outside the supported profile`,
        );
      }
      this.#checkKeyword(keyword, value, base, `${at}/${keyword}`);
    }
    if (isObject(schema.$defs)) {
      for (const [name, def] of Object.entries(schema.$defs)) {
        this.#check(def, base, `${at}/$defs/${escapePointer(name)}`, false);
      }
    }
  }

  #checkKeyword(
    keyword: string,
    value: unknown,
    base: string,
    at: string,
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
          this.#check(sub, base, `${at}/${escapePointer(name)}`, false);
        }
        return;
      case "oneOf":
      case "anyOf":
      case "allOf":
        if (!Array.isArray(value) || value.length === 0) {
          fail(`${keyword} must be a non-empty array`);
        }
        (value as unknown[]).forEach((sub, index) => {
          this.#check(sub, base, `${at}/${index}`, false);
        });
        return;
      case "additionalProperties":
      case "propertyNames":
      case "items":
      case "not":
      case "if":
      case "then":
      case "else":
        this.#check(value, base, at, false);
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
    detailed = false,
  ): SchemaProblem[] {
    if (schema === true) return [];
    if (schema === false) {
      return [
        {
          pointer: at,
          keyword: "false",
          message: "no value is allowed here",
          ...(detailed
            ? {
                expected: "no value",
                received: JSON.stringify(value) ?? "missing",
              }
            : {}),
        },
      ];
    }
    const problems: SchemaProblem[] = [];
    const add = (
      keyword: string,
      message: string,
      pointer = at,
      expected = message,
      received = detailed ? (JSON.stringify(value) ?? "missing") : "",
      suggestion?: string,
    ): void => {
      problems.push({
        pointer,
        keyword,
        message,
        ...(detailed
          ? {
              expected,
              received,
              ...(suggestion === undefined ? {} : { suggestion }),
            }
          : {}),
      });
    };
    const sub = (s: unknown, v: unknown, p: string): SchemaProblem[] =>
      this.#evaluate(s as JsonSchema, base, v, p, detailed);

    if (typeof schema.$ref === "string") {
      const uri = this.resolve(schema.$ref, base);
      const target = this.#locate(uri);
      if (target === undefined) add("$ref", `unresolvable reference ${uri}`);
      else
        problems.push(
          ...this.#evaluate(target.schema, target.base, value, at, detailed),
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
      !schema.enum.some((e) => jsonEqual(e, value))
    ) {
      add(
        "enum",
        `expected one of ${JSON.stringify(schema.enum)}`,
        at,
        `one of ${JSON.stringify(schema.enum)}`,
      );
    }
    if ("const" in schema && !jsonEqual(schema.const, value)) {
      add(
        "const",
        `expected ${JSON.stringify(schema.const)}`,
        at,
        JSON.stringify(schema.const),
      );
    }

    if (typeof value === "string") {
      const length = [...value].length;
      if (typeof schema.minLength === "number" && length < schema.minLength) {
        add("minLength", `must be at least ${schema.minLength} characters`);
      }
      if (typeof schema.maxLength === "number" && length > schema.maxLength) {
        add("maxLength", `must be at most ${schema.maxLength} characters`);
      }
      if (
        typeof schema.pattern === "string" &&
        !this.#pattern(schema.pattern).test(value)
      ) {
        add("pattern", `must match ${schema.pattern}`);
      }
      if (schema.format === "date-time" && !isRfc3339DateTime(value)) {
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
        const duplicate = value.findIndex((item, index) =>
          value.slice(0, index).some((earlier) => jsonEqual(earlier, item)),
        );
        if (duplicate !== -1) {
          add("uniqueItems", "items must be unique", `${at}/${duplicate}`);
        }
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          problems.push(...sub(schema.items, item, `${at}/${index}`));
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
            add(
              "required",
              `missing required property "${name}"`,
              `${at}/${escapePointer(name)}`,
              this.#expected(properties[name] as JsonSchema | undefined, base),
              "missing",
            );
          }
        }
      }
      for (const key of keys) {
        const pointer = `${at}/${escapePointer(key)}`;
        if (schema.propertyNames !== undefined) {
          for (const problem of sub(schema.propertyNames, key, pointer)) {
            add(
              "propertyNames",
              `property name "${key}": ${problem.message}`,
              pointer,
            );
          }
        }
        if (Object.hasOwn(properties, key)) {
          problems.push(...sub(properties[key], value[key], pointer));
        } else if (schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) {
            add(
              "additionalProperties",
              `unknown property "${key}"`,
              pointer,
              `one of ${Object.keys(properties).join(", ") || "no properties"}`,
              detailed ? (JSON.stringify(value[key]) ?? "missing") : "",
              detailed ? closestName(key, Object.keys(properties)) : undefined,
            );
          } else {
            problems.push(
              ...sub(schema.additionalProperties, value[key], pointer),
            );
          }
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf) problems.push(...sub(part, value, at));
    }
    if (Array.isArray(schema.anyOf)) {
      const results = schema.anyOf.map((part) => sub(part, value, at));
      if (!results.some((r) => r.length === 0)) {
        add("anyOf", "matches none of the allowed alternatives");
        problems.push(...closest(results));
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const results = schema.oneOf.map((part) => sub(part, value, at));
      const matches = results.filter((r) => r.length === 0).length;
      if (matches === 0) {
        add("oneOf", "matches none of the allowed alternatives");
        problems.push(...closest(results));
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
      if (branch !== undefined) problems.push(...sub(branch, value, at));
    }
    return problems;
  }

  #expected(schema: JsonSchema | undefined, base: string, hops = 0): string {
    if (!isObject(schema)) return schema === false ? "no value" : "a value";
    if (Array.isArray(schema.enum))
      return `one of ${JSON.stringify(schema.enum)}`;
    if (typeof schema.type === "string") return schema.type;
    if (Array.isArray(schema.type)) return schema.type.join(" or ");
    if (typeof schema.$ref === "string" && hops < 8) {
      const target = this.#locate(this.resolve(schema.$ref, base));
      if (target) return this.#expected(target.schema, target.base, hops + 1);
    }
    return "a value matching the declared schema";
  }
}

function closestName(
  name: string,
  choices: readonly string[],
): string | undefined {
  return choices
    .map((candidate) => ({
      name: candidate,
      score: nameDistance(name, candidate),
    }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))[0]?.name;
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
