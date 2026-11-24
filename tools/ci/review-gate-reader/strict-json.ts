import { fail, ok, type Result } from "./result.ts";

export type Predicate<T> = (value: unknown, source: string) => value is T;
const openShape = Symbol();
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
  _schema: S,
): Result<Value<S>> {
  try {
    return ok(JSON.parse(text) as Value<S>);
  } catch {
    return fail("json_invalid", "$");
  }
}
