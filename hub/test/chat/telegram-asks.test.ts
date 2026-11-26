import { expect, test } from "bun:test";
import type { ChatInboundHandlers, ChatPort } from "../../src/contract/chat.ts";
import type { AskInput } from "../../src/contract/mcp.ts";
import { createPeopleDirectory } from "../../src/core/directory.ts";
import { createCoreStore } from "../../src/core/store-impl.ts";
import { configFixture } from "../core/config-fixture.ts";
import {
  a,
  b,
  caller,
  closeDb,
  fixture,
  openDb,
  p1,
  value,
} from "../core/fixture.ts";
import { asksOf, bind, choices, question, rows } from "../core/fakes.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import {
  tap,
  telegramA,
  telegramB,
  telegramC,
  telegramMessage,
} from "../fakes/fake-telegram.ts";
import {
  idleHandlers,
  startTelegram,
  telegramFixture,
  telegramTimeout,
} from "./telegram-fixture.ts";

async function askHarness() {
  const h = telegramFixture();
  const people = configFixture().people.map((person, index) => ({
    ...person,
    telegramUserId: String(telegramA + index),
  }));
  const f = await fixture({ people, chat: { adapter: "telegram" } });
  const directory = createPeopleDirectory(people);
  let db = f.db;
  let time = f.now();
  const store = (port: ChatPort) =>
    createCoreStore({
      ...f,
      config: { ...f.config, slack: { mode: "off", buttons: false } },
      chat: port,
      now: () => time,
      db,
      people: directory,
    });
  const initial = store(h.port);
  initial.syncDirectory();
  const sessionId = bind(db, initial);
  let asks = asksOf(initial);
  let port = h.port;
  const post = (input: Partial<AskInput>) =>
    asks.ask(caller, {
      sessionId,
      projectId: p1,
      kind: "choice",
      requestedAction: "choice",
      ...(input.kind === "work_request"
        ? {}
        : { to: [a.personId, b.personId], choices }),
      question,
      ...input,
    });
  return {
    ...h,
    get asks() {
      return asks;
    },
    get db() {
      return db;
    },
    get port() {
      return port;
    },
    post,
    async createAsk(input: Partial<AskInput> = {}) {
      const result = await post(input);
      expect(result).toMatchObject({ ok: true });
      const created = value(result);
      expect(created.deliveredTo).toHaveLength(
        input.kind === "work_request" ? 1 : (input.to?.length ?? 2),
      );
      return created.askId;
    },
    messageId(askId: string, personId = a.personId) {
      const delivery = rows(db, "ask_deliveries").find(
        (row) => row.ask_id === askId && row.person_id === personId,
      );
      const id = Number(delivery?.chat_message_id);
      expect(id).toBeGreaterThan(0);
      return id;
    },
    async editCards() {
      for (const { askId, personId, ref, card } of asks.pendingEdits(10)) {
        await port.editAskDm(ref, card);
        asks.markEditDone(askId, personId);
      }
    },
    advance(minutes: number) {
      time += minutes * 60_000;
    },
    async restart() {
      await port.stop();
      closeDb(db);
      db = openDb(f.path);
      port = h.createPort();
      asks = asksOf(store(port));
      asks.reconcileEdits();
    },
    async slackAsk() {
      const slack = asksOf(
        createCoreStore({
          ...f,
          db,
          people: directory,
          chat: new FakeChatPort(),
          config: { ...f.config, chat: { adapter: "slack" } },
        }),
      );
      return value(
        await slack.ask(caller, {
          sessionId,
          projectId: p1,
          kind: "work_request",
          requestedAction: "work",
          issueId: "demo-12",
          question,
        }),
      ).askId;
    },
  };
}

function answering(
  h: Awaited<ReturnType<typeof askHarness>>,
): ChatInboundHandlers {
  return {
    ...idleHandlers,
    onAction: (event) => Promise.resolve(h.asks.answerAction(event).reply),
    onMessage(event) {
      h.asks.answerDigit(event);
      return Promise.resolve();
    },
  };
}

