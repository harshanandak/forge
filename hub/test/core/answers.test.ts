import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  ASK_ACTION_PREFIX,
  type ChatActionEvent,
} from "../../src/contract/chat.ts";
import { createPeopleDirectory } from "../../src/core/directory.ts";
import { createCoreStore } from "../../src/core/store-impl.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { configFixture } from "./config-fixture.ts";
import { a, b, caller, closeDb, openDb, p1, value } from "./fixture.ts";
import { seedRemovedMemberName } from "./fixture.ts";
import {
  askFixture,
  asksOf,
  button,
  choices,
  question,
  digit,
  rows,
  slackA,
  slackB,
} from "./fakes.ts";

const timeout = 30_000;
const winner =
  "Already answered by Fixture Alpha at 00:00 UTC: Choose the first option.";

test(
  "T2-SEC1 Telegram actions resolve exactly one original delivery for the numeric sender",
  async () => {
    const config = configFixture();
    const chat = new FakeChatPort();
    const f = await askFixture(chat, {
      chat: { adapter: "telegram" },
      slack: { mode: "off", buttons: false },
      people: config.people.map((person, i) => ({
        ...person,
        telegramUserId: String(i + 1),
      })),
    });
    const first = value(await f.choice({ to: [a.personId] })).askId;
    const second = value(await f.choice({ to: [a.personId] })).askId;
    const channelId = "1";
    const ref = {
      channelId,
      chatThreadId: "fixture-thread",
      chatMessageId: "301",
    };
    const setMessage = (askId: string, messageId: string) =>
      f.db
        .prepare(
          "UPDATE ask_deliveries SET chat_message_id = ? WHERE ask_id = ?",
        )
        .run(messageId, askId);
    setMessage(first, ref.chatMessageId);
    setMessage(second, ref.chatMessageId);
    function tap(eventKey: string, message = ref): ChatActionEvent {
      return {
        eventKey,
        slackUserId: "",
        chatIdentity: { adapter: "telegram", userId: channelId },
        actionId: ASK_ACTION_PREFIX,
        value: "0",
        message,
      };
    }
    const missing = f.asks.answerAction(
      tap("missing-tap", { ...ref, chatMessageId: "302" }),
    );
    const ambiguous = f.asks.answerAction(tap("ambiguous-tap"));
    for (const result of [missing, ambiguous]) {
      expect(result.after).toBeUndefined();
      expect(result.reply.ephemeralText ?? "").toMatch(/\S/);
    }
    for (const table of ["answer_attempts", "ask_answers", "permits"] as const)
      expect(rows(f.db, table)).toEqual([]);
    setMessage(second, "302");
    const locked = f.asks.answerAction(tap("unique-tap"));
    expect(locked.after?.askId).toBe(first);
    expect(rows(f.db, "ask_answers")).toMatchObject([
      { ask_id: first, choice_id: "first", source: "button" },
    ]);
  },
  timeout,
);

test(
  "T2-ANS1 Slack actions still resolve the explicit ask and choice",
  async () => {
    const f = await askFixture();
    const id = value(await f.choice()).askId;
    const event = button(id, "slack-control", slackA, "second");
    expect(f.asks.answerAction(event).after?.askId).toBe(id);
    expect(rows(f.db, "ask_answers")).toMatchObject([
      { ask_id: id, choice_id: "second", source: "button" },
    ]);
  },
  timeout,
);

test(
  "stored answers redact a removed member's name in inbox and card edits",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice({ to: [b.personId] }));
    const answer = f.asks.answerAction(button(askId, "legacy-answer", slackB));
    expect(answer.after?.askId).toBe(askId);
    seedRemovedMemberName(f.db, b.personId);
    const view = f.asks.answerRows(f.sessionId, 1)[0]?.view;
    const card = f.asks.pendingEdits(1)[0]?.card.state;
    const name = "[possible secret removed]";
    expect(view?.answeredBy.name === name).toBe(true);
    expect(card?.kind === "answered" && card.answeredByName === name).toBe(
      true,
    );
  },
  timeout,
);

