import { expect, test } from "bun:test";
import { createCoreStore } from "../../src/core/store-impl.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import {
  a,
  b,
  caller,
  closeDb,
  configPeople,
  fixture,
  openDb,
  value,
} from "./fixture.ts";
import {
  askFixture,
  asksOf,
  bind,
  button,
  digit,
  refA,
  refB,
  rows,
  scriptedChat,
  slackA,
  slackB,
} from "./fakes.ts";

const timeout = 30_000;
const delivery = (person_id: string, delivery_state: string) => ({
  person_id,
  delivery_state,
});

function delayed(user: string) {
  const gate = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<string>();
  const chat = scriptedChat(
    new Map([[user, { kind: "delay", until: gate.promise }]]),
    (person, id) => {
      if (person === user) posted.resolve(id);
    },
  );
  return {
    chat,
    release: () => gate.resolve(),
    posted: (pending: Promise<unknown>) =>
      Promise.race([
        posted.promise,
        pending.then(() => {
          throw new Error("The ask finished before posting");
        }),
      ]),
  };
}

test(
  "K1: a card that registers after the answer is queued for edit",
  async () => {
    const chat = delayed(slackB);
    const f = await askFixture(chat.chat);
    const pending = f.choice();
    try {
      const id = await chat.posted(pending);
      expect(f.asks.answerAction(button(id, "K1")).after?.askId).toBe(id);
      const answer = rows(f.db, "ask_answers");
      chat.release();
      expect(value(await pending).deliveredTo).toEqual([refA, refB]);
      expect(rows(f.db, "ask_deliveries")).toMatchObject([
        delivery(a.personId, "delivered"),
        delivery(b.personId, "delivered"),
      ]);
      expect(f.asks.pendingEdits(5).map((job) => job.card.state.kind)).toEqual([
        "answered",
        "answered",
      ]);
      expect(rows(f.db, "ask_answers")).toEqual(answer);
    } finally {
      chat.release();
      await pending;
    }
  },
  timeout,
);

test(
  "K2: an uncertain post is retained and can still be answered",
  async () => {
    const chat = scriptedChat(new Map([[slackA, { kind: "unknown" }]]));
    const f = await askFixture(chat);
    for (const source of ["button", "digit"]) {
      const { askId, deliveredTo, pendingTo } = value(
        await f.choice({ to: [a.personId] }),
      );
      expect(deliveredTo).toEqual([]);
      expect(pendingTo).toEqual([refA]);
      expect(
        rows(f.db, "asks").find((row) => row.ask_id === askId)?.status,
      ).toBe("open");
      const result =
        source === "button"
          ? f.asks.answerAction(button(askId, "K2"))
          : f.asks.answerDigit(digit(askId + " 1"));
      expect(result).toMatchObject({ after: { askId } });
    }
    expect(rows(f.db, "ask_deliveries")).toMatchObject(
      Array(2).fill(delivery(a.personId, "unknown")),
    );
    expect(
      chat.writes.filter((call) => call.name === "postAskDm"),
    ).toHaveLength(2);
    expect(chat.calls.filter((call) => call.name === "postAskDm")).toHaveLength(
      2,
    );
  },
  timeout,
);

test(
  "K3: a posting row is marked unknown on restart without a second DM",
  async () => {
    const chat = delayed(slackA);
    const f = await askFixture(chat.chat);
    const pending = f.choice({ to: [a.personId] });
    try {
      await chat.posted(pending);
      expect(rows(f.db, "ask_deliveries")).toMatchObject([
        delivery(a.personId, "posting"),
      ]);
      closeDb(f.db);
      const db = openDb(f.path);
      const restarted = new FakeChatPort();
      const asks = asksOf(createCoreStore({ ...f.deps, db, chat: restarted }));
      expect(asks.markInterruptedPostingUnknown()).toBe(1);
      expect(asks.markInterruptedPostingUnknown()).toBe(0);
      expect(rows(db, "ask_deliveries")).toMatchObject([
        delivery(a.personId, "unknown"),
      ]);
      expect(rows(db, "asks")).toMatchObject([{ status: "open" }]);
      expect(restarted.calls).toEqual([]);
      expect(chat.chat.writes).toHaveLength(1);
    } finally {
      chat.release();
      await pending.catch(() => undefined);
    }
  },
  timeout,
);