function editedIds(h: Awaited<ReturnType<typeof askHarness>>) {
  return h.fake
    .only("editMessageText")
    .map(({ message_id }) => Number(message_id))
    .sort((left, right) => left - right);
}

test(
  "T2-ASK1 a tap locks one answer and clears the original two keyboards",
  async () => {
    const h = await askHarness();
    const id = await h.createAsk();
    const original = [h.messageId(id), h.messageId(id, b.personId)];
    await startTelegram(h.port, answering(h));
    try {
      h.fake.push(tap(1, telegramA, telegramA, original[0] ?? 0));
      await h.fake.handled(1);
      expect(rows(h.db, "ask_answers")).toMatchObject([
        {
          ask_id: id,
          answered_by_person_id: a.personId,
          source: "button",
          choice_id: "first",
        },
      ]);
      await h.editCards();
      expect(editedIds(h)).toEqual(original);
      for (const messageId of original)
        expect(h.fake.cards.get(messageId)).toEqual({ inline_keyboard: [] });
      expect(h.fake.only("sendMessage")).toHaveLength(2);
    } finally {
      await h.port.stop();
    }
  },
  telegramTimeout,
);

test(
  "T2-ASK2 competing taps produce one winner and a replay cannot create a second permit",
  async () => {
    const h = await askHarness();
    const id = await h.createAsk();
    const permitAsk = await h.createAsk({
      kind: "work_request",
      requestedAction: "work",
      issueId: "demo-12",
    });
    const aId = h.messageId(id);
    const bId = h.messageId(id, b.personId);
    const permitId = h.messageId(permitAsk);
    await startTelegram(h.port, answering(h));
    try {
      h.fake.push(
        tap(10, telegramA, telegramA, aId),
        tap(11, telegramB, telegramB, bId, "fa1:1"),
      );
      await h.fake.handled(11);
      expect(rows(h.db, "ask_answers")).toHaveLength(1);
      expect(
        h.fake
          .only("answerCallbackQuery")
          .filter(
            ({ text }) =>
              typeof text === "string" && /already answered/i.test(text),
          ),
      ).toHaveLength(1);
      h.fake.push(
        tap(12, telegramA, telegramA, aId, "fa1:0", "callback-10"),
        tap(13, telegramA, telegramA, permitId),
        tap(14, telegramA, telegramA, permitId, "fa1:0", "callback-13"),
      );
      await h.fake.handled(14);
      expect(
        rows(h.db, "ask_answers")
          .map(({ ask_id }) => ask_id)
          .sort(),
      ).toEqual([id, permitAsk].sort());
      expect(rows(h.db, "permits")).toMatchObject([
        { request_ask_id: permitAsk },
      ]);
    } finally {
      await h.port.stop();
    }
  },
  telegramTimeout,
);

test(
  "T2-ASK3 restart before answering and after commit reuses the original deliveries",
  async () => {
    const h = await askHarness();
    const id = await h.createAsk();
    const original = [h.messageId(id), h.messageId(id, b.personId)];
    await startTelegram(h.port, answering(h));
    try {
      await h.restart();
      await startTelegram(h.port, answering(h));
      h.fake.push(tap(20, telegramA, telegramA, original[0] ?? 0));
      await h.fake.handled(20);
      expect(rows(h.db, "ask_answers")).toMatchObject([{ ask_id: id }]);
      expect(editedIds(h)).toEqual([]);
      await h.restart();
      await h.editCards();
      expect(editedIds(h)).toEqual(original);
      expect(rows(h.db, "ask_answers")).toHaveLength(1);
      expect(h.fake.only("sendMessage")).toHaveLength(2);
    } finally {
      await h.port.stop();
    }
  },
  telegramTimeout,
);

