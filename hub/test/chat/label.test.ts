import { expect, test } from "bun:test";
import { channel } from "../fakes/fake-slack-server.ts";
import { slackCases, rootTs, threadTarget } from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);

startedCase(
  "AL1 labeled posts send a username and rendered blocks with the ordinary unfurl settings",
  async (h) => {
    const text = "Ravi's agent: hello";
    const label = "Forge (Ravi's agent)";
    const labeled = await h.chat.postText(threadTarget, text, {
      agentLabel: label,
    });
    const plain = await h.chat.postText(threadTarget, text);
    expect(labeled.chatThreadId).toBe(plain.chatThreadId);
    const [first, second] = h.fake.only("chat.postMessage");
    expect(first).toMatchObject({
      channel,
      thread_ts: rootTs,
      username: label,
      as_user: false,
      text,
    });
    expect(Array.isArray(first?.blocks)).toBe(true);
    expect(second).toMatchObject({
      channel,
      thread_ts: rootTs,
      text,
      blocks: first?.blocks,
    });
    expect(second).not.toHaveProperty("username");
    for (const key of ["unfurl_links", "unfurl_media"])
      expect(first?.[key]).toBe(second?.[key]);
  },
);

for (const label of ["<!channel>", "x".repeat(400), "Forge\nagent\u0001"]) {
  startedCase(
    `AL2 control characters and mentions cannot escape the display label (${label.length})`,
    async (h) => {
      await h.chat.postText(threadTarget, "unchanged text", {
        agentLabel: label,
      });
      const body = h.fake.only("chat.postMessage")[0];
      expect(body?.text).toBe("unchanged text");
      const username = body?.username;
      expect(typeof username).toBe("string");
      if (typeof username !== "string")
        throw new Error("expected sanitized label");
      expect([...username].length).toBeLessThanOrEqual(80);
      expect(username).not.toContain("<!");
      expect(username).not.toContain("\n");
      expect(username).not.toContain("\u0001");
      expect(h.actions).toEqual([]);
      expect(h.messages).toEqual([]);
    },
  );
}
