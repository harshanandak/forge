import { expect } from "bun:test";
import { ChatWriteFailure, type ChatPort } from "../../src/contract/chat.ts";
import { asha, channel } from "../fakes/fake-slack-server.ts";
import { ask, summary } from "./fixtures.ts";

export async function checkChatPort(
  port: ChatPort,
  fixture = {
    userId: asha,
    channelId: channel,
    ephemeral: true,
    reactions: true,
    summaryLookup: "found" as "found" | "unknown",
  },
) {
  const posted = port.postAskDm(fixture.userId, ask);
  await expect(posted).resolves.toHaveProperty("chatMessageId");
  const dm = await posted;
  expect(dm.channelId).toBeTruthy();
  expect(dm.chatMessageId).toBeTruthy();
  expect(dm.chatThreadId).toBeTruthy();
  await port.editAskDm(dm, { ...ask, state: { kind: "expired" } });
  const ephemeral = port.postEphemeral(dm, fixture.userId, "Private fixture");
  if (fixture.ephemeral) await ephemeral;
  else await expect(ephemeral).rejects.toBeInstanceOf(ChatWriteFailure);
  const message = await port.postText(
    { kind: "channel", channelId: fixture.channelId },
    "Topic",
  );
  expect(message.channelId).toBe(fixture.channelId);
  const reply = await port.postText(
    { kind: "thread", chatThreadId: message.chatThreadId },
    "Reply",
  );
  expect(reply.chatThreadId).toBe(message.chatThreadId);
  const reaction = port.react(message, "eyes");
  if (fixture.reactions) await reaction;
  else await expect(reaction).rejects.toBeInstanceOf(ChatWriteFailure);
  const publicationKey = "sum_contract";
  const stored = await port.postSummary(
    fixture.channelId,
    summary,
    publicationKey,
  );
  expect(stored.channelId).toBe(fixture.channelId);
  expect(await port.findSummary(fixture.channelId, publicationKey)).toEqual(
    fixture.summaryLookup === "found"
      ? { kind: "found", ref: stored }
      : { kind: "unknown" },
  );
  expect(await port.editSummary(stored, { ...summary, revision: 1 })).toBe(
    "edited",
  );
}
