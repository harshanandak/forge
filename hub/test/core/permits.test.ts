import { expect, test } from "bun:test";
import { renderAskCard } from "../../src/chat/cards.ts";
import { renderTelegramAskCard } from "../../src/chat/telegram-cards.ts";
import { WORK_REQUEST_CHOICES } from "../../src/contract/domain.ts";
import { SECRET_REMOVED_TEXT } from "../../src/contract/errors.ts";
import { a, p1, p2, caller, seedItem, value } from "./fixture.ts";
import { askFixture, button, refA, rows, slackA } from "./fakes.ts";

const timeout = 30_000;

test(
  "initial choice card redacts the caller name in Slack and Telegram",
  async () => {
    const f = await askFixture();
    const displayName = "xapp" + "-" + "fixture".repeat(3);
    const { askId } = value(
      await f.choice({}, { ...caller, person: { ...a, displayName } }),
    );
    const card = f.chat.askCards[0]!;
    const heading = `Ask for ${SECRET_REMOVED_TEXT}`;
    expect({
      view: card.askId === askId && card.askedForName === SECRET_REMOVED_TEXT,
      slack: JSON.stringify(renderAskCard(card)).includes(heading),
      telegram: renderTelegramAskCard(card).text.startsWith(heading),
    }).toEqual({ view: true, slack: true, telegram: true });
  },
  timeout,
);

test(
  "P1: an explicit issue request always goes to the owner",
  async () => {
    const f = await askFixture();
    expect(await f.request({}, false)).toMatchObject({
      ok: false,
      error: { code: "WORK_REQUEST_SOURCE_INVALID" },
    });
    for (const [field, input] of [
      ["to", { to: [a.personId] }],
      ["choices", { choices: WORK_REQUEST_CHOICES }],
    ] as const)
      expect(await f.request(input)).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID", pointer: "/" + field },
      });
    expect(rows(f.db, "asks")).toEqual([]);
    expect(f.chat.calls).toEqual([]);
    const result = value(await f.request());
    expect(result.deliveredTo).toEqual([refA]);
    expect(f.chat.askCards).toMatchObject([
      {
        kind: "work_request",
        issueId: "demo-12",
        choices: WORK_REQUEST_CHOICES,
      },
    ]);
    expect(f.chat.askCards[0]?.requesterName).toBeUndefined();
    expect(rows(f.db, "permits")).toEqual([]);
  },
  timeout,
);

test(
  "P2: only a delivered untrusted item in this session chain and project qualifies",
  async () => {
    const f = await askFixture();
    const unrelated = f.store.sessions.createUnboundSession(a, p1, "t3");
    const chain = f.store.sessions.createUnboundSession(a, p1, "t3");
    const child = value(
      f.store.sessions.hello(caller, {
        host: "t3",
        parentSessionId: chain.sessionId,
      }),
    );
    seedItem(f.db, "itm_own", { delivered: chain.sessionId });
    f.db.exec(
      "UPDATE inbox_items SET not_your_owner = 0, sender_person_id = 'per_a' WHERE item_id = 'itm_own'",
    );
    seedItem(f.db, "itm_pending");
    seedItem(f.db, "itm_unrelated", { delivered: unrelated.sessionId });
    seedItem(f.db, "itm_valid", { delivered: child.sessionId });
    const request = (inboxItemId: string, projectId = p1) =>
      f.request({ sessionId: chain.sessionId, inboxItemId, projectId }, false);
    for (const [id, project] of [
      ["itm_own", p1],
      ["itm_pending", p1],
      ["itm_unrelated", p1],
      ["itm_valid", p2],
    ])
      expect(await request(id!, project)).toMatchObject({
        error: { code: "WORK_REQUEST_SOURCE_INVALID" },
      });
    expect(rows(f.db, "asks")).toEqual([]);
    expect(f.chat.calls).toEqual([]);
    expect(value(await request("itm_valid")).deliveredTo).toEqual([refA]);
    expect(f.chat.askCards[0]).toMatchObject({
      requesterName: "Fixture Beta",
      choices: WORK_REQUEST_CHOICES,
    });
    expect(f.chat.askCards[0]?.issueId).toBeUndefined();
  },
  timeout,
);

