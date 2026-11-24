import { expect, test } from "bun:test";
import { channel } from "../fakes/fake-slack-server.ts";
import { slackCases, failure, ref, rootTs } from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);

startedCase(
  "RC1 RC2 calls reactions.add with the raw ref and accepts already_reacted",
  async (h) => {
    await h.chat.react(ref, "eyes");
    h.fake.script("reactions.add", {
      result: { ok: false, error: "already_reacted" },
    });
    await h.chat.react(ref, "eyes");
    const reaction = { channel, timestamp: rootTs, name: "eyes" };
    expect(h.fake.only("reactions.add")).toEqual([reaction, reaction]);
  },
);

for (const code of [
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "restricted_action",
  "message_not_found",
]) {
  startedCase(
    `RC3 the reaction refusal preserves the allowed reason for ${code}`,
    async (h) => {
      h.fake.script("reactions.add", { result: { ok: false, error: code } });
      const rejected = await failure(() => h.chat.react(ref, "eyes"));
      expect(rejected.effect).toBe("refused");
      expect<unknown>(rejected.reason).toBe(
        code === "message_not_found" ? undefined : code,
      );
      expect(h.fake.only("reactions.add")).toHaveLength(1);
    },
  );
}

startedCase(
  "RC4 invalid reaction names are refused before a Slack call",
  async (h) => {
    h.fake.calls.length = 0;
    for (const label of ["<!channel>", ":eyes:", "", "x".repeat(51)]) {
      const rejected = await failure(() => h.chat.react(ref, label));
      expect(rejected.effect).toBe("refused");
      expect(rejected.reason).toBeUndefined();
    }
    expect(h.fake.calls).toEqual([]);
  },
);