test(
  "T2-SEC1 untrusted taps receive private refusals and cannot write an answer or permit",
  async () => {
    const h = await askHarness();
    const work = { kind: "work_request", requestedAction: "work" } as const;
    const expired = await h.createAsk({
      ...work,
      issueId: "demo-12",
      expiresInMinutes: 1,
    });
    h.advance(2);
    const open = await h.createAsk({ ...work, issueId: "demo-13" });
    const slack = await h.slackAsk();
    const original = h.messageId(open);
    const slackDelivery = rows(h.db, "ask_deliveries").find(
      (row) => row.ask_id === slack,
    );
    expect(slackDelivery).toMatchObject({ adapter: "slack" });
    h.db
      .prepare(
        "UPDATE ask_deliveries SET channel_id = ?, chat_message_id = ? WHERE ask_id = ?",
      )
      .run(String(telegramA), "900", slack);
    await startTelegram(h.port, answering(h));
    try {
      h.fake.push(
        tap(30, 999, telegramA, original),
        tap(31, telegramC, telegramA, original),
        tap(32, telegramA, telegramA, original, "fa1:9"),
        tap(33, telegramA, telegramA, original + 100),
        tap(34, telegramA, telegramA, h.messageId(expired)),
        tap(35, telegramA, telegramA, 900),
      );
      await h.fake.handled(35);
      expect(rows(h.db, "ask_answers")).toEqual([]);
      expect(rows(h.db, "permits")).toEqual([]);
      expect(h.fake.only("answerCallbackQuery")).toHaveLength(6);
      for (const { text } of h.fake.only("answerCallbackQuery"))
        expect(text).toEqual(expect.stringMatching(/\S/));
      expect(h.fake.only("sendMessage")).toHaveLength(2);
    } finally {
      await h.port.stop();
    }
  },
  telegramTimeout,
);

test(
  "T2-ASK3 an ambiguous send stays unknown across restart without a repost",
  async () => {
    const h = await askHarness();
    h.fake.respond("sendMessage", (_url, body) => {
      h.fake.cards.set(900, body.reply_markup);
      throw new Error("Connection dropped after the bot accepted the send");
    });
    const first = await h.post({ to: [a.personId] });
    expect(first).toMatchObject({
      ok: true,
      value: { deliveredTo: [], pendingTo: [{ personId: a.personId }] },
    });
    expect(h.fake.only("sendMessage")).toHaveLength(1);
    expect(rows(h.db, "ask_deliveries")).toMatchObject([
      { delivery_state: "unknown" },
    ]);
    await startTelegram(h.port, answering(h));
    try {
      await h.restart();
      expect(h.asks.markInterruptedPostingUnknown()).toBe(0);
      expect(h.fake.only("sendMessage")).toHaveLength(1);
      expect(rows(h.db, "ask_deliveries")).toMatchObject([
        { delivery_state: "unknown" },
      ]);
    } finally {
      await h.port.stop();
    }
  },
  telegramTimeout,
);

test(
  "T2-DM1 digit replies resolve the tapped card and explicit ask ids",
  async () => {
    const h = await askHarness();
    const first = await h.createAsk({ to: [a.personId] });
    const second = await h.createAsk({ to: [a.personId] });
    await startTelegram(h.port, answering(h));
    try {
      h.fake.push(
        {
          update_id: 40,
          message: telegramMessage(telegramA, 901, {
            text: "1",
            reply_to_message: telegramMessage(telegramA, h.messageId(first)),
          }),
        },
        {
          update_id: 41,
          message: telegramMessage(telegramA, 902, { text: second + " 2" }),
        },
      );
      await h.fake.handled(41);
      const answers = rows(h.db, "ask_answers");
      expect(answers).toHaveLength(2);
      expect(answers.find(({ ask_id }) => ask_id === first)).toMatchObject({
        choice_id: "first",
        source: "digit",
      });
      expect(answers.find(({ ask_id }) => ask_id === second)).toMatchObject({
        choice_id: "second",
        source: "digit",
      });
    } finally {
      await h.port.stop();
    }
  },
  telegramTimeout,
);
