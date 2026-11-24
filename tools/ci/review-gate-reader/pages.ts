import type { Result } from "./result.ts";
import { list, type Fields, type Value } from "./strict-json.ts";
import { getJson, type Transport } from "./transport.ts";

type Identity<T> = {
  field: keyof T & string;
  select: (item: T) => string | number;
};

export const numericId = {
  field: "id",
  select: (item: { id: number }) => item.id,
} as const;

export const fileName = {
  field: "filename",
  select: (item: { filename: string }) => item.filename,
} as const;

export async function readPages<S extends Fields>(
  transport: Transport,
  path: string,
  item: S,
  _identity: Identity<NoInfer<Value<S>>>,
): Promise<Result<Value<S>[]>> {
  return getJson(transport, path, list(item));
}
