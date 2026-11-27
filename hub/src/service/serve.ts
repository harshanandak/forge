import { once } from "node:events";
import { createServer } from "node:http";
import type { ChatPort } from "../contract/chat.ts";
import type { HubCore } from "../contract/core.ts";
import type { HubConfig, HubLog, RemoteHandler } from "../contract/runtime.ts";
import { createHubHttpListener } from "./routes.ts";

export const HEADER_FIELD_LIMIT = 1_000;

export interface HubServiceDeps {
  readonly config: HubConfig;
  readonly core: Pick<HubCore, "start">;
  readonly chat?: Pick<ChatPort, "handleWebhook">;
  readonly remote?: Pick<RemoteHandler, "handle">;
  readonly log: HubLog;
  readonly stop: AbortSignal;
}

export async function serveHub(deps: HubServiceDeps): Promise<void> {
  await deps.core.start();
  if (deps.stop.aborted) return;
  const stopped = once(deps.stop, "abort");
  const shutdown = new AbortController();
  const serve = createHubHttpListener({ ...deps, shutdown: shutdown.signal });
  const running = new Set<Promise<void>>();
  const server = createServer({ requireHostHeader: false }, (input, output) => {
    const done = serve(input, output);
    running.add(done);
    void done.finally(() => running.delete(done));
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
    server.listen(deps.config.listen.port, deps.config.listen.host);
    await Promise.race([once(server, "listening"), stopped, failed]);
    await Promise.race([stopped, failed]);
  } finally {
    const closed = once(server, "close");
    server.close();
    shutdown.abort();
    server.closeAllConnections();
    await Promise.allSettled([closed, ...running]);
  }
}
