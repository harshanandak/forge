import {
  isJsonContentType,
  readRequestBody,
} from "@modelcontextprotocol/server";
import { Ajv } from "@modelcontextprotocol/server/validators/ajv";
import type { HostCaller } from "../contract/core.ts";
import {
  HOOK_INPUT_SCHEMAS,
  type HookModeInput,
  type HookSessionInput,
  type HookStopInput,
} from "../contract/hooks.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { RemoteDeps } from "../contract/runtime.ts";
import { hookResponse, operation, refusal, type Call } from "./responses.ts";

type Route = keyof typeof HOOK_INPUT_SCHEMAS;
const hookOp = (route: Route) => `hub.hook-${route}` as const;
export function hookHandler({ core, log }: RemoteDeps) {
  const ajv = new Ajv();
  function endpoint<I, O>(route: Route, run: Call<HostCaller, I, O>) {
    const check = ajv.compile<I>(HOOK_INPUT_SCHEMAS[route]);
    return operation(log, hookOp(route), check, run);
  }
  const routes = {
    mode: endpoint("mode", (host, input: HookModeInput) =>
      core.hookMode(host, input),
    ),
    session: endpoint("session", (host, input: HookSessionInput) =>
      core.hookSession(host, input),
    ),
    stop: endpoint("stop", (host, input: HookStopInput) =>
      core.hookStop(host, input),
    ),
  };
  return async (route: Route, request: Request, host: HostCaller) => {
    const op = hookOp(route);
    if (request.method !== "POST") return refusal(405, "INPUT_INVALID", op);
    const media = request.headers.get("content-type") ?? "";
    if (!isJsonContentType(media)) return refusal(415, "INPUT_INVALID", op);
    let value: unknown;
    try {
      const read = await readRequestBody(request, LIMITS.bodyBytes);
      if (read.tooLarge) return refusal(413, "INPUT_INVALID", op);
      value = JSON.parse(read.text);
    } catch {
      return refusal(400, "INPUT_INVALID", op);
    }
    return hookResponse(await routes[route](host, value, request.signal));
  };
}