test(
  "A1: two clickers lock once and queue both edits",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    const post = (key: string, user: string) =>
      Promise.resolve().then(() =>
        f.asks.answerAction(button(askId, key, user)),
      );
    const [first, second] = await Promise.all([
      post("A1a", slackA),
      post("A1b", slackB),
    ]);
    expect(first.after).toMatchObject({
      askId,
      fromPersonId: a.personId,
      queuedEdits: true,
    });
    expect(second.reply.ephemeralText).toBe(winner);
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
    expect(rows(f.db, "answer_attempts")).toHaveLength(2);
    expect(
      f.asks
        .pendingEdits(10)
        .map((x) => x.personId)
        .sort(),
    ).toEqual([a.personId, b.personId]);
  },
  timeout,
);

test(
  "A2: two event keys from one clicker record two attempts",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    expect(f.asks.answerAction(button(askId, "A2a")).after?.askId).toBe(askId);
    expect(f.asks.answerAction(button(askId, "A2b")).reply.ephemeralText).toBe(
      winner,
    );
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
    expect(rows(f.db, "answer_attempts").map((x) => x.outcome)).toEqual([
      "locked",
      "already_answered",
    ]);
  },
  timeout,
);

test(
  "A3: retry uses the stored outcome without queuing another edit",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice({ to: [a.personId] }));
    const event = button(askId, "A3");
    const first = f.asks.answerAction(event);
    expect(first.after?.queuedEdits).toBe(true);
    f.asks.markEditDone(askId, a.personId);
    const retry = f.asks.answerAction(event);
    expect(retry.reply).toEqual(first.reply);
    expect(retry.after).toBeUndefined();
    expect(rows(f.db, "answer_attempts")).toMatchObject([
      { outcome: "locked" },
    ]);
    expect(rows(f.db, "ask_edit_effects")).toMatchObject([{ status: "done" }]);
  },
  timeout,
);

test(
  "A4: a second open database handle sees the persisted winner",
  async () => {
    const f = await askFixture();
    const other = asksOf(createCoreStore({ ...f.deps, db: openDb(f.path) }));
    const { askId } = value(await f.choice());
    expect(other.answerAction(button(askId, "A4a")).after?.askId).toBe(askId);
    expect(
      f.asks.answerAction(button(askId, "A4b", slackB)).reply.ephemeralText,
    ).toBe(winner);
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
  },
  timeout,
);

const contenderSource = `
  import { text } from "node:stream/consumers";
  const { openHubDb, createPeopleDirectory } = await import(fixture.entry);
  const { createCoreStore } = await import(fixture.store);
  const db = openHubDb(fixture.path);
  try {
    const people = createPeopleDirectory(fixture.config.people);
    const asks = createCoreStore({ db, config: fixture.config, people, now: () => 1234,
      log: { info() {}, warn() {}, error() {} }, chat: {} }).asks;
    console.log("ready");
    if (await text(process.stdin) !== "go") throw new Error("Missing start signal");
    const outcomes = fixture.events.map(event => {
      const result = asks.answerAction(event);
      return result.after ? "locked" :
        result.reply.ephemeralText?.startsWith("Already answered by ") ? "already_answered" : result;
    });
    console.log(JSON.stringify(outcomes));
  } finally { db.close(); }
`;

