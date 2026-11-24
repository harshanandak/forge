import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { SUMMARY_KEY_MARKER } from "../../src/contract/chat.ts";
import { WORK_REQUEST_CHOICES } from "../../src/contract/domain.ts";
import {
  asha,
  ashaDm,
  channel,
  ravi,
  raviDm,
} from "../fakes/fake-slack-server.ts";
import {
  slackCases,
  subscribed,
  ask,
  callback,
  dm,
  failure,
  ref,
  summary,
  threadTarget,
  waitFor,
} from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);
const choiceButtons = (body: Record<string, unknown> | undefined) => {
  const blocks: unknown = body?.blocks;
  if (!Array.isArray(blocks)) throw new Error("expected Slack Blocks");
  const items: unknown[] = blocks;
  const matching = items.filter(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "actions",
  );
  if (matching.length === 0) return [];
  expect(matching).toHaveLength(1);
  const first = matching[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("elements" in first) ||
    !Array.isArray(first.elements)
  )
    throw new Error("expected Slack action elements");
  return first.elements as unknown[];
};

startedCase(
  "O1 O9 sends a choice card to the requested DM with only scoped button fields",
  async (h) => {
    h.fake.calls.length = 0;
    const posted = await h.chat.postAskDm(ravi, ask);
    expect(posted.channelId).toBe(raviDm);
    expect(posted.chatThreadId).toBeTruthy();
    expect(posted.chatMessageId).toBeTruthy();
    expect(h.fake.calls.map(({ method }) => method)).toEqual([
      "conversations.open",
      "chat.postMessage",
    ]);
    const body = h.fake.only("chat.postMessage")[0];
    if (!Array.isArray(body?.blocks)) throw new Error("expected Slack Blocks");
    const blocks: unknown[] = body.blocks;
    const section = blocks.find(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "section",
    );
    expect(JSON.stringify(section)).toContain(ask.question);
    const buttons = choiceButtons(body);
    expect(buttons).toHaveLength(2);
    for (const [i, choice] of ask.choices.entries()) {
      expect(buttons[i]).toMatchObject({
        type: "button",
        action_id: `forge_ask_${choice.id}`,
        value: ask.askId,
        text: { type: "plain_text", text: choice.label },
      });
      for (const key of ["url", "callbackUrl", "actionType", "visibleTo"])
        expect(buttons[i]).not.toHaveProperty(key);
    }
    expect(h.fake.only("chat.postEphemeral")).toEqual([]);
  },
);

for (const requesterName of [undefined, "Ravi"]) {
  startedCase(
    `O2 O3 work request card shows ${requesterName ?? "the requesting agent"} and the three ordered decisions`,
    async (h) => {
      await h.chat.postAskDm(asha, {
        ...ask,
        kind: "work_request",
        issueId: "forge-1901",
        choices: WORK_REQUEST_CHOICES,
        ...(requesterName === undefined ? {} : { requesterName }),
      });
      const body = h.fake.only("chat.postMessage")[0];
      const buttons = choiceButtons(body);
      expect(buttons).toMatchObject([
        {
          action_id: "forge_ask_approve",
          style: "primary",
          value: ask.askId,
          text: { text: "Approve" },
        },
        {
          action_id: "forge_ask_decline",
          style: "danger",
          value: ask.askId,
          text: { text: "Decline" },
        },
        {
          action_id: "forge_ask_clarify",
          value: ask.askId,
          text: { text: "Ask what they mean" },
        },
      ]);
      expect(buttons[2]).not.toHaveProperty("style");
      const text = JSON.stringify(body?.blocks);
      expect(text).toContain("Atlas");
      expect(text).toContain(ask.question);
      const agent =
        "Approve work on Atlas / forge-1901 requested by your agent:";
      if (requesterName === undefined) expect(text).toContain(agent);
      else {
        expect(text).toContain(requesterName);
        expect(text).not.toContain(agent);
      }
    },
  );
}

startedCase(
  "O4 O5 edits each original DM and removes every button for answered and expired cards",
  async (h) => {
    const first = await h.chat.postAskDm(asha, ask);
    const second = await h.chat.postAskDm(ravi, ask);
    h.fake.calls.length = 0;
    const answered = {
      kind: "answered",
      answeredByName: "Asha",
      choiceLabel: "Yes",
      answeredAt: "2026-01-01T10:15:00.000Z",
    } as const;
    await h.chat.editAskDm(first, { ...ask, state: answered });
    await h.chat.editAskDm(second, { ...ask, state: answered });
    await h.chat.editAskDm(first, { ...ask, state: { kind: "expired" } });
    const edits = h.fake.only("chat.update");
    expect(edits.map((body) => [body.channel, body.ts])).toEqual([
      [ashaDm, first.chatMessageId],
      [raviDm, second.chatMessageId],
      [ashaDm, first.chatMessageId],
    ]);
    for (const [i, body] of edits.entries()) {
      expect(choiceButtons(body)).toEqual([]);
      const text = JSON.stringify(body.blocks);
      expect(text).toContain(
        i === 2 ? "This ask has expired." : "Answered by Asha",
      );
      if (i < 2) expect(text).toContain("Yes");
    }
    expect(h.fake.only("chat.postMessage")).toEqual([]);
  },
);

