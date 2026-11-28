import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { ServerWebSocket } from "bun";

export const team = "T0TEAM";
export const botUser = "U0BOT";
export const botId = "B0FORGE";
export const appId = "A0FORGE";
export const asha = "U0ASHA";
export const ravi = "U0RAVI";
export const ashaDm = "D0ASHA";
export const raviDm = "D0RAVI";
export const channel = "C0PROJ1";

type Body = Record<string, unknown>;
export type Script = {
  readonly result?: Body;
  readonly retryAfter?: string;
  readonly status?: number;
  readonly delayMs?: number;
  readonly cutOff?: boolean;
  readonly until?: Promise<void>;
  readonly started?: () => void;
};

export type ApiCall = {
  readonly method: string;
  readonly body: Body;
};

const baseTs = 1_800_000_000;
const loopback = "127.0.0.1";
const booleanFields = new Set([
  "as_user",
  "unfurl_links",
  "unfurl_media",
  "inclusive",
]);

function object(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error("expected request bytes");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (request.headers["content-type"]?.includes("application/json")) {
    const body: unknown = JSON.parse(text);
    if (!object(body)) throw new Error("expected request object");
    return body;
  }
  const fields = new URLSearchParams(text);
  if (
    fields.get("text") === "Agent text" &&
    !text.split("&").includes("text=Agent%20text")
  )
    throw new Error("fixture request changed the serialized text encoding");
  const output: Body = {};
  for (const [key, value] of fields) {
    if (key === "blocks") {
      const parsed: unknown = JSON.parse(value);
      output[key] = parsed;
    } else if (booleanFields.has(key)) {
      output[key] = value === "true";
    } else {
      output[key] = key === "limit" ? Number(value) : value;
    }
  }
  return output;
}

function reply(response: ServerResponse, status: number, body: Body): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function address(server: ReturnType<typeof createServer>): number {
  const result = server.address();
  if (!result || typeof result === "string")
    throw new Error("missing HTTP port");
  return result.port;
}

