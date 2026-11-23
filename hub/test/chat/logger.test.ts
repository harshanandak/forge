import { expect, test } from "bun:test";
import { createChatLogger } from "../../src/chat/logger.ts";
import type { HubLog, LogFields } from "../../src/contract/runtime.ts";

const timeout = 30_000;

test(
  "L1 SDK and WebClient logger shapes emit fixed events and discard payloads",
  () => {
    const entries: Array<{ event: string; fields?: LogFields }> = [];
    const record: HubLog["info"] = (event, fields) =>
      entries.push(fields ? { event, fields } : { event });
    const log = { info: record, warn: record, error: record } satisfies HubLog;
    const synthetic = ["xo", "xb", "-", "sample-fixture"].join("");
    const payload = {
      count: 2,
      teamId: "T0PRIVATE",
      channelId: "C0PRIVATE",
      userId: "U0PRIVATE",
      message: "private ask text",
      token: synthetic,
    };

    const logger = createChatLogger(log);
    logger.info("SDK message", payload, { count: 99 });
    logger.warn("Another SDK message", { ...payload, count: "2" });
    logger.debug("Ignored debug message", payload);
    expect(entries).toEqual([
      { event: "chat.info", fields: { count: 2 } },
      { event: "chat.warn" },
    ]);
    const result = JSON.stringify(entries);
    for (const value of [
      synthetic,
      "SDK message",
      payload.teamId,
      payload.channelId,
      payload.userId,
      payload.message,
    ]) {
      expect(result).not.toContain(value);
    }
  },
  timeout,
);

test(
  "L2 logger drops errors and extra arguments and maps unlisted child scope to other",
  () => {
    const entries: Array<{ event: string; fields?: LogFields }> = [];
    const record: HubLog["info"] = (event, fields) =>
      entries.push(fields ? { event, fields } : { event });
    const log = { info: record, warn: record, error: record } satisfies HubLog;
    const synthetic = ["xo", "xb", "-", "sample-fixture"].join("");
    const error = new Error(
      `authorization: Bearer ${synthetic} https://example.test/secret private body`,
    );
    const logger = createChatLogger(log);
    logger.error("SDK error", error, { count: 3 });
    logger.debug("Any debug entry", error);
    logger.child("unknown-name").warn("child error", error);
    logger.setName(synthetic);
    logger.setLevel(logger.getLevel());
    logger.error(error);

    expect(entries).toEqual([
      { event: "chat.error" },
      { event: "chat.warn", fields: { scope: "other" } },
      { event: "chat.error" },
    ]);
  },
  timeout,
);
