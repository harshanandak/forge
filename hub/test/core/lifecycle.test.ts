import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import type { EffectSchedule } from "../../src/core/effects.ts";
import type { FakeChatPort } from "../fakes/fake-chat.ts";
import { until } from "./base-fakes.ts";
import { p1 } from "./fixture.ts";
import { holdFirstSummaryEdit } from "./life-fakes.ts";
import { lifeFixture } from "./life-fixture.ts";

const timeout = 30_000;
const sweepMs = 60_000;
const closeMs = 5_000;
const dayMs = 86_400_000;

function fakeScheduler() {
  let elapsed = 0;
  const pending = new Set<{ at: number; run: () => void }>();
  const schedule: EffectSchedule = (run, delayMs) => {
    const timer = { at: elapsed + delayMs, run };
    pending.add(timer);
    return () => {
      pending.delete(timer);
    };
  };
  function advance(ms: number) {
    const end = elapsed + ms;
    for (;;) {
      const next = [...pending].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      elapsed = next.at;
      pending.delete(next);
      next.run();
    }
    elapsed = end;
  }
  return { schedule, advance };
}

function holdNextAskEdit(chat: FakeChatPort) {
  const gate = Promise.withResolvers<void>();
  const edit = chat.editAskDm.bind(chat);
  const calls = () =>
    chat.calls.filter(({ name }) => name === "editAskDm").length;
  const before = calls();
  chat.editAskDm = (ref, card) => {
    chat.editAskDm = edit;
    chat.nextWrite = { kind: "delay", until: gate.promise };
    return edit(ref, card);
  };
  return { started: () => calls() > before, release: gate.resolve };
}

test(
  "E4 startup edits the replacement summary before the next report",
  async () => {
    const timers = fakeScheduler();
    const f = await lifeFixture(timers.schedule);
    f.queueSummary();
    await f.worker.drain();
    const row =
      "SELECT publication_key, revision, published_revision, chat_message_id FROM summaries WHERE project_id = ?";
    expect(f.rows(row, p1)).toEqual([
      {
        publication_key: f.publicationKey,
        revision: 1,
        published_revision: 1,
        chat_message_id: f.ref.chatMessageId,
      },
    ]);
    const replacement = {
      ...f.ref,
      chatThreadId: "3.000001",
      chatMessageId: "3.000001",
    };
    const reopened = await f.reopen(replacement);
    const edit = holdFirstSummaryEdit(reopened.chat);

    await reopened.worker.start();
    try {
      await until(
        () => reopened.chat.calls.some(({ name }) => name === "editSummary"),
        2_000,
      );
      const rebound = {
        publication_key: f.publicationKey,
        revision: 1,
        chat_message_id: replacement.chatMessageId,
      };
      expect(reopened.rows(row, p1)).toEqual([
        { ...rebound, published_revision: 0 },
      ]);
      expect(
        reopened.rows(
          "SELECT target_revision, status FROM summary_effects WHERE project_id = ?",
          p1,
        ),
      ).toEqual([{ target_revision: 1, status: "pending" }]);
      expect(
        reopened.chat.calls.filter(({ name }) => name !== "start"),
      ).toMatchObject([
        { name: "editSummary", args: [replacement, { revision: 1 }] },
      ]);
      edit.release();
      await reopened.worker.drain();
      expect(reopened.rows(row, p1)).toEqual([
        { ...rebound, published_revision: 1 },
      ]);
    } finally {
      edit.release();
      await reopened.worker.close();
    }
  },
  timeout,
);