test(
  "work-request cards redact the sender name from a legacy inbox item",
  async () => {
    const f = await askFixture();
    const inboxItemId = "itm_legacy";
    const legacyName = "xapp" + "-" + "fixture".repeat(3);
    seedItem(f.db, inboxItemId, { delivered: f.sessionId });
    f.db
      .prepare("UPDATE inbox_items SET sender_name = ? WHERE item_id = ?")
      .run(legacyName, inboxItemId);
    const { askId, expiresAt } = value(await f.request({ inboxItemId }, false));
    f.setTime(Date.parse(expiresAt));
    expect(f.asks.sweepExpiry()).toBe(1);
    for (const table of [
      "asks",
      "ask_deliveries",
      "ask_edit_effects",
    ] as const) {
      const records = rows(f.db, table);
      expect(records).toMatchObject([{ ask_id: askId }]);
      expect(JSON.stringify(records).includes(legacyName)).toBe(false);
    }
    const cards = [
      ...f.chat.askCards,
      ...f.asks.pendingEdits(2).map(({ card }) => card),
    ].map((card) => ({
      state: card.state.kind,
      redacted: card.requesterName === "[possible secret removed]",
      slackSafe: !JSON.stringify(renderAskCard(card)).includes(legacyName),
      telegramSafe: !renderTelegramAskCard(card).text.includes(legacyName),
    }));
    expect(cards).toEqual([
      { state: "open", redacted: true, slackSafe: true, telegramSafe: true },
      { state: "expired", redacted: true, slackSafe: true, telegramSafe: true },
    ]);
  },
  timeout,
);

test(
  "P3: only the owner's work approval creates a scoped permit",
  async () => {
    const f = await askFixture();
    expect(f.store.sessions.session(f.sessionId)).toMatchObject({
      mode: "normal",
      untrustedReadSeq: 0,
    });
    expect(rows(f.db, "permits")).toEqual([]);
    for (const choice of ["first", "decline", "clarify", "approve"]) {
      const { askId } = value(
        choice === "first"
          ? await f.choice({ issueId: "demo-12" })
          : await f.request(),
      );
      expect(
        f.asks.answerAction(button(askId, choice, slackA, choice)).after?.askId,
      ).toBe(askId);
      const permit = f.asks.findApprovedPermit(a.personId, p1, askId);
      if (choice !== "approve") expect(permit).toBeUndefined();
      else
        expect(permit).toMatchObject({
          scope: { kind: "request", askId, issueId: "demo-12" },
          source: "approved_request",
          evidence: "owner_approval",
          personId: a.personId,
          projectId: p1,
        });
    }
    expect(rows(f.db, "permits")).toMatchObject([
      { source: "approved_request", evidence: "owner_approval" },
    ]);
    const approved = f.asks
      .answerRows(f.sessionId, 10)
      .find(({ view }) => view.permitId);
    expect(approved?.view).toMatchObject({
      choiceId: "approve",
      answeredBy: refA,
    });
    const remove = f.db.prepare(
      "DELETE FROM project_members WHERE project_id = ? AND person_id = ?",
    );
    remove.run(p1, a.personId);
    expect(f.asks.answerRows(f.sessionId, 10)).toEqual([]);
    expect(rows(f.db, "ask_answers")).toHaveLength(4);
    f.setTime(f.deps.now() + 1);
    const other = value(await f.request({ projectId: p2 }));
    f.asks.answerAction(button(other.askId, "P3-other", slackA, "approve"));
    expect(
      f.asks.answerRows(f.sessionId, 1).map(({ view }) => view.askId),
    ).toEqual([other.askId]);
  },
  timeout,
);
