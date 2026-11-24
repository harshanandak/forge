import { fail, ok, type Result } from "./result.ts";
import { parseStrictJson, type Shape, type Value } from "./strict-json.ts";

export type Transport = {
  readonly origin: string;
  get(path: string): Promise<TransportResponse>;
};

export type TransportResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
};

export async function getResponse(
  transport: Transport,
  path: string,
): Promise<Result<TransportResponse>> {
  try {
    return ok(await transport.get(path));
  } catch {
    return fail("network_error", path);
  }
}

export function readBody<S extends Shape>(
  response: TransportResponse,
  path: string,
  schema: S,
): Result<Value<S>> {
  const result = parseStrictJson(response.body, schema);
  return result.ok ? result : fail(result.reason, `${path}#${result.where}`);
}

export async function getJson<S extends Shape>(
  transport: Transport,
  path: string,
  schema: S,
): Promise<Result<Value<S>>> {
  const response = await getResponse(transport, path);
  return response.ok ? readBody(response.value, path, schema) : response;
}
