import { expect, test } from "bun:test";
import { fixtureEnv } from "./environment.ts";
import { SLACK_SOCKET_TOKEN_HEADER } from "../../src/contract/chat.ts";
import { asha, ashaDm, ravi, within } from "../fakes/fake-slack-server.ts";
import {
  slackCases,
  subscribed,
  startedSlack,
  ask,
  callback,
  click,
  dm,
  messageRef,
  replyTs,
  rootTs,
  sampleAppToken,
  sampleBotToken,
  signingSecret,
  slackFixture,
  type SlackFixture,
  waitFor,
} from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);
const wrongKey = "wrong signing fixture";
const alreadyAnswered = "Already answered by Asha at 10:15 UTC: Yes.";

function expectIgnored(
  h: SlackFixture,
  keys: ReturnType<SlackFixture["kv"]> = [],
) {
  expect(h.messages).toEqual([]);
  expect(h.fake.calls).toEqual([]);
  expect(h.kv()).toEqual(keys);
}

function expectNotice(h: SlackFixture, user: string | undefined, text: string) {
  const notices = h.fake.only("chat.postEphemeral");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ user, channel: ashaDm });
  expect(String(notices[0]?.text)).toContain(text);
  expect(h.fake.only("chat.update")).toEqual([]);
  expect(h.fake.only("chat.postMessage")).toEqual([]);
}

function expectDedupeCount(h: SlackFixture, count: number) {
  expect(h.kv().filter((key) => key.startsWith("dedupe:"))).toHaveLength(count);
}

test(
  "W1 M1 TM1 signed DM reaches the handler with its identity and subscribed thread",
  async () => {
    const ready = Promise.withResolvers<boolean>();
    await using h = await startedSlack({
      handlers: {
        onMessage(event) {
          ready.resolve(subscribed(h, event.chatThreadId));
          return Promise.resolve();
        },
      },
    });
    expect((await within(h.send(callback()), 3_000)).status).toBe(200);
    expect(await within(ready.promise)).toBe(true);
    expect(h.messages).toEqual([
      {
        eventKey: `slack:${ashaDm}:${rootTs}`,
        slackUserId: asha,
        userName: "asha",
        isBot: false,
        text: "hello",
        ...messageRef(ashaDm, rootTs),
        isDirect: true,
        mentionsBot: false,
        mentionedSlackUserIds: [],
        fileNames: [],
      },
    ]);
    expect(h.actions).toEqual([]);
  },
  timeout,
);

startedCase(
  "W2 Slack URL verification returns the signed challenge without storing anything",
  async (h) => {
    const response = await h.send({
      type: "url_verification",
      challenge: "fixture-challenge",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "fixture-challenge" });
    expect(h.messages).toEqual([]);
    expect(h.kv()).toEqual([]);
  },
);

for (const [label, signing, offset] of [
  ["W3 wrong signing key", { key: wrongKey }, undefined],
  ["W3 tampered signature", { corruptSignature: true }, undefined],
  ["W3 missing signature", { signed: false }, undefined],
  ["W4 stale timestamp", {}, -301],
  ["W4 future timestamp", {}, 301],
] as const) {
  startedCase(`${label} is rejected before dispatch`, async (h) => {
    const written = h.kv();
    h.fake.calls.length = 0;
    const options =
      offset === undefined
        ? signing
        : {
            timestamp: Math.floor(Date.now() / 1000) + offset,
          };
    expect(await h.status(callback(), options)).toBe(401);
    await h.stop();
    expectIgnored(h, offset === undefined ? written : []);
  });
}

startedCase(
  "W5 the exact same signed event remains deduplicated after a database reopen",
  async (h) => {
    const payload = callback();
    const signing = { timestamp: Math.floor(Date.now() / 1000) };
    expect(await h.status(payload, signing)).toBe(200);
    await waitFor(() => h.messages.length === 1);
    expect(await h.status(payload, signing)).toBe(200);
    await h.restart();
    expect(await h.status(payload, signing)).toBe(200);
    await h.stop();
    expect(h.messages).toHaveLength(1);
    expectDedupeCount(h, 1);
  },
  { disk: true },
);