startedCase(
  "O6 a digit fallback explains all choices and both reply forms",
  async (h) => {
    await h.chat.postAskDm(asha, {
      ...ask,
      state: { kind: "open", digitFallback: true },
      choices: [...ask.choices, { id: "later", label: "Later" }],
    });
    const body = h.fake.only("chat.postMessage")[0];
    expect(choiceButtons(body)).toEqual([]);
    const text = JSON.stringify(body?.blocks);
    for (const part of [
      "Reply 1 for Yes",
      "Reply 2 for No",
      "Reply 3 for Later",
      "typed reply",
      "reply under this card",
      `${ask.askId} &lt;number&gt;`,
    ]) {
      expect(text.toLowerCase()).toContain(part.toLowerCase());
    }
  },
  { buttons: false },
);

startedCase(
  "O7 retries invalid_blocks once with a digit card and disables buttons",
  async (h) => {
    h.logs.length = 0;
    h.fake.script("chat.postMessage", {
      result: { ok: false, error: "invalid_blocks" },
    });
    const result = await h.chat.postAskDm(asha, ask);
    const messages = h.fake.only("chat.postMessage");
    expect(messages).toHaveLength(2);
    expect(choiceButtons(messages[0])).toHaveLength(2);
    expect(choiceButtons(messages[1])).toEqual([]);
    expect(result.channelId).toBe(ashaDm);
    expect(h.chat.capabilities.buttons).toBe(false);
    expect(h.logs.filter(({ event }) => event === "chat.warn")).toEqual([
      { event: "chat.warn", fields: { count: 1 } },
    ]);
  },
);

startedCase(
  "O8 PX1 agent content remains literal even with a cached Slack user name",
  async (h) => {
    expect(await h.status(callback(dm()))).toBe(200);
    await waitFor(() => h.messages.length === 1);
    const text =
      "<!channel> ok <@U0ADMIN> <https://x.test|login> @asha and a & b";
    await h.chat.postAskDm(asha, {
      ...ask,
      question: text,
      choices: [{ id: "yes", label: "a & b" }],
    });
    await h.chat.postText(threadTarget, text);
    await h.chat.postSummary(
      channel,
      {
        ...summary,
        lines: summary.lines.map((line) => ({ ...line, text })),
      },
      "sum_a1",
    );
    await h.chat.postText(
      threadTarget,
      "Rohit's agent, answering <@U0ASHA>: yes",
    );
    const messages = h.fake.only("chat.postMessage");
    expect(messages).toHaveLength(4);
    for (const body of messages.slice(0, 3)) {
      for (const value of [JSON.stringify(body.blocks), String(body.text)]) {
        for (const escaped of [
          "&lt;!channel&gt;",
          "&lt;@U0ADMIN&gt;",
          "&lt;https://x.test|login&gt;",
          "a &amp; b",
        ])
          expect(value).toContain(escaped);
        for (const raw of ["<!", "<@U", "<https://x.test"])
          expect(value).not.toContain(raw);
      }
    }
    expect(JSON.stringify(messages[3])).toContain("&lt;@U0ASHA&gt;");
    expect(JSON.stringify(messages[3])).not.toContain("<@U0ASHA>");
    const blocked = await failure(() =>
      h.chat.postText(threadTarget, SUMMARY_KEY_MARKER + "sum_forged"),
    );
    expect(blocked.effect).toBe("refused");
    expect(h.fake.only("chat.postMessage")).toHaveLength(4);
  },
);

test(
  "O10 cards use CardText and no production chat module imports mdast Text",
  () => {
    const root = new URL("../../src/chat/", import.meta.url);
    const cards = readFileSync(new URL("cards.ts", root), "utf8");
    expect(cards).toMatch(
      /import\s+\{[^}]*\bCardText\b[^}]*\}\s+from\s+["']chat["']/,
    );
    for (const name of readdirSync(root).filter((path) =>
      path.endsWith(".ts"),
    )) {
      const source = readFileSync(new URL(name, root), "utf8");
      const imports = source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']chat["']/g,
      );
      for (const match of imports) expect(match[1]).not.toMatch(/\bText\b/);
    }
  },
  timeout,
);

startedCase(
  "O14 O15 post in a channel and its new thread, and deliver a notice only to its recipient",
  async (h) => {
    const started = await h.chat.postText(
      { kind: "channel", channelId: channel },
      "Root",
    );
    expect(subscribed(h, started.chatThreadId)).toBe(true);
    const target = {
      kind: "thread",
      chatThreadId: started.chatThreadId,
    } as const;
    const reply = await h.chat.postText(target, "Follow-up");
    expect(reply.chatThreadId).toBe(started.chatThreadId);
    const refused = await failure(() =>
      h.chat.postText(
        { kind: "channel", channelId: channel },
        SUMMARY_KEY_MARKER + "sum_forged",
      ),
    );
    expect(refused.effect).toBe("refused");
    await h.chat.postEphemeral(ref, ravi, "Private notice");
    const posts = h.fake.only("chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0]).not.toHaveProperty("thread_ts");
    expect(posts[1]?.thread_ts).toBe(started.chatMessageId);
    const notices = h.fake.only("chat.postEphemeral");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ channel, user: ravi });
  },
);
