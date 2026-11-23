import type { SlackAdapterConfig } from "@chat-adapter/slack";
import type { Logger } from "chat";
import type { HubLog } from "../contract/runtime.ts";

type WebClientOptions = NonNullable<SlackAdapterConfig["webClientOptions"]>;
type WebClientLogger = NonNullable<WebClientOptions["logger"]>;
type WebClientLevel = ReturnType<WebClientLogger["getLevel"]>;
type Level = "info" | "warn" | "error";

function safeCount(value: unknown): number | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    "count" in value &&
    Object.hasOwn(value, "count") &&
    typeof value.count === "number" &&
    value.count >= 0 &&
    Number.isSafeInteger(value.count)
  )
    return value.count;
  return undefined;
}

export function createChatLogger(log: HubLog): Logger & WebClientLogger {
  function logger(): Logger & WebClientLogger {
    let level = "info" as WebClientLevel;
    function write(severity: Level, fields: unknown) {
      const count = safeCount(fields);
      log[severity](
        `chat.${severity}`,
        count === undefined ? undefined : { count },
      );
    }
    return {
      child: logger,
      debug: () => undefined,
      info: (_message: unknown, fields?: unknown) => write("info", fields),
      warn: (_message: unknown, fields?: unknown) => write("warn", fields),
      error: (_message: unknown, fields?: unknown) => write("error", fields),
      getLevel: () => level,
      setLevel(next) {
        level = next;
      },
      setName: () => undefined,
    };
  }
  return logger();
}
