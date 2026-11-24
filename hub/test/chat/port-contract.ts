import { expect } from "bun:test";
import type { ChatPort } from "../../src/contract/chat.ts";
import { asha, channel } from "../fakes/fake-slack-server.ts";
import { ask, summary } from "./fixtures.ts";

export async function checkChatPort(port: ChatPort) {
  const dm = await port.postAskDm(asha, ask);
  expect(dm.channelId).toBeTruthy();
  expect(dm.chatMessageId).toBeTruthy();
  expect(dm.chatThreadId).toBeTruthy();
  await port.editAskDm(dm, { ...ask, state: { kind: "expired" } });
  await port.postEphemeral(dm, asha, "Private fixture");
  const message = await port.postText(
    { kind: "channel", channelId: channel },
    "Topic",
  );
  expect(message.channelId).toBe(channel);
  const reply = await port.postText(
    { kind: "thread", chatThreadId: message.chatThreadId },
    "Reply",
  );
  expect(reply.chatThreadId).toBe(message.chatThreadId);
  await port.react(message, "eyes");
  const publicationKey = "sum_contract";
  const stored = await port.postSummary(channel, summary, publicationKey);
  expect(stored.channelId).toBe(channel);
  expect(await port.findSummary(channel, publicationKey)).toEqual({
    kind: "found",
    ref: stored,
  });
  expect(await port.editSummary(stored, { ...summary, revision: 1 })).toBe(
    "edited",
  );
}
