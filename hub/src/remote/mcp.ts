import {
  createMcpHandler,
  ProtocolError,
  Server,
} from "@modelcontextprotocol/server";
import { Ajv } from "@modelcontextprotocol/server/validators/ajv";
import type { Caller, HubCore } from "../contract/core.ts";
import {
  ASK_DELIVERY_PENDING,
  LIMITS,
  MCP_SERVER_NAME,
  SEND_POST_FAILED,
  TOOL_INPUT_SCHEMAS,
  enabledToolNames,
  type HubWarning,
  type McpToolName,
} from "../contract/mcp.ts";
import type { RemoteDeps } from "../contract/runtime.ts";
import { operation, type Call } from "./responses.ts";

function fields(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function isCaller(value: unknown): value is Caller {
  const caller = fields(value);
  const person = fields(caller?.person);
  return (
    typeof caller?.tokenId === "string" &&
    typeof person?.personId === "string" &&
    typeof person.displayName === "string" &&
    (!("slackUserId" in person) || typeof person.slackUserId === "string")
  );
}

type Input<N extends McpToolName> = Parameters<HubCore[N]>[1];
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type InputSchema = Mutable<(typeof TOOL_INPUT_SCHEMAS)[McpToolName]>;

export function mcpHandler(
  { config, core, log }: RemoteDeps,
  make = createMcpHandler,
) {
  const ajv = new Ajv({ allErrors: true });
  const tool = <N extends McpToolName, R>(
    name: N,
    run: Call<Caller, Input<N>, R>,
    warns?: (value: R, input: Input<N>) => HubWarning[] | undefined,
  ) => {
    const validate = ajv.compile<Input<N>>(TOOL_INPUT_SCHEMAS[name]);
    return operation(log, `hub.${name}`, validate, run, warns);
  };
  const tools = {
    hello: tool("hello", (c, value) => core.hello(c, value)),
    inbox: tool("inbox", (c, value) => core.inbox(c, value)),
    reply: tool("reply", (c, value) => core.reply(c, value)),
    report: tool("report", (c, value) => core.report(c, value)),
    ask: tool(
      "ask",
      (c, value) => core.ask(c, value),
      (value) => (value.pendingTo.length ? [ASK_DELIVERY_PENDING] : undefined),
    ),
    wait: tool("wait", (c, value, signal) => {
      const cap = AbortSignal.timeout(
        (value.timeoutMs ?? LIMITS.waitDefaultMs) + 2000,
      );
      return core.wait(c, value, AbortSignal.any([signal, cap]));
    }),
    send: tool(
      "send",
      (c, value) => core.send(c, value),
      (value, input) =>
        value.threadPost === "failed" && input.conversationId
          ? [SEND_POST_FAILED]
          : undefined,
    ),
  };
  const names = enabledToolNames(config.slack.mode !== "off");
  const isTool = (name: string): name is McpToolName =>
    Object.hasOwn(tools, name);
  return make(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller;
      if (!isCaller(caller))
        throw new ProtocolError(-32603, "Missing authenticated caller");
      const server = new Server(
        { name: MCP_SERVER_NAME, version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/list", () => ({
        tools: names.map((name) => ({
          name,
          inputSchema: structuredClone(TOOL_INPUT_SCHEMAS[name]) as InputSchema,
          annotations: { readOnlyHint: false, destructiveHint: false },
        })),
      }));
      server.setRequestHandler("tools/call", async ({ params }, ctx) => {
        const { name, arguments: value } = params;
        if (!isTool(name)) throw new ProtocolError(-32602, "Unknown tool");
        const result = await tools[name](
          caller,
          value ?? {},
          ctx.mcpReq.signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: !result.ok,
        };
      });
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "json",
      maxRequestBodySize: LIMITS.bodyBytes,
      onerror: () => undefined,
    },
  );
}
