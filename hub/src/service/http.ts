import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { LIMITS } from "../contract/mcp.ts";
import type { HubConfig, HubLog } from "../contract/runtime.ts";

type Route = { target: string; handle(request: Request): Promise<Response> };
type MatchRoute = (target: string) => Route | undefined;
const DEFAULT_HEADER_FIELDS = 1_000;

function allowedHost(
  input: IncomingMessage,
  hosts: HubConfig["allowedHosts"],
): string | undefined {
  const server = "server" in input.socket ? input.socket.server : null;
  const fields =
    server && typeof server === "object" && "maxHeadersCount" in server
      ? server.maxHeadersCount
      : null;
  const cutoff =
    (typeof fields === "number" ? fields : DEFAULT_HEADER_FIELDS) << 1;
  if (cutoff > 0 && input.rawHeaders.length >= cutoff) return;
  let host: string | undefined;
  for (let index = 0; index < input.rawHeaders.length; index += 2) {
    if (input.rawHeaders[index]?.toLowerCase() !== "host") continue;
    if (host !== undefined) return;
    host = input.rawHeaders[index + 1]?.toLowerCase();
  }
  return host && hosts.includes(host) ? host : undefined;
}

function validTarget(target: string): boolean {
  if (
    !/^\/(?!\/)[a-z0-9._~!$&'()*+,;=:@/?%-]*$/i.test(target) ||
    /%(?![a-f0-9]{2})/i.test(target)
  )
    return false;
  const path = target.split("?", 1)[0] ?? "";
  return !/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path);
}

function requestHeaders(input: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < input.rawHeaders.length; index += 2) {
    const name = input.rawHeaders[index]?.toLowerCase();
    if (!name || name === "forwarded" || name.startsWith("x-forwarded-"))
      continue;
    headers.append(name, input.rawHeaders[index + 1] ?? "");
  }
  return headers;
}

async function readBody(input: IncomingMessage): Promise<Buffer | undefined> {
  if (Number(input.headers["content-length"]) > LIMITS.bodyBytes) return;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input.iterator({
    destroyOnReturn: false,
  }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > LIMITS.bodyBytes) return;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function reject(output: ServerResponse, status: number): void {
  output.writeHead(status, { connection: "close" }).end();
}

async function writeResponse(
  output: ServerResponse,
  response: Response,
  signal: AbortSignal,
  headersOnly: boolean,
): Promise<void> {
  const body = response.body;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let cancelled: Promise<void> | undefined;
  const cancel = () => {
    cancelled ??= (reader ?? body)?.cancel().catch(() => {});
  };
  try {
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") output.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) output.setHeader("set-cookie", cookies);
    output.writeHead(response.status);
    if (body && !headersOnly) {
      output.flushHeaders();
      reader = body.getReader();
      signal.addEventListener("abort", cancel, { once: true });
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        if (!(value instanceof Uint8Array))
          throw new TypeError("Expected response bytes");
        if (!output.write(value)) await once(output, "drain", { signal });
      }
    }
    if (!signal.aborted) output.end();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
    await cancelled;
  }
}

export function createHttpListener(
  hosts: HubConfig["allowedHosts"],
  matchRoute: MatchRoute,
  log: HubLog,
  shutdown?: AbortSignal,
): (input: IncomingMessage, output: ServerResponse) => Promise<void> {
  return async function serve(input, output) {
    const controller = new AbortController();
    const signal = shutdown
      ? AbortSignal.any([controller.signal, shutdown])
      : controller.signal;
    input.once("close", () => {
      if (!input.complete) controller.abort();
    });
    let finished = false;
    output.once("finish", () => {
      finished = true;
    });
    output.once("close", () => {
      if (!finished) controller.abort();
    });

    try {
      const host = allowedHost(input, hosts);
      if (!host) return reject(output, 403);
      const target = input.url;
      if (!target || !validTarget(target)) return reject(output, 400);
      const route = matchRoute(target);
      if (!route) return reject(output, 404);

      const body = await readBody(input);
      if (signal.aborted) return;
      if (!body) return reject(output, 413);

      let request: Request;
      try {
        request = new Request("http://" + host + route.target, {
          method: input.method ?? "GET",
          headers: requestHeaders(input),
          body: body.length === 0 ? null : new Uint8Array(body),
          signal,
        });
      } catch {
        return reject(output, 400);
      }

      const response = await route.handle(request);
      if (signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      await writeResponse(output, response, signal, request.method === "HEAD");
    } catch {
      if (signal.aborted || (input.destroyed && !input.complete)) return;
      log.error("hub.http.failed");
      if (output.headersSent) output.destroy();
      else {
        for (const name of output.getHeaderNames()) output.removeHeader(name);
        reject(output, 500);
      }
    }
  };
}
