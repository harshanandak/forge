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

export async function serveHub(deps: HubServiceDeps): Promise<void> {
  const stop = Promise.withResolvers<void>();
  const onSignal = () => stop.resolve();
  for (const signal of STOP_SIGNALS) process.once(signal, onSignal);
  const active = new Map<ServerResponse, IncomingMessage>();
  const listener = createHubHttpListener(deps);
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
  try {
    await deps.core.start();
    server.listen(deps.config.listen.port, deps.config.listen.host);
    await once(server, "listening");
    await stop.promise;
    server.close();
    const aborted = [...active].map(([output, input]) => closed(input, output));
    server.closeAllConnections();
    await Promise.all(aborted);
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    if (server.listening) {
      server.close();
      server.closeAllConnections();
    }
  }
}