test(
  "K4: definite refusals expire asks and only transient refusals allow retry",
  async () => {
    const effects = new Map<string, NonNullable<FakeChatPort["nextWrite"]>>();
    const f = await askFixture(scriptedChat(effects));
    for (const effect of [
      { kind: "refused" },
      { kind: "refused", retryAfterMs: 30000 },
      { kind: "refused", reason: "not_in_channel" },
    ] as const) {
      for (const user of [slackA, slackB]) effects.set(user, effect);
      const result = await f.choice();
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "CHAT_UNAVAILABLE",
          retry: "reason" in effect ? "never" : "safe",
        },
      });
      if ("retryAfterMs" in effect && !result.ok)
        expect(result.error.repair).toContain("30 seconds");
      if ("reason" in effect && !result.ok)
        expect(result.error.message).toContain("not in");
    }
    expect(rows(f.db, "asks").map((row) => row.status)).toEqual(
      Array<string>(3).fill("expired"),
    );
    expect(
      rows(f.db, "ask_deliveries").map((row) => row.delivery_state),
    ).toEqual(Array<string>(6).fill("refused"));
    expect(rows(f.db, "ask_edit_effects")).toEqual([]);
    expect(f.chat.writes).toEqual([]);
  },
  timeout,
);

test(
  "K5: a confirmed delivery survives another recipient's refusal",
  async () => {
    const f = await askFixture(
      scriptedChat(new Map([[slackB, { kind: "refused" }]])),
    );
    expect(value(await f.choice())).toMatchObject({
      deliveredTo: [refA],
      pendingTo: [],
    });
    expect(rows(f.db, "ask_deliveries")).toMatchObject([
      delivery(a.personId, "delivered"),
      delivery(b.personId, "refused"),
    ]);
  },
  timeout,
);

test(
  "K6: expiry and edit reconciliation are idempotent",
  async () => {
    const f = await askFixture();
    const answered = value(await f.choice({ to: [a.personId] }));
    f.asks.answerAction(button(answered.askId, "K6"));
    f.asks.markEditDone(answered.askId, a.personId);
    const expiring = value(await f.choice({ to: [a.personId] }));
    f.setTime(Date.parse(expiring.expiresAt) + 1);
    expect(f.asks.sweepExpiry()).toBe(1);
    expect(f.asks.sweepExpiry()).toBe(0);
    expect(rows(f.db, "asks").map((x) => x.status)).toEqual([
      "answered",
      "expired",
    ]);
    const before = rows(f.db, "ask_edit_effects");
    expect(before).toMatchObject([{ status: "done" }, { status: "pending" }]);
    f.asks.reconcileEdits();
    expect(rows(f.db, "ask_edit_effects")).toEqual(before);
    f.db
      .prepare("DELETE FROM ask_edit_effects WHERE ask_id = ?")
      .run(expiring.askId);
    f.asks.reconcileEdits();
    expect(f.asks.pendingEdits(2)).toMatchObject([
      {
        askId: expiring.askId,
        attempts: 0,
        card: { state: { kind: "expired" } },
      },
    ]);
    f.asks.markEditFailed(
      expiring.askId,
      a.personId,
      Date.parse(expiring.expiresAt) + 2,
    );
    expect(f.asks.pendingEdits(2)).toEqual([]);
    f.setTime(Date.parse(expiring.expiresAt) + 2);
    expect(f.asks.pendingEdits(2)).toMatchObject([
      { askId: expiring.askId, attempts: 1 },
    ]);
    f.asks.markEditDone(expiring.askId, a.personId);
    expect(f.asks.pendingEdits(2)).toEqual([]);
    expect(rows(f.db, "ask_deliveries")[1]?.edited_at).toBe(f.deps.now());
  },
  timeout,
);