startedCase(
  "W6 action retries carry the same identity and event key without a card edit",
  async (h) => {
    const payload = click();
    const signing = { timestamp: Math.floor(Date.now() / 1000) };
    expect(await h.status(payload, signing)).toBe(200);
    expect(await h.status(payload, signing)).toBe(200);
    await h.stop();
    expect(h.actions).toHaveLength(2);
    expect(h.actions[0]).toMatchObject({ slackUserId: asha, value: ask.askId });
    expect(h.actions[1]).toEqual(h.actions[0]);
    expect(h.fake.only("chat.update")).toEqual([]);
  },
);

for (const mode of ["webhook", "socket"] as const) {
  test(
    `W7 refuses forwarding headers in ${mode} mode before any SDK work`,
    async () => {
      const forwarding = "synthetic forwarding fixture";
      using _env = fixtureEnv({
        SLACK_APP_TOKEN: sampleAppToken,
        SLACK_SOCKET_FORWARDING_SECRET: forwarding,
      });
      await using h = await startedSlack({ mode });
      h.fake.calls.length = 0;
      for (const [header, signed] of [
        [sampleAppToken, false],
        [forwarding, false],
        ["random value", false],
        ["random value", true],
      ] as const) {
        const response = await h.send(callback(), {
          signed,
          headers: { [SLACK_SOCKET_TOKEN_HEADER]: header },
        });
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("");
      }
      await h.stop();
      expect(h.actions).toEqual([]);
      expectIgnored(h);
    },
    timeout,
  );
}

for (const [label, mode, lifecycle, status] of [
  ["W8 Socket Mode", "socket", "started", 404],
  ["W9 before start", "webhook", "idle", 503],
  ["W9 after stop", "webhook", "stopped", 503],
] as const) {
  test(
    `${label} rejects the webhook without touching Slack`,
    async () => {
      await using h = await slackFixture({ mode });
      if (lifecycle !== "idle") await h.start();
      if (lifecycle === "stopped") await h.stop();
      h.fake.calls.length = 0;
      expect(await h.status(callback())).toBe(status);
      expectIgnored(h);
    },
    timeout,
  );
}

startedCase(
  "W10 button data and display name cannot impersonate the authenticated Slack user",
  async (h) => {
    expect(
      await h.status(
        click(
          { user: { id: ravi, name: "asha" }, trigger_id: undefined },
          { value: asha },
        ),
      ),
    ).toBe(200);
    await h.stop();
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]).toMatchObject({
      slackUserId: ravi,
      value: asha,
      eventKey: `${rootTs}:forge_ask_yes:${ravi}:${replyTs}`,
    });
  },
);

startedCase(
  "W11 retry headers never authenticate or exclude an unseen event",
  async (h) => {
    const headers = (retryNumber: string) => ({
      "X-Slack-Retry-Num": retryNumber,
      "X-Slack-Retry-Reason": "http_timeout",
    });
    const first = callback();
    const second = callback(dm({ ts: replyTs }), "Ev0TWO");
    expect(await h.status(first, { headers: headers("1") })).toBe(200);
    await waitFor(() => h.messages.length === 1);
    expect(await h.status(first, { headers: headers("2") })).toBe(200);
    expect(
      await h.status(second, { signed: false, headers: headers("1") }),
    ).toBe(401);
    expect(await h.status(second, { headers: headers("abc") })).toBe(200);
    await h.stop();
    expect(h.messages.map((message) => message.chatMessageId)).toEqual([
      rootTs,
      replyTs,
    ]);
    expectDedupeCount(h, 2);
  },
);

