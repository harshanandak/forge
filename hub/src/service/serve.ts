import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatPort } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { HubConfig, HubLog, RemoteHandler } from "../contract/runtime.ts";
import { createHubHttpListener } from "./routes.ts";

export const HEADER_FIELD_LIMIT = 1_000;
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface HubServiceDeps {
  readonly config: HubConfig;
  readonly core: Pick<HubCore, "start">;
  readonly chat?: Pick<ChatPort, "handleWebhook">;
  readonly remote?: Pick<RemoteHandler, "handle">;
  readonly log: HubLog;
}

function closed(input: IncomingMessage, output: ServerResponse): Promise<void> {
  if (input.closed || output.closed) return Promise.resolve();
  return new Promise((resolve) => {
    input.once("close", resolve);
    output.once("close", resolve);
  });
}

type Handle = (request: Request) => Promise<Response>;

function tracked(handle: Handle, running: Set<Promise<void>>): Handle {
  return (request) => {
    const result = handle(request);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    running.add(settled);
    void settled.then(() => running.delete(settled));
    return result;
  };
}

export async function serveHub(deps: HubServiceDeps): Promise<void> {
  const stop = Promise.withResolvers<void>();
  const onSignal = () => stop.resolve();
  for (const signal of STOP_SIGNALS) process.once(signal, onSignal);
  const active = new Map<ServerResponse, IncomingMessage>();
  const running = new Set<Promise<void>>();
  const { chat, remote } = deps;
  const listener = createHubHttpListener({
    ...deps,
    ...(chat && {
      chat: {
        handleWebhook: tracked(
          (request) => chat.handleWebhook(request),
          running,
        ),
      },
    }),
    ...(remote && {
      remote: {
        handle: tracked((request) => remote.handle(request), running),
      },
    }),
  });
  const server = createServer({ requireHostHeader: false }, (input, output) => {
    active.set(output, input);
    output.once("close", () => active.delete(output));
    listener(input, output);
  });
  Object.defineProperty(server, "maxHeadersCount", {
    value: HEADER_FIELD_LIMIT,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  const failed = new Promise<never>((_, reject) => server.on("error", reject));
  failed.catch(() => undefined);
  try {
    await deps.core.start();
    server.listen(deps.config.listen.port, deps.config.listen.host);
    await Promise.race([once(server, "listening"), failed]);
    await Promise.race([stop.promise, failed]);
    server.close();
    const aborted = [...active].map(([output, input]) => closed(input, output));
    server.closeAllConnections();
    await Promise.all(aborted);
    await Promise.all(running);
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    if (server.listening) {
      server.close();
      server.closeAllConnections();
    }
  }
}
