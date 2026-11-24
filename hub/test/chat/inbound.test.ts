import { expect, test } from "bun:test";
import {
  appId,
  asha,
  ashaDm,
  botId,
  botUser,
  channel,
  ravi,
  team,
  within,
} from "../fakes/fake-slack-server.ts";
import {
  slackCases,
  eventKeys,
  ask,
  callback,
  changed,
  subscribedChanges,
  click,
  deleted,
  dm,
  mention,
  replyTs,
  rootTs,
  startedSlack,
  type SlackFixture,
  waitFor,
} from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);
const wrongTeam = "T0OTHER";
const anotherTs = "1800000000.500000";

async function subscribeChannel(h: SlackFixture) {
  expect(await h.status(callback(mention(), "Ev0ROOT"))).toBe(200);
  await waitFor(() => h.messages.length === 1);
}

startedCase(
  "M2 BI1 BI2 BI3 drop the hub bot and deliver other bots with isBot",
  async (h) => {
    for (const [i, fields] of [
      { user: botUser },
      { bot_id: botId },
      { app_id: appId },
      { bot_profile: { app_id: appId } },
    ].entries()) {
      expect(
        await h.status(
          callback(
            dm({ ts: `1800000001.00000${i}`, ...fields }),
            `Ev0SELF${i}`,
          ),
        ),
      ).toBe(200);
    }
    expect(
      await h.status(
        callback(dm({ bot_id: "B0OTHER", app_id: "A0OTHER" }), "Ev0OTHERBOT"),
      ),
    ).toBe(200);
    await h.stop();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ isBot: true, chatMessageId: rootTs });
    expect(h.changes).toEqual([]);
  },
);

startedCase(
  "M3 one new message in an already subscribed DM is dispatched once",
  async (h) => {
    expect(await h.status(callback())).toBe(200);
    await waitFor(() => h.messages.length === 1);
    expect(
      await h.status(
        callback(dm({ ts: replyTs, thread_ts: rootTs }), "Ev0REPLY"),
      ),
    ).toBe(200);
    await h.stop();
    expect(h.messages.map(({ chatMessageId }) => chatMessageId)).toEqual([
      rootTs,
      replyTs,
    ]);
    expect(h.messages[1]?.threadRootMessageId).toBe(rootTs);
  },
);

test(
  "M4 a second message reaches the same thread while the first handler waits",
  async () => {
    const firstEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using h = await startedSlack({
      handlers: {
        onMessage(event) {
          if (event.chatMessageId !== rootTs) return Promise.resolve();
          firstEntered.resolve();
          return release.promise;
        },
      },
    });
    try {
      expect(await h.status(callback())).toBe(200);
      await within(firstEntered.promise);
      expect(
        await h.status(
          callback(dm({ ts: replyTs, thread_ts: rootTs }), "Ev0SECOND"),
        ),
      ).toBe(200);
      await waitFor(() => h.messages.length === 2);
      expect(h.messages.map(({ chatMessageId }) => chatMessageId)).toEqual([
        rootTs,
        replyTs,
      ]);
      expect(h.logs.filter(({ event }) => event === "chat.error")).toEqual([]);
    } finally {
      release.resolve();
    }
  },
  timeout,
);

startedCase(
  "M5 a DM from someone outside the people directory reaches the core",
  async (h) => {
    expect(await h.status(callback(dm({ user: "U0STRANGER" })))).toBe(200);
    await h.stop();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({
      slackUserId: "U0STRANGER",
      isDirect: true,
    });
    expect(h.fake.only("chat.postMessage")).toEqual([]);
  },
);

startedCase(
  "M6 a channel mention subscribes its thread before the follow-up message",
  async (h) => {
    await subscribeChannel(h);
    const reply = dm({
      channel,
      channel_type: "channel",
      ts: replyTs,
      thread_ts: rootTs,
    });
    expect(await h.status(callback(reply, "Ev0CHANNELREPLY"))).toBe(200);
    await h.stop();
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]).toMatchObject({ mentionsBot: true, isDirect: false });
    expect(h.messages[0]).not.toHaveProperty("threadRootMessageId");
    expect(h.messages[1]).toMatchObject({
      threadRootMessageId: rootTs,
      chatThreadId: h.messages[0]?.chatThreadId,
    });
  },
);

startedCase(
  "M7 a digit under an ask carries the card message id and a top-level digit does not",
  async (h) => {
    const card = await h.chat.postAskDm(asha, ask);
    const under = dm({ ts: replyTs, thread_ts: card.chatMessageId, text: "2" });
    const top = dm({ ts: anotherTs, text: `${ask.askId} 2` });
    expect(await h.status(callback(under, "Ev0UNDER"))).toBe(200);
    await waitFor(() => h.messages.length === 1);
    expect(await h.status(callback(top, "Ev0TOP"))).toBe(200);
    await h.stop();
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]?.threadRootMessageId).toBe(card.chatMessageId);
    expect(h.messages[1]).not.toHaveProperty("threadRootMessageId");
  },
  { buttons: false },
);

