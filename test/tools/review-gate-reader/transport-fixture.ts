import type {
  Transport,
  TransportResponse,
} from "../../../tools/ci/review-gate-reader/transport.ts";

export const origin = "https://api.github.test";
type Responder = (path: string, call: number) => TransportResponse;

export function fakeTransport(
  responses: Readonly<Record<string, TransportResponse>> | Responder,
  throwOn?: number,
) {
  const calls: { method: "GET"; path: string; argc: number }[] = [];
  const transport: Transport = {
    origin,
    get(...args: [path: string]) {
      const [path] = args;
      calls.push({ method: "GET", path, argc: args.length });
      if (calls.length === throwOn)
        throw new Error("ghp_test_token in message");
      const response =
        typeof responses === "function"
          ? responses(path, calls.length)
          : responses[path];
      if (!response) throw new Error("Unexpected fixture path");
      return Promise.resolve(response);
    },
  };
  return { transport, calls };
}

export const response = (
  body: string,
  status = 200,
  headers: TransportResponse["headers"] = {},
): TransportResponse => ({ status, headers, body });
