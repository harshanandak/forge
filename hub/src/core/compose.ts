import type { CreateHubCore } from "../contract/runtime.ts";
import { recoverAgentPosts } from "./agent-posts.ts";
import { createCli } from "./cli.ts";
import { createCoreBase, createCoreContext } from "./core.ts";
import { createEffectWorker } from "./effects.ts";
import { createReport } from "./report.ts";
import { createStop } from "./stop.ts";

export const createHubCore: CreateHubCore = (deps) => {
  const ctx = createCoreContext(deps, false);
  const { chat } = ctx;
  const worker = createEffectWorker(ctx);
  let running = false;
  let closed = false;
  let chatAttempted = false;
  let chatStartup: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stopStarting = Promise.withResolvers<void>();

  function drainEffects(): Promise<void> {
    return running && !closed ? worker.drain() : Promise.resolve();
  }

  const base = createCoreBase(ctx, {
    kickEffects() {
      void drainEffects().catch(() => deps.log.warn("effect_drain_failed"));
    },
  });

  function stopResources(): Promise<void> {
    return (cleanup ??= Promise.resolve().then(async () => {
      try {
        if (chatAttempted) await chat?.stop();
      } finally {
        await worker.close();
      }
    }));
  }

  function start(): Promise<void> {
    if (closed) return Promise.reject(new Error("Hub core is closed"));
    return (startup ??= Promise.resolve()
      .then(async () => {
        if (closed) return;
        if (deps.config.chat?.adapter === "telegram")
          throw new Error("Telegram is unavailable for the hub service");
        worker.prepare();
        if (chat) {
          recoverAgentPosts(ctx);
          chatStartup = Promise.resolve().then(() => {
            if (closed) return;
            chatAttempted = true;
            return chat.start(base.chatHandlers);
          });
          await chatStartup;
        }
        if (closed) return;
        await Promise.race([worker.start(), stopStarting.promise]);
        if (!closed) running = true;
      })
      .catch(async (error: unknown) => {
        closed = true;
        try {
          await stopResources();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Hub startup and cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      }));
  }

  function close(): Promise<void> {
    closed = true;
    stopStarting.resolve();
    return (closing ??= Promise.resolve(chatStartup)
      .catch(() => undefined)
      .then(stopResources));
  }

  return {
    ...base,
    ...createCli(ctx),
    report: createReport(ctx, { ...worker, drain: drainEffects }),
    hookStop: createStop(ctx, base.reply),
    start,
    close,
  };
};
