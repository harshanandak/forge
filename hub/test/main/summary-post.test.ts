import { expect, mock, test } from "bun:test";
import type { MainServices } from "../../src/main.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { mainFixture, timeout } from "./main-fixture.ts";

for (const [outcome, exitCode, message] of [
  ["success", 0, ""],
  ["refused", 1, "refused\n"],
  ["unknown", 1, "unknown: check the channel before running again\n"],
  ["off", 1, "BLOCK_DISABLED: slack\n"],
] as const) {
  test(
    "MN5 summary post handles " + outcome + " without starting the service",
    async () => {
      const f = mainFixture();
      const chat = new FakeChatPort();
      if (outcome === "refused" || outcome === "unknown")
        chat.nextWrite = { kind: outcome, reason: "not_in_channel" };
      const createChatPort = mock<MainServices["createChatPort"]>(() =>
        Promise.resolve(chat),
      );
      const loadConfig = mock(() =>
        outcome === "off"
          ? { ...f.config, slack: { mode: "off" as const, buttons: false } }
          : f.config,
      );
      const g = mainFixture({ loadConfig, createChatPort });

      expect(await g.run(["summary", "post", "--project", "P1"])).toBe(
        exitCode,
      );
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(createChatPort).toHaveBeenCalledTimes(outcome === "off" ? 0 : 1);
      expect(chat.calls.map((call) => call.name)).toEqual(
        outcome === "off" ? [] : ["postSummary"],
      );
      expect(g.calls).toEqual([]);
      expect(g.stderr).toEqual(message ? [message] : []);
      expect(g.stdout).toEqual(
        outcome === "success"
          ? [
              JSON.stringify({
                channelId: "C2",
                chatThreadId: "C2",
                chatMessageId: "message-1",
              }) + "\n",
            ]
          : [],
      );
    },
    timeout,
  );
}