test(
  "A5: independent Node connections contend for twenty locks",
  async () => {
    const f = await askFixture();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(value(await f.choice()).askId);
    const entry = new URL("../../dist/core/index.js", import.meta.url).href;
    const store = new URL("../../dist/core/store-impl.js", import.meta.url)
      .href;
    const contenders = [slackA, slackB].map((user) => {
      const events = ids.map((id, index) => button(id, user + index, user));
      const data = { path: f.path, config: f.config, entry, store, events };
      const program = `const fixture = ${JSON.stringify(data)};\n${contenderSource}`;
      const child = spawn("node", ["--input-type=module", "--eval", program], {
        timeout,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const ready = Promise.withResolvers<void>();
      const lines: string[] = [];
      const stdout = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      stdout.on("line", (line) => {
        if (line === "ready") ready.resolve();
        else lines.push(line);
      });
      let stderr = "";
      let error: Error | undefined;
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (cause) => {
        error = cause;
      });
      child.stdin.on("error", (cause) => {
        error ??= cause;
      });
      const done = new Promise<number | null>((resolve) =>
        child.once("close", resolve),
      ).then((code): unknown[] => {
        if (error) throw error;
        if (code !== 0)
          throw new Error(stderr || "A5 contender exited: " + code);
        const result: unknown = JSON.parse(lines.join("\n"));
        if (!Array.isArray(result))
          throw new Error("Missing A5 contender outcomes");
        const outcomes: unknown[] = result;
        return outcomes;
      });
      const started = Promise.race([
        ready.promise,
        done.then(() => {
          throw new Error("A5 contender exited before ready");
        }),
      ]);
      return { child, started, done };
    });
    try {
      await Promise.all(contenders.map(({ started }) => started));
      for (const { child } of contenders) child.stdin.end("go");
      const answers = await Promise.all(contenders.map(({ done }) => done));
      expect(answers.flat().sort()).toEqual([
        ...Array<string>(20).fill("already_answered"),
        ...Array<string>(20).fill("locked"),
      ]);
      expect(rows(f.db, "ask_answers")).toHaveLength(20);
    } finally {
      for (const { child } of contenders)
        if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled(contenders.map(({ done }) => done));
    }
  },
  timeout,
);

test(
  "A6: restarting before the answer keeps both original edit refs",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    closeDb(f.db);
    const db = openDb(f.path);
    const asks = asksOf(
      createCoreStore({ ...f.deps, db, chat: new FakeChatPort() }),
    );
    expect(asks.answerAction(button(askId, "A6")).after?.askId).toBe(askId);
    expect(asks.answerRows(f.sessionId, 10)).toMatchObject([
      { view: { askId, choiceId: "first" }, delivered: false, acked: false },
    ]);
    expect(
      asks
        .pendingEdits(10)
        .map((x) => x.ref.chatMessageId)
        .sort(),
    ).toEqual(["message-1", "message-2"]);
  },
  timeout,
);

test(
  "A7: restarting after the answer keeps the original winner",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    expect(f.asks.answerAction(button(askId, "A7a")).after?.askId).toBe(askId);
    const before = rows(f.db, "ask_answers");
    closeDb(f.db);
    const db = openDb(f.path);
    const asks = asksOf(
      createCoreStore({ ...f.deps, db, chat: new FakeChatPort() }),
    );
    expect(
      asks.answerAction(button(askId, "A7b", slackB)).reply.ephemeralText,
    ).toBe(winner);
    expect(rows(db, "ask_answers")).toEqual(before);
  },
  timeout,
);

test(
  "A8: a failing permit insert rolls back the answer and every dependent write",
  async () => {
    const f = await askFixture();
    const sessionId = f.store.sessions.createUnboundSession(
      a,
      p1,
      "t3",
    ).sessionId;
    const { askId } = value(await f.request({ sessionId }));
    const fault = {
      ...f.db,
      prepare(sql: string) {
        const stmt = f.db.prepare(sql);
        if (!/\binsert\s+into\s+permits\b/i.test(sql)) return stmt;
        return {
          get: stmt.get.bind(stmt),
          all: stmt.all.bind(stmt),
          run() {
            throw new Error("permit insert fault");
          },
        };
      },
    };
    const asks = asksOf(createCoreStore({ ...f.deps, db: fault }));
    expect(() =>
      asks.answerAction(button(askId, "A8", slackA, "approve")),
    ).toThrow("permit insert fault");
    expect(rows(f.db, "asks")).toMatchObject([{ status: "open" }]);
    for (const table of [
      "ask_answers",
      "permits",
      "answer_attempts",
      "ask_edit_effects",
    ] as const)
      expect(rows(f.db, table)).toEqual([]);
    expect(f.store.sessions.session(sessionId)?.mode).toBe("reply_only");
  },
  timeout,
);

test(
  "A9: button and digit must name a choice on the ask",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    const text = "That choice is not on this ask.";
    expect(
      f.asks.answerAction(button(askId, "A9", slackA, "missing")).reply
        .ephemeralText,
    ).toBe(text);
    expect(f.asks.answerDigit(digit(askId + " 4"))).toMatchObject({
      kind: "answered",
      outcome: { kind: "invalid_choice" },
      ephemeralText: text,
    });
    expect(rows(f.db, "ask_answers")).toEqual([]);
    expect(rows(f.db, "answer_attempts").map((x) => x.outcome)).toEqual([
      "invalid_choice",
      "invalid_choice",
    ]);
  },
  timeout,
);

