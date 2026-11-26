import { expect, test } from "bun:test";
import type {
  ChatMessageChangeEvent,
  ChatMessageEvent,
} from "../../src/contract/chat.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { asha, channel, team } from "../fakes/fake-slack-server.ts";
import { ask, failure, ref, threadTarget } from "./fixtures.ts";
import { checkChatPort } from "./port-contract.ts";

const timeout = 30_000;

test(
  "K1 the shared chat contract runs on FakeChatPort",
  async () => {
    await checkChatPort(new FakeChatPort());
  },
  timeout,
);

test(
  "K3 the fake distinguishes rejected, delayed and ambiguous writes and records issueId",
  async () => {
    const port = new FakeChatPort();
    port.nextWrite = { kind: "refused" };
    expect(await failure(() => port.postAskDm(asha, ask))).toMatchObject({
      effect: "refused",
    });
    port.nextWrite = { kind: "refused", retryAfterMs: 30_000 };
    expect(await failure(() => port.postAskDm(asha, ask))).toMatchObject({
      effect: "refused",
      retryAfterMs: 30_000,
    });
    expect(port.writes).toEqual([]);
    port.nextWrite = { kind: "unknown" };
    expect(await failure(() => port.postAskDm(asha, ask))).toMatchObject({
      effect: "unknown",
    });
    expect(port.writes).toHaveLength(1);
    const release = Promise.withResolvers<void>();
    let resolved = false;
    port.nextWrite = { kind: "delay", until: release.promise };
    const pending = port
      .postAskDm(asha, { ...ask, issueId: "forge-1901" })
      .then((result) => {
        resolved = true;
        return result;
      });
    try {
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(port.askCards.at(-1)?.issueId).toBe("forge-1901");
    } finally {
      release.resolve();
    }
    expect((await pending).channelId).toBeTruthy();
  },
  timeout,
);

test(
  "K4 the fake exposes probe, reaction, long-answer, change and option controls",
  async () => {
    const port = new FakeChatPort(team);
    const changes: ChatMessageChangeEvent[] = [];
    const messages: ChatMessageEvent[] = [];
    await port.start({
      onAction: () => Promise.resolve({}),
      onMessage(event) {
        messages.push(event);
        return Promise.resolve();
      },
      onMessageChange(event) {
        changes.push(event);
        return Promise.resolve();
      },
    });
    port.memberships.set(channel, true);
    expect(await port.probe([channel, "C0OTHER"])).toEqual({
      teamId: team,
      channels: [
        { channelId: channel, botIsMember: true },
        { channelId: "C0OTHER", botIsMember: false },
      ],
    });
    await port.react(ref, "eyes");
    expect(port.calls.at(-1)).toEqual({ name: "react", args: [ref, "eyes"] });
    expect(port.capabilities.longAnswers).toBe(true);
    expect(await port.createLongAnswer(channel, "Title", "Contents")).toMatch(
      /^https:\/\/example\.test\//,
    );
    expect(port.calls.at(-1)).toEqual({
      name: "createLongAnswer",
      args: [channel, "Title", "Contents"],
    });
    const unavailable = new FakeChatPort(team, { longAnswers: false });
    expect(
      await failure(() =>
        unavailable.createLongAnswer(channel, "Title", "Contents"),
      ),
    ).toMatchObject({ reason: "canvas_unavailable" });
    const changed = {
      ...ref,
      kind: "edited",
      text: "new",
      fileNames: ["plan.pdf"],
    } as const;
    await port.emitMessageChange(changed);
    expect(changes).toEqual([changed]);
    const message = {
      ...ref,
      teamId: team,
      eventKey: "message",
      slackUserId: asha,
      userName: "asha",
      isBot: false,
      text: "hello",
      isDirect: true,
      mentionsBot: false,
      mentionedSlackUserIds: ["U0RAVI"],
      fileNames: ["plan.pdf"],
    };
    await port.emitMessage({ ...message, teamId: "T0OTHER" });
    await port.emitMessage(message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      mentionedSlackUserIds: ["U0RAVI"],
      fileNames: ["plan.pdf"],
    });
    const options = { agentLabel: "Forge (Asha)" };
    await port.postText(threadTarget, "Reply", options);
    expect(port.calls.at(-1)).toEqual({
      name: "postText",
      args: [threadTarget, "Reply", options],
    });
    port.nextWrite = { kind: "refused", reason: "restricted_action" };
    expect(
      await failure(() => port.postText(threadTarget, "Reply")),
    ).toMatchObject({ reason: "restricted_action" });
    await port.stop();
  },
  timeout,
);

test(
  "T1A-CAP1 a polling port satisfies the shared chat contract",
  async () => {
    const port = new FakeChatPort(team, { mode: "polling" });
    expect(port.capabilities.mode).toBe("polling");
    await checkChatPort(port);
  },
  timeout,
);