export async function within<T>(
  pending: Promise<T>,
  milliseconds = 3_000,
  message = "Slack fixture did not receive the awaited event",
): Promise<T> {
  const failure = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => failure.reject(new Error(message)),
    milliseconds,
  );
  try {
    return await Promise.race([pending, failure.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function socketEndpoint() {
  const ready = Promise.withResolvers<ServerWebSocket<undefined>>();
  const acknowledgements = new Map<string, (value: Body) => void>();
  let sequence = 0;
  const server = Bun.serve<undefined>({
    hostname: loopback,
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request, { data: undefined })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(peer) {
        peer.send(JSON.stringify({ type: "hello" }));
        ready.resolve(peer);
      },
      ping(peer, data) {
        peer.pong(data);
      },
      message(_peer, data) {
        const ack: unknown = JSON.parse(data.toString());
        if (object(ack) && typeof ack.envelope_id === "string") {
          acknowledgements.get(ack.envelope_id)?.(ack);
        }
      },
    },
  });
  return {
    url: `ws://${loopback}:${server.port}/socket`,
    async send(
      type: "events_api" | "interactive",
      payload: Body,
      retryAttempt = 0,
    ) {
      const peer = await within(ready.promise);
      const envelopeId = `envelope-${++sequence}`;
      const ack = Promise.withResolvers<Body>();
      acknowledgements.set(envelopeId, ack.resolve);
      try {
        peer.send(
          JSON.stringify({
            envelope_id: envelopeId,
            type,
            payload,
            retry_attempt: retryAttempt,
            accepts_response_payload: false,
          }),
        );
        return await within(ack.promise);
      } finally {
        acknowledgements.delete(envelopeId);
      }
    },
    close: () => server.stop(true),
  };
}

export async function fakeSlackServer(socketMode = false) {
  const calls: ApiCall[] = [];
  const unexpected: string[] = [];
  const scripts = new Map<string, Script[]>();
  const messages = new Map<string, Body[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let sequence = 0;
  const socket = socketMode ? socketEndpoint() : undefined;
  const ok = (value: Body = {}) => ({ ok: true, ...value });

  function defaultResult(method: string, body: Body): Body | undefined {
    const target = typeof body.channel === "string" ? body.channel : channel;
    const history = messages.get(target) ?? [];
    switch (method) {
      case "auth.test":
        return ok({
          team_id: team,
          user_id: botUser,
          bot_id: botId,
          app_id: appId,
        });
      case "apps.connections.open":
        return socket ? ok({ url: socket.url }) : undefined;
      case "users.info": {
        const id = body.user;
        const name = id === asha ? "asha" : id === ravi ? "ravi" : "forge";
        return ok({
          user: { id, name, real_name: name, is_bot: id === botUser },
        });
      }
      case "conversations.info":
        return ok({
          channel: {
            id: target,
            name: "project",
            is_member: true,
            is_im: target.startsWith("D"),
          },
        });
      case "conversations.open":
        return ok({ channel: { id: body.users === ravi ? raviDm : ashaDm } });
      case "conversations.history":
        return ok({
          messages: history.toReversed(),
          has_more: false,
          response_metadata: { next_cursor: "" },
        });
      case "conversations.replies": {
        const matches = (m: Body) =>
          m.ts === body.ts || m.thread_ts === body.ts;
        return ok({ messages: history.filter(matches) });
      }
      case "chat.postMessage": {
        const ts = `${baseTs}.${String(++sequence).padStart(6, "0")}`;
        const message = {
          ...body,
          type: "message",
          user: botUser,
          bot_id: botId,
          app_id: appId,
          ts,
        };
        history.push(message);
        messages.set(target, history);
        return ok({ channel: target, ts, message });
      }
      case "chat.update": {
        const message = history.find((item) => item.ts === body.ts);
        if (!message) return { ok: false, error: "message_not_found" };
        Object.assign(message, body);
        return ok({ channel: target, ts: body.ts, message });
      }
      case "chat.postEphemeral":
        return ok({ message_ts: `${baseTs}.999999` });
      case "reactions.add":
        return ok();
      default:
        return undefined;
    }
  }

  async function answer(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${loopback}`);
    const method = url.pathname.replace(/^\/api\//, "");
    const body = await requestBody(request);
    const credential =
      request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (
      !credential ||
      Object.hasOwn(body, "token") ||
      JSON.stringify(body).includes(credential) ||
      decodeURIComponent(url.href).includes(credential) ||
      url.searchParams.has("token")
    )
      throw new Error("invalid credential placement in fixture request");
    calls.push({ method, body });
    const script = scripts.get(method)?.shift();
    script?.started?.();
    if (script?.until) await script.until;
    if (script?.delayMs !== undefined) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        reply(response, 200, script.result ?? ok());
      }, script.delayMs);
      timers.add(timer);
      return;
    }
    if (script?.cutOff) {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": 100,
      });
      response.write('{"ok":', () => response.socket?.destroy());
      return;
    }
    const status = script?.status ?? 200;
    if (script?.retryAfter !== undefined)
      response.setHeader("Retry-After", script.retryAfter);
    const result =
      script?.result ??
      (script?.status === undefined
        ? defaultResult(method, body)
        : { ok: false });
    if (result) {
      reply(response, status, result);
    } else {
      unexpected.push(method);
      reply(response, 500, { ok: false, error: "unexpected_method" });
    }
  }

  const server = createServer((request, response) => {
    void answer(request, response).catch(() => {
      unexpected.push("malformed_fixture_request");
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, resolve);
  });
  async function close() {
    for (const timer of timers) clearTimeout(timer);
    await socket?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  const url = `http://${loopback}:${address(server)}/api/`;
  return {
    url,
    calls,
    unexpected,
    socket,
    script(method: string, ...responses: Script[]) {
      scripts.set(method, responses);
    },
    only(method: string) {
      return calls
        .filter((call) => call.method === method)
        .map((call) => call.body);
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