test(
  "A10: expiry, removed members and unknown identities are refused",
  async () => {
    const f = await askFixture();
    const former = value(await f.choice());
    const restricted = value(await f.choice({ to: [b.personId] }));
    f.setTime(Date.parse(former.expiresAt));
    expect(
      f.asks.answerAction(button(former.askId, "late")).reply.ephemeralText,
    ).toBe("This ask has expired.");
    expect(f.asks.pendingEdits(10)).toHaveLength(2);
    f.setTime(1234);
    const recorded = value(await f.choice());
    const replay = button(recorded.askId, "before-removal", slackB);
    f.asks.answerAction(button(recorded.askId, "winner"));
    expect(f.asks.answerAction(replay).reply.ephemeralText).toBe(winner);
    const cases = [
      [restricted.askId, "other", slackA, "This ask is for Fixture Beta."],
      [restricted.askId, "removed", slackB, "This ask is for Fixture Beta."],
      [
        restricted.askId,
        "unknown",
        "U00000000",
        "You are not set up in Forge for this workspace.",
      ],
      ["ask_unknown", "missing", slackA, "This ask no longer exists."],
    ] as const;
    for (const [id, key, user, text] of cases) {
      if (key === "removed")
        f.db
          .prepare(
            "DELETE FROM project_members WHERE project_id = ? AND person_id = ?",
          )
          .run(p1, b.personId);
      expect(
        f.asks.answerAction(button(id, key, user)).reply.ephemeralText,
      ).toBe(text);
    }
    for (const event of [
      replay,
      button(recorded.askId, "after-removal", slackB),
    ])
      expect(f.asks.answerAction(event).reply.ephemeralText).toBe(
        "This ask is for Fixture Alpha, Fixture Beta.",
      );
    expect(rows(f.db, "asks").map((x) => x.status)).toEqual([
      "expired",
      "open",
      "answered",
    ]);
    expect(rows(f.db, "ask_answers").map((x) => x.ask_id)).toEqual([
      recorded.askId,
    ]);
    expect(rows(f.db, "answer_attempts").map((x) => x.outcome)).toEqual([
      "expired",
      "locked",
      "already_answered",
      "not_allowed",
      "not_allowed",
      "unknown_answerer",
      "unknown_ask",
      "not_allowed",
    ]);
  },
  timeout,
);

test(
  "T1A-ASK uses the selected provider for delivery and locks only a matching provider's answer",
  async () => {
    const f = await askFixture();
    const people = f.config.people.map((person, i) => ({
      ...person,
      telegramUserId: String(i + 1),
    }));
    const chat = new FakeChatPort();
    const telegram = asksOf(
      createCoreStore({
        ...f.deps,
        config: {
          ...f.config,
          people,
          chat: { adapter: "telegram" },
          slack: { mode: "off", buttons: false },
        },
        people: createPeopleDirectory(people),
        chat,
      }),
    );
    const slackId = value(await f.choice({ to: [a.personId] })).askId;
    const askId = value(
      await telegram.ask(caller, {
        sessionId: f.sessionId,
        projectId: p1,
        kind: "choice",
        requestedAction: "choice",
        question,
        choices,
        to: [a.personId],
      }),
    ).askId;
    expect(chat.calls.find(({ name }) => name === "postAskDm")?.args[0]).toBe(
      "1",
    );
    const telegramButton = (value: string, userId = "1") => ({
      ...button(value, "provider-event"),
      chatIdentity: { adapter: "telegram" as const, userId },
    });
    expect(
      telegram.answerAction({
        ...telegramButton(slackId),
        eventKey: "wrong-ask",
      }).after,
    ).toBeUndefined();
    expect(
      f.asks.answerAction(button(askId, "provider-event")).after,
    ).toBeUndefined();
    expect(
      telegram.answerAction(button(askId, "provider-event")).after,
    ).toBeUndefined();
    expect(telegram.answerAction(telegramButton(askId)).after?.askId).toBe(
      askId,
    );
    expect(
      telegram.answerAction({
        ...telegramButton(askId),
        eventKey: "second-telegram-event",
      }).reply.ephemeralText,
    ).toBe(winner);
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
  },
  timeout,
);
