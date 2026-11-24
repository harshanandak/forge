import { fail, ok, type Reason, type Result } from "./result.ts";

export type Predicate<T> = (value: unknown, source: string) => value is T;
const openShape = Symbol();
const reservedKeys = new Set(["__proto__", "constructor", "prototype"]);
export type Fields = { [key: string]: Shape; [openShape]?: true };
export type Shape = Predicate<unknown> | [Shape] | Fields;
export type Value<S> =
  S extends Predicate<infer T>
    ? T
    : S extends [infer Item]
      ? Value<Item>[]
      : { [Key in Exclude<keyof S, typeof openShape>]: Value<S[Key]> };

export const uint = (value: unknown, source: string): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  /^\d+$/.test(source);
export const bool = (value: unknown): value is boolean =>
  typeof value === "boolean";
export const str = (value: unknown): value is string =>
  typeof value === "string";
export const open = <S extends Fields>(fields: S) => ({
  ...fields,
  [openShape]: true as const,
});
export const list = <S extends Shape>(item: S): [S] => [item];

export function parseStrictJson<S extends Shape>(
  text: string,
  schema: S,
  prefix = "",
): Result<Value<S>> {
  const root = `${prefix}$`;
  let failure = fail("json_invalid", root);
  function invalid(where: string, reason: Reason = "json_invalid"): never {
    failure = fail(reason, where);
    throw new SyntaxError();
  }
  try {
    JSON.parse(text);
    const tokens =
      text.match(/"(?:[^"\\]|\\.)*"|[[\]{}]|[^ \r\t\n[\]{}:,"]+/g) ?? [];
    let index = 0;
    const take = () => tokens[index++] ?? "";
    function read(shape: Shape | undefined, where: string): unknown {
      const token = take();
      const fields =
        typeof shape === "object" && !Array.isArray(shape) ? shape : undefined;
      const item = Array.isArray(shape) ? shape[0] : undefined;
      const container = token === "{" || token === "[" ? token : undefined;
      const expected = fields ? "{" : item ? "[" : undefined;
      if (shape && container !== expected)
        invalid(where, where === root ? "json_invalid" : "api_field_invalid");
      if (token === "{") {
        const entries = new Map<string, unknown>();
        while (tokens[index] !== "}") {
          const key = JSON.parse(take()) as string;
          const child = `${where}.${key}`;
          const field =
            fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
          const forbidden = reservedKeys.has(key) || entries.has(key);
          const unknown = fields && !fields[openShape] && !field;
          if (forbidden || unknown) invalid(child);
          entries.set(key, read(field, child));
        }
        index++;
        return Object.fromEntries(
          Object.keys(fields ?? {}).map((key) => {
            if (!entries.has(key))
              invalid(`${where}.${key}`, "api_field_invalid");
            return [key, entries.get(key)];
          }),
        );
      }
      if (token === "[") {
        const items: unknown[] = [];
        while (tokens[index] !== "]")
          items.push(read(item, `${where}[${items.length}]`));
        index++;
        return items;
      }
      const value: unknown = JSON.parse(token);
      if (typeof shape === "function" && !shape(value, token))
        invalid(where, "api_field_invalid");
      return value;
    }
    return ok(read(schema, root) as Value<S>);
  } catch {
    return failure;
  }
}