test(
  "K7: Slack off leaves the session store usable without ask state",
  async () => {
    const f = await fixture({ slack: { mode: "off", buttons: false } });
    const store = createCoreStore({
      ...f,
      people: configPeople(f.config.people),
    });
    store.syncDirectory();
    expect(store.asks).toBeUndefined();
    expect(value(store.sessions.hello(caller, { host: "t3" })).mode).toBe(
      "reply_only",
    );
    expect(store.sessions.session(bind(f.db, store))?.mode).toBe("normal");
    for (const table of ["asks", "ask_deliveries", "ask_edit_effects"] as const)
      expect(rows(f.db, table)).toEqual([]);
  },
  timeout,
);

test(
  "C2: fake chat emits actions and distinguishes every simulated write",
  async () => {
    const chat = new FakeChatPort();
    const action = button("ask_control", "control");
    const reply = { ephemeralText: action.eventKey };
    await chat.start({
      onAction: (event) => Promise.resolve({ ephemeralText: event.eventKey }),
      onMessage: async () => {},
      onMessageChange: async () => {},
    });
    expect(await chat.emitAction(action)).toEqual(reply);
    const card = {
      askId: "ask_control",
      kind: "work_request",
      projectName: "Fixture Project",
      askedForName: a.displayName,
      issueId: "demo-12",
      question: "What is the next step?",
      choices: [],
      state: { kind: "open", digitFallback: false },
    } as const;
    for (const effect of [
      { kind: "refused" },
      { kind: "refused", retryAfterMs: 30000 },
      { kind: "unknown" },
    ] as const) {
      chat.nextWrite = effect;
      const post = chat.postAskDm(slackA, card);
      await expect(post).rejects.toHaveProperty("effect", effect.kind);
      const key = "retryAfterMs";
      if (key in effect)
        await expect(post).rejects.toHaveProperty(key, effect[key]);
      else await expect(post).rejects.not.toHaveProperty(key);
    }
    expect(chat.writes).toHaveLength(1);
    const gate = Promise.withResolvers<void>();
    chat.nextWrite = { kind: "delay", until: gate.promise };
    let settled = false;
    const pending = chat.postAskDm(slackA, card).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(chat.writes).toHaveLength(2);
    gate.resolve();
    await pending;
    expect(chat.askCards.every((view) => view.issueId === card.issueId)).toBe(
      true,
    );
    expect(chat.calls.map((call) => call.name)).toEqual([
      "start",
      "emitAction",
      ...Array<"postAskDm">(4).fill("postAskDm"),
    ]);
  },
  timeout,
);

test.each([
  ["slack", "telegram"],
  ["telegram", "slack"],
] as const)(
  "Ask edits queued for %s stay hidden from %s after reopening",
  async (original, selected) => {
    const configFor = (adapter: typeof original) => ({
      chat: { adapter },
      slack:
        adapter === "slack"
          ? { mode: "socket" as const, buttons: true, teamId: "T012ABC9XYZ" }
          : { mode: "off" as const, buttons: false },
    });
    const f = await askFixture(new FakeChatPort(), {
      ...configFor(original),
      people: [
        { ...a, slackUserId: slackA, telegramUserId: "123" },
        { ...b, slackUserId: slackB, telegramUserId: "456" },
      ],
    });
    const { askId, expiresAt } = value(await f.choice({ to: [a.personId] }));
    f.setTime(Date.parse(expiresAt) + 1);
    expect(f.asks.sweepExpiry()).toBe(1);
    expect(f.asks.pendingEdits(1)).toMatchObject([{ askId }]);

    closeDb(f.db);
    const db = openDb(f.path);
    const switched = asksOf(
      createCoreStore({
        ...f.deps,
        db,
        config: { ...f.config, ...configFor(selected) },
      }),
    );
    expect(switched.pendingEdits(1)).toEqual([]);

    db.prepare("DELETE FROM ask_edit_effects WHERE ask_id = ?").run(askId);
    switched.reconcileEdits();
    expect(switched.pendingEdits(1)).toEqual([]);
    const restored = asksOf(createCoreStore({ ...f.deps, db }));
    expect(restored.pendingEdits(1)).toMatchObject([{ askId }]);
  },
  timeout,
);
