import { expect, test } from "bun:test";
import { a, b, p1 } from "./fixture.ts";
import { lifeFixture } from "./life-fixture.ts";

const timeout = 30_000;
const editRows =
  "SELECT person_id, status, attempts, next_attempt_at FROM ask_edit_effects WHERE ask_id = ? ORDER BY person_id";
const cooldown = "SELECT value FROM meta WHERE key = 'chat_update_not_before'";

test(
  "E1 edits both delivered DMs after reopening the database",
  async () => {
    const f = await lifeFixture();
    const askId = await f.answerChoice([a.personId, b.personId]);
    const answerRows = "SELECT * FROM ask_answers WHERE ask_id = ?";
    const deliveryRows =
      "SELECT person_id, channel_id, chat_thread_id, chat_message_id, edited_at FROM ask_deliveries WHERE ask_id = ? ORDER BY person_id";
    const answer = f.rows(answerRows, askId);
    const deliveries = f.rows(deliveryRows, askId);
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({
      choice_id: "first",
      answered_by_person_id: a.personId,
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((row) => row.edited_at === null)).toBe(true);
    expect(f.rows(editRows, askId)).toMatchObject([
      { person_id: a.personId, status: "pending" },
      { person_id: b.personId, status: "pending" },
    ]);
    expect(
      f.chat.calls.filter((call) => call.name === "editAskDm"),
    ).toHaveLength(0);

    const reopened = await f.reopen();
    await reopened.worker.drain();

    expect(reopened.chat.writes).toHaveLength(2);
    const editedRefs = reopened.chat.writes.map(
      ({ name, args: [ref, card] }) => {
        expect(name).toBe("editAskDm");
        expect(card).toMatchObject({ askId, state: { kind: "answered" } });
        return ref;
      },
    );
    for (const row of deliveries)
      expect(editedRefs).toContainEqual({
        channelId: row.channel_id,
        chatThreadId: row.chat_thread_id,
        chatMessageId: row.chat_message_id,
      });
    expect(reopened.rows(editRows, askId)).toMatchObject([
      { person_id: a.personId, status: "done" },
      { person_id: b.personId, status: "done" },
    ]);
    expect(reopened.rows(deliveryRows, askId)).toEqual(
      deliveries.map((row) => ({ ...row, edited_at: reopened.now() })),
    );
    expect(reopened.rows(answerRows, askId)).toEqual(answer);
  },
  timeout,
);

test(
  "E5 backs off six refused ask edits and caps the delay at ten minutes",
  async () => {
    const f = await lifeFixture();
    const askId = await f.answerChoice();
    const writes = [...f.chat.writes];
    const calls = () =>
      f.chat.calls.filter((call) => call.name === "editAskDm");
    for (const [index, delay] of [
      1_000, 5_000, 30_000, 120_000, 600_000, 600_000,
    ].entries()) {
      f.chat.nextWrite = { kind: "refused" };
      await f.worker.drain();
      expect(f.rows(editRows, askId)).toEqual([
        {
          person_id: a.personId,
          status: "pending",
          attempts: index + 1,
          next_attempt_at: f.now() + delay,
        },
      ]);
      expect(calls()).toHaveLength(index + 1);

      f.advance(delay - 1);
      await f.worker.drain();
      expect(calls()).toHaveLength(index + 1);
      f.advance(1);
    }
    expect(f.chat.writes).toEqual(writes);
  },
  timeout,
);

test.each([
  { failure: 1, retryAfterMs: 30_000 },
  { failure: 3, retryAfterMs: 120_000 },
])(
  "E6 honors Retry-After on ask edit failure $failure",
  async ({ failure, retryAfterMs }) => {
    const f = await lifeFixture();
    const askId = await f.answerChoice();
    const writes = [...f.chat.writes];
    if (failure === 3) {
      for (const delay of [1_000, 5_000]) {
        f.chat.nextWrite = { kind: "refused" };
        await f.worker.drain();
        f.advance(delay);
      }
    }
    f.chat.nextWrite = { kind: "refused", retryAfterMs };
    await f.worker.drain();

    const [row] = f.rows(editRows, askId);
    expect(row).toMatchObject({ status: "pending", attempts: failure });
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(f.now() + retryAfterMs);
    expect(f.chat.writes).toEqual(writes);
  },
  timeout,
);

test(
  "CD1 shares the persisted cooldown across both edits and preserves a longer deadline",
  async () => {
    const f = await lifeFixture();
    const askId = await f.answerChoice();
    const summary =
      "SELECT status, attempts FROM summary_effects WHERE project_id = ?";
    const resumeAt = f.now() + 30_000;
    const edits = (run: typeof f) =>
      run.chat.calls
        .map((call) => call.name)
        .filter((name) => name === "editAskDm" || name === "editSummary");

    f.chat.nextWrite = { kind: "refused", retryAfterMs: 30_000 };
    await f.worker.drain();
    expect(f.rows(cooldown)).toEqual([{ value: String(resumeAt) }]);
    f.queueSummary();
    await f.worker.drain();
    expect(edits(f)).toEqual(["editAskDm"]);
    expect(f.chat.writes.map((call) => call.name)).toEqual(["postAskDm"]);

    const reopened = await f.reopen();
    reopened.advance(29_999);
    await reopened.worker.drain();
    expect(edits(reopened)).toEqual([]);
    expect(reopened.rows(cooldown)).toEqual([{ value: String(resumeAt) }]);
    expect(reopened.rows(editRows, askId)).toMatchObject([
      { status: "pending", attempts: 1 },
    ]);
    expect(reopened.rows(summary, p1)).toEqual([
      { status: "pending", attempts: 0 },
    ]);

    reopened.advance(1);
    await reopened.worker.drain();
    expect(edits(reopened).sort()).toEqual(["editAskDm", "editSummary"]);
    expect(reopened.rows(editRows, askId)).toMatchObject([{ status: "done" }]);
    expect(reopened.rows(summary, p1)).toMatchObject([{ status: "done" }]);

    const nextAskId = await reopened.answerChoice();
    const writes = [...reopened.chat.writes];
    const peer = reopened.openPeer();
    const longerDeadline = reopened.now() + 20_000;
    const edit = reopened.chat.editAskDm.bind(reopened.chat);
    reopened.chat.editAskDm = (ref, card) => {
      peer
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('chat_update_not_before', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(longerDeadline));
      reopened.chat.nextWrite = { kind: "refused", retryAfterMs: 1_000 };
      return edit(ref, card);
    };
    await reopened.worker.drain();
    expect(reopened.rows(cooldown)).toEqual([
      { value: String(longerDeadline) },
    ]);
    expect(reopened.rows(editRows, nextAskId)).toMatchObject([
      { status: "pending", attempts: 1 },
    ]);
    reopened.advance(19_999);
    await reopened.worker.drain();
    expect(edits(reopened).sort()).toEqual([
      "editAskDm",
      "editAskDm",
      "editSummary",
    ]);
    expect(reopened.chat.writes).toEqual(writes);
  },
  timeout,
);
