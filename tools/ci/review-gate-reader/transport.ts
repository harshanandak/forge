import { fail, ok } from "./result.ts";
import { parseStrictJson, type Shape } from "./strict-json.ts";

export type Transport = {
  readonly origin: string;
  get(path: string): Promise<TransportResponse>;
};

export type TransportResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
};

export async function getResponse(transport: Transport, path: string) {
  let response: TransportResponse;
  try {
    response = await transport.get(path);
  } catch {
    return fail("network_error", path);
  }
  const { status, headers } = response;
  if (status === 200) return ok(response);
  const limited =
    status === 429 ||
    (status === 403 && headers["x-ratelimit-remaining"] === "0");
  return fail(limited ? "api_rate_limited" : "http_status", path);
}

export async function getJson<S extends Shape>(
  transport: Transport,
  path: string,
  schema: S,
) {
  const response = await getResponse(transport, path);
  return response.ok
    ? parseStrictJson(response.value.body, schema, `${path}#`)
    : response;
}