test(
  "A1 TM1 a signed click is acknowledged while its handler is blocked",
  async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using h = await startedSlack({
      handlers: {
        async onAction() {
          entered.resolve();
          await release.promise;
          return {};
        },
      },
    });
    try {
      expect((await within(h.send(click()), 3_000)).status).toBe(200);
      await within(entered.promise);
      expect(h.actions).toEqual([
        {
          eventKey: "trigger.1",
          actionId: "forge_ask_yes",
          value: ask.askId,
          slackUserId: asha,
          message: messageRef(ashaDm, rootTs),
        },
      ]);
      expect(h.fake.only("chat.postEphemeral")).toEqual([]);
      expect(h.fake.only("chat.update")).toEqual([]);
    } finally {
      release.resolve();
    }
  },
  timeout,
);

for (const samePerson of [true, false]) {
  test(
    samePerson
      ? "A2 a double click receives one private late notice"
      : "A3 concurrent answers notify only the losing clicker",
    async () => {
      let won = false;
      await using h = await startedSlack({
        handlers: {
          onAction() {
            const reply = won ? { ephemeralText: alreadyAnswered } : {};
            won = true;
            return Promise.resolve(reply);
          },
        },
      });
      const second = click(
        { trigger_id: "trigger.2", user: { id: samePerson ? asha : ravi } },
        { action_id: "forge_ask_no" },
      );
      expect(
        (await within(Promise.all([h.send(click()), h.send(second)]))).map(
          (response) => response.status,
        ),
      ).toEqual([200, 200]);
      await h.stop();
      expect(h.actions).toHaveLength(2);
      expect(new Set(h.actions.map((event) => event.eventKey))).toEqual(
        new Set(["trigger.1", "trigger.2"]),
      );
      expectNotice(h, h.actions[1]?.slackUserId, alreadyAnswered);
    },
    timeout,
  );
}

startedCase(
  "A4 a foreign action id is acknowledged without dispatch",
  async (h) => {
    h.fake.calls.length = 0;
    expect(await h.status(click({}, { action_id: "other_yes" }))).toBe(200);
    await h.stop();
    expect(h.actions).toEqual([]);
    expect(h.fake.calls).toEqual([]);
    expect(h.kv()).toEqual([]);
  },
);

for (const [row, user, text] of [
  [
    "A5 unknown user",
    "U0STRANGER",
    "You are not set up in Forge for this workspace.",
  ],
  ["A6 answered", asha, alreadyAnswered],
  ["A6 expired", ravi, "This ask has expired."],
] as const) {
  test(
    `${row} receives only the supplied private notice`,
    async () => {
      await using h = await startedSlack({
        handlers: { onAction: () => Promise.resolve({ ephemeralText: text }) },
      });
      expect(await h.status(click({ user: { id: user } }))).toBe(200);
      await h.stop();
      expect(h.actions).toHaveLength(1);
      expect(h.actions[0]?.slackUserId).toBe(user);
      expectNotice(h, user, text);
    },
    timeout,
  );
}

test(
  "A7 L1 handler errors are logged without exposing the signed payload or secrets",
  async () => {
    await using h = await startedSlack({
      handlers: {
        onAction: () =>
          Promise.reject(new Error(sampleBotToken + " secret action payload")),
      },
    });
    expect(await h.status(callback())).toBe(200);
    expect(await h.status(callback(), { signed: false })).toBe(401);
    expect(await h.status(click())).toBe(200);
    await h.stop();
    expect(h.fake.only("chat.postEphemeral")).toEqual([]);
    expect(h.logs.filter((entry) => entry.event === "chat.error")).toHaveLength(
      1,
    );
    h.assertLogFields();
    const log = JSON.stringify(h.logs);
    for (const value of [
      signingSecret,
      sampleBotToken,
      "secret action payload",
      ask.question,
      h.fake.url,
    ]) {
      expect(log).not.toContain(value);
    }
  },
  timeout,
);