test(
  "E7 startup reconciles persisted work, sweeps every minute and bounds close",
  async () => {
    const timers = fakeScheduler();
    const f = await lifeFixture(timers.schedule);
    const db = f.openPeer();
    const { owner, sessionId } = f.bind();
    const interrupted = await f.workRequest(owner, sessionId, "demo-21");
    const expired = await f.workRequest(owner, sessionId, "demo-22");
    const terminal = await f.workRequest(owner, sessionId, "demo-23");
    await f.answer(owner, terminal, "decline");
    db.prepare(
      "UPDATE ask_deliveries SET delivery_state = 'posting', channel_id = NULL, chat_thread_id = NULL, chat_message_id = NULL, delivered_at = NULL WHERE ask_id = ?",
    ).run(interrupted);
    db.prepare("UPDATE asks SET expires_at = ? WHERE ask_id = ?").run(
      f.now() + 3 * sweepMs,
      interrupted,
    );
    db.prepare("DELETE FROM ask_edit_effects WHERE ask_id = ?").run(terminal);
    f.advance(sweepMs);
    f.queueSummary();
    const startupEdit = holdNextAskEdit(f.chat);
    let releasePeriodic = () => {};

    await f.worker.start();
    try {
      await until(startupEdit.started, 2_000);
      expect(
        f.rows(
          "SELECT delivery_state FROM ask_deliveries WHERE ask_id = ?",
          interrupted,
        ),
      ).toEqual([{ delivery_state: "unknown" }]);
      const askStatus = "SELECT status FROM asks WHERE ask_id = ?";
      expect(f.rows(askStatus, expired)).toEqual([{ status: "expired" }]);
      expect(
        f.rows(
          "SELECT ask_id, status FROM ask_edit_effects WHERE ask_id IN (?, ?) ORDER BY ask_id",
          expired,
          terminal,
        ),
      ).toEqual(
        [expired, terminal]
          .sort()
          .map((ask_id) => ({ ask_id, status: "pending" })),
      );
      startupEdit.release();
      await f.worker.drain();
      expect(
        f.chat.writes.filter(({ name }) => name === "editSummary"),
      ).toMatchObject([{ args: [f.ref, { revision: 1 }] }]);

      const periodic = await f.workRequest(owner, sessionId, "demo-24");
      const periodicEdit = holdNextAskEdit(f.chat);
      releasePeriodic = periodicEdit.release;
      f.advance(sweepMs - 1);
      timers.advance(sweepMs - 1);
      expect(f.rows(askStatus, periodic)).toEqual([{ status: "open" }]);
      f.advance(1);
      timers.advance(1);
      await until(periodicEdit.started, 2_000);
      expect(f.rows(askStatus, periodic)).toEqual([{ status: "expired" }]);

      let closed = false;
      const closing = f.worker.close().then(() => {
        closed = true;
      });
      timers.advance(closeMs - 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      timers.advance(1);
      await until(() => closed, 2_000);
      await closing;
    } finally {
      startupEdit.release();
      releasePeriodic();
      await f.worker.close();
    }

    const early = await lifeFixture(timers.schedule);
    early.queueSummary();
    const lastEdit = holdFirstSummaryEdit(early.chat);
    await early.worker.start();
    let settled = false;
    try {
      await until(
        () => early.chat.calls.some(({ name }) => name === "editSummary"),
        2_000,
      );
      const closing = early.worker.close().then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      lastEdit.release();
      await until(() => settled, 2_000);
      await closing;
    } finally {
      lastEdit.release();
      await early.worker.close();
    }
  },
  timeout,
);

test(
  "TH8 retention keeps only the newest recent thread rows and is idempotent",
  async () => {
    const timers = fakeScheduler();
    const f = await lifeFixture(timers.schedule);
    const db = f.openPeer();
    const insert = db.prepare(`
    INSERT INTO thread_messages
      (adapter, chat_thread_id, channel_id, project_id, chat_message_id, kind, text, created_at)
    VALUES ('slack', ?, 'C00000001', ?, ?, 'system', 'fixture', ?)
  `);
    db.transaction(() => {
      for (let i = 0; i < LIMITS.threadKeep + 10; i++)
        insert.run("thread-main", p1, String(i), f.now());
      insert.run(
        "thread-main",
        p1,
        "old",
        f.now() - (LIMITS.threadKeepDays + 1) * dayMs,
      );
      insert.run("thread-other", p1, "keep", f.now());
    });
    const rows = () =>
      f.rows(
        "SELECT chat_thread_id, chat_message_id FROM thread_messages ORDER BY seq",
      );
    const kept = [
      ...Array.from({ length: LIMITS.threadKeep }, (_, i) => ({
        chat_thread_id: "thread-main",
        chat_message_id: String(i + 10),
      })),
      { chat_thread_id: "thread-other", chat_message_id: "keep" },
    ];

    await f.worker.start();
    try {
      expect(rows()).toEqual(kept);
      insert.run(
        "thread-other",
        p1,
        "old-later",
        f.now() - (LIMITS.threadKeepDays + 1) * dayMs,
      );
      f.advance(sweepMs);
      timers.advance(sweepMs);
      await f.worker.drain();
      expect(rows()).toEqual(kept);
    } finally {
      await f.worker.close();
    }
  },
  timeout,
);