for (const [label, body] of [
  ["DM", callback(dm(), "Ev0BAD", wrongTeam)],
  ["mention", callback(mention(), "Ev0BAD", wrongTeam)],
  ["click", click({ team: { id: wrongTeam }, team_id: wrongTeam })],
  ["edit", callback(changed(), "Ev0BAD", wrongTeam)],
  ["delete", callback(deleted(), "Ev0BAD", wrongTeam)],
  [
    "missing delivery team",
    { ...callback(), team_id: undefined, authorizations: undefined },
  ],
  ["empty delivery team", callback(dm(), "Ev0BAD", "")],
  [
    "sender team alone",
    click({
      team: undefined,
      team_id: undefined,
      user: { id: asha, team_id: team },
    }),
  ],
  [
    "conflicting delivery fields",
    { ...callback(), authorizations: [{ team_id: wrongTeam }] },
  ],
  ["conflicting action delivery", click({ team_id: wrongTeam })],
] as const) {
  startedCase(
    `TM2 TM3 workspace pin drops ${label} without storing it`,
    async (h) => {
      h.fake.calls.length = 0;
      h.logs.length = 0;
      expect(await h.status(body)).toBe(200);
      await h.stop();
      expect([h.actions, h.messages, h.changes]).toEqual([[], [], []]);
      expect(h.fake.calls).toEqual([]);
      expect(eventKeys(h)).toEqual([]);
      expect(h.logs.filter(({ event }) => event === "chat.warn")).toEqual([
        { event: "chat.warn", fields: { count: 1 } },
      ]);
    },
  );
}

startedCase(
  "WP1 WP1c bad signatures take precedence and the workspace pin keeps both dedupe keys empty",
  async (h) => {
    const rejected = callback(dm(), "Ev0PIN", wrongTeam);
    expect(await h.status(rejected, { corruptSignature: true })).toBe(401);
    expect(eventKeys(h)).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(await h.status(rejected)).toBe(200);
    expect(eventKeys(h)).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(await h.status(callback(dm(), "Ev0PIN"))).toBe(200);
    await h.stop();
    expect(h.messages).toHaveLength(1);
  },
);

startedCase(
  "MT1 and MT2 extract raw Slack user tokens in order and exclude the bot",
  async (h) => {
    const texts = [
      "Hi <@U0RAVI>, <@U0ASHA>, <@U0RAVI|ravi>, <@W0GUEST>, <@U0BOT>, @ravi, <!channel> and <#C0GEN|general>",
      "@ravi",
      "<@U0BOT>",
      "&lt;@U0RAVI&gt;",
      "<@U0RAVI",
    ];
    for (const [i, text] of texts.entries()) {
      expect(
        await h.status(
          callback(dm({ text, ts: `1800000001.00000${i}` }), `Ev0MENTION${i}`),
        ),
      ).toBe(200);
      await waitFor(() => h.messages.length === i + 1);
    }
    expect(
      h.messages.map(({ mentionedSlackUserIds }) => mentionedSlackUserIds),
    ).toEqual([[ravi, asha, "W0GUEST"], [], [], [], []]);
    expect(h.messages[0]?.mentionsBot).toBe(true);
    expect(h.messages[2]?.mentionsBot).toBe(true);
  },
);

for (const [label, files, expected] of [
  [
    "named attachments",
    [
      {
        name: "plan.pdf",
        id: "F0FIRST",
        title: "Private title",
        url_private: "https://private.test/download",
      },
      { name: "a b.png" },
    ],
    ["plan.pdf", "a b.png"],
  ],
  ["no attachments", undefined, []],
  ["unnamed attachment", [{ id: "F0FIRST", title: "Private title" }], []],
] as const) {
  startedCase(
    `FL1 forwards only well-formed attached file names (${label})`,
    async (h) => {
      expect(await h.status(callback(dm({ files })))).toBe(200);
      await h.stop();
      expect(h.messages).toHaveLength(1);
      expect(h.messages[0]?.fileNames).toEqual(expected);
      const record = JSON.stringify(h.messages);
      for (const privateValue of ["private.test", "F0FIRST", "Private title"]) {
        expect(record).not.toContain(privateValue);
      }
    },
  );
}

startedCase(
  "MC1 MC2 MC5 an edit and delete in a subscribed thread keep the original message identity",
  async (h) => {
    await subscribeChannel(h);
    const edit = callback(changed(), "Ev0EDIT");
    expect(await h.status(edit)).toBe(200);
    await waitFor(() => h.changes.length === 1);
    expect(
      await h.status(edit, { headers: { "X-Slack-Retry-Num": "1" } }),
    ).toBe(200);
    expect(await h.status(callback(deleted(), "Ev0DELETE"))).toBe(200);
    await h.stop();
    expect(h.changes).toEqual(subscribedChanges);
    expect(h.messages).toHaveLength(1);
  },
);

startedCase(
  "MC3 MC4 ignore unsubscribed edits, top-level channel edits and bot echoes",
  async (h) => {
    await subscribeChannel(h);
    const separate = changed({
      ts: replyTs,
      thread_ts: anotherTs,
      user: asha,
      text: "new",
    });
    const top = changed({ ts: anotherTs, user: asha, text: "new" });
    const ownCard = await h.chat.postAskDm(asha, ask);
    await h.chat.editAskDm(ownCard, { ...ask, state: { kind: "expired" } });
    const echo = {
      ...changed({
        ts: ownCard.chatMessageId,
        thread_ts: ownCard.chatMessageId,
        user: botUser,
        bot_id: botId,
        text: "updated",
      }),
      channel: ashaDm,
      channel_type: "im",
    };
    for (const [i, event] of [separate, top, echo].entries()) {
      expect(await h.status(callback(event, `Ev0IGNORE${i}`))).toBe(200);
    }
    await h.stop();
    expect(h.changes).toEqual([]);
    expect(h.messages).toHaveLength(1);
  },
);
