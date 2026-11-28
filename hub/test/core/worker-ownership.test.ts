import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createSlackChatPort } from "../../src/chat/index.ts";
import type { HubDb } from "../../src/contract/runtime.ts";
import type { EffectSchedule } from "../../src/core/effects.ts";
import { fixtureSecret, ref as slackRef, testDb } from "../chat/fixtures.ts";
import { fakeSlackServer } from "../fakes/fake-slack-server.ts";
import { configPeople, openDb, p1 } from "./fixture.ts";
import { lifeFixture } from "./life-fixture.ts";
import { holdFirstAskEdit, holdFirstSummaryEdit } from "./life-fakes.ts";

const timeout = 30_000;
const closeMs = 5_000;
const lockRefusal = /effect worker lock/i;
const effects = "SELECT status, attempts FROM summary_effects";
const idleSchedule: EffectSchedule = () => () => {};

type Life = Awaited<ReturnType<typeof lifeFixture>>;
type HeldWrite = ReturnType<typeof holdFirstSummaryEdit>;

async function drainAcrossBoundary(
  boundary: Life,
  edit: HeldWrite,
  expire: () => void,
): Promise<void> {
  const draining = boundary.worker.drain();
  try {
    await edit.started;
    const closing = boundary.worker.close();
    expire();
    edit.release();
    await draining;
    await closing;
  } finally {
    edit.release();
    await draining;
    await boundary.worker.close();
  }
}

async function transactionBoundaryWorker(f: Life) {
  let expired = false;
  const peer = f.openPeer();
  const db: HubDb = {
    ...peer,
    transaction<T>(work: () => T): T {
      return peer.transaction(() => {
        if (expired) f.advance(closeMs + 1);
        return work();
      });
    },
  };
  return {
    boundary: await f.anotherWorker(db),
    expire: () => {
      expired = true;
    },
  };
}

test.each([
  { handle: "the same handle", enter: "start" },
  { handle: "a separate handle", enter: "drain" },
] as const)(
  "W1 refuses $enter on $handle before changing the owner's work",
  async ({ handle, enter }) => {
    const timers: number[] = [];
    const owner = await lifeFixture((_run, delay) => {
      timers.push(delay);
      return () => {};
    });
    const peer = await owner.anotherWorker(
      handle === "the same handle" ? undefined : owner.openPeer(),
    );
    const db = owner.openPeer();
    const { owner: caller, sessionId } = owner.bind();
    const askId = await owner.workRequest(caller, sessionId, "demo-24");
    await owner.worker.drain();
    await owner.worker.start();
    await owner.worker.drain();
    const posting =
      "SELECT delivery_state FROM ask_deliveries WHERE ask_id = ?";
    db.prepare(
      "UPDATE ask_deliveries SET delivery_state = 'posting', channel_id = NULL, chat_thread_id = NULL, chat_message_id = NULL, delivered_at = NULL WHERE ask_id = ?",
    ).run(askId);
    owner.queueSummary();
    const edit = holdFirstSummaryEdit(owner.chat);
    const draining = owner.worker.drain();
    try {
      await edit.started;
      const scheduled = [...timers];
      const calls = [...peer.chat.calls];
      await expect(peer.worker[enter]()).rejects.toThrow(lockRefusal);
      expect(timers).toEqual(scheduled);
      expect(peer.chat.calls).toEqual(calls);
      expect(owner.rows(posting, askId)).toEqual([
        { delivery_state: "posting" },
      ]);
      expect(owner.rows(effects)).toEqual([{ status: "pending", attempts: 0 }]);

      edit.release();
      await draining;
      expect(owner.rows(effects)).toEqual([{ status: "done", attempts: 0 }]);
      expect(
        owner.chat.writes.filter(({ name }) => name === "editSummary"),
      ).toHaveLength(1);
    } finally {
      edit.release();
      await draining;
      await peer.worker.close();
      await owner.worker.close();
    }
  },
  timeout,
);

test(
  "W3 refuses a pre-existing lock file or directory and preserves it",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const lock = f.path + ".worker.lock";
    try {
      await writeFile(lock, "previous owner", { flag: "wx", mode: 0o600 });
      await expect(f.worker.start()).rejects.toThrow(lockRefusal);
      expect(await readFile(lock, "utf8")).toBe("previous owner");
      const directory = await lifeFixture(idleSchedule);
      try {
        const lock = directory.path + ".worker.lock";
        await mkdir(lock, { mode: 0o700 });
        await expect(directory.worker.drain()).rejects.toThrow(lockRefusal);
        expect((await lstat(lock)).isDirectory()).toBe(true);
      } finally {
        await directory.worker.close();
      }
    } finally {
      await f.worker.close();
    }
  },
  timeout,
);

test.skipIf(process.platform === "win32")(
  "W3 refuses a dangling symlink without writing through it",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const lock = f.path + ".worker.lock";
    const target = lock + ".missing";
    await symlink(target, lock);
    try {
      await expect(f.worker.drain()).rejects.toThrow(lockRefusal);
      expect((await lstat(lock)).isSymbolicLink()).toBe(true);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.worker.close();
    }
  },
  timeout,
);

test(
  "W3 leaves a replacement lock intact on release",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const lock = f.path + ".worker.lock";
    await f.worker.drain();
    const stat = await lstat(lock);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    await rename(lock, lock + ".original");
    await writeFile(lock, "replacement", { flag: "wx", mode: 0o600 });
    await expect(f.worker.close()).rejects.toThrow(lockRefusal);
    expect(await readFile(lock, "utf8")).toBe("replacement");
  },
  timeout,
);

test(
  "W3 lets two distinct database files in one directory own workers",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const other = await f.anotherWorker(openDb(f.path + ".other"));
    try {
      await f.worker.start();
      await other.worker.start();
      expect((await lstat(f.path + ".worker.lock")).isFile()).toBe(true);
      expect((await lstat(f.path + ".other.worker.lock")).isFile()).toBe(true);
    } finally {
      await f.worker.close();
      await other.worker.close();
    }
  },
  timeout,
);

test(
  "W4 bounded close keeps ownership through the active edit and skips late completion",
  async () => {
    const timers = new Map<number, () => void>();
    const f = await lifeFixture((run, delay) => {
      timers.set(delay, run);
      return () => {
        timers.delete(delay);
      };
    });
    const replacement = await f.anotherWorker(f.openPeer());
    f.queueSummary();
    const edit = holdFirstSummaryEdit(f.chat);
    const draining = f.worker.drain();
    try {
      await edit.started;
      let closed = false;
      const closing = f.worker.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect([...timers.keys()]).toEqual([closeMs]);
      timers.get(closeMs)?.();
      await closing;
      expect(closed).toBe(true);
      const calls = [...replacement.chat.calls];
      await expect(replacement.worker.start()).rejects.toThrow(lockRefusal);
      expect(replacement.chat.calls).toEqual(calls);

      edit.release();
      await draining;
      expect(f.rows(effects)).toEqual([{ status: "pending", attempts: 0 }]);
      expect(
        f.rows(
          "SELECT published_revision FROM summaries WHERE project_id = ?",
          p1,
        ),
      ).toEqual([{ published_revision: 0 }]);
      await replacement.worker.start();
      await replacement.worker.drain();
      expect(replacement.chat.writes.map(({ name }) => name)).toEqual([
        "editSummary",
      ]);
      expect(f.rows(effects)).toEqual([{ status: "done", attempts: 0 }]);
    } finally {
      edit.release();
      await draining;
      await f.worker.close();
      await replacement.worker.close();
    }
  },
  timeout,
);

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

test(
  "W5 releases the lock when startup fails after ownership",
  async () => {
    let startupSchedule = true;
    const schedule: EffectSchedule = () => {
      if (startupSchedule) {
        startupSchedule = false;
        throw new Error("injected startup failure");
      }
      return () => {};
    };
    const owner = await lifeFixture(schedule);
    const replacement = await owner.anotherWorker(owner.openPeer());
    try {
      await expect(owner.worker.start()).rejects.toThrow(
        "injected startup failure",
      );
      await expect(replacement.worker.start()).resolves.toBeUndefined();
    } finally {
      await owner.worker.close();
      await replacement.worker.close();
    }
  },
  timeout,
);

test(
  "W6 stops a write continuation after the close deadline before the timer fires",
  async () => {
    const timers = new Map<number, () => void>();
    const f = await lifeFixture((run, delay) => {
      timers.set(delay, run);
      return () => {
        timers.delete(delay);
      };
    });
    f.queueSummary();
    const edit = holdFirstSummaryEdit(f.chat);
    const draining = f.worker.drain();
    try {
      await edit.started;
      const closing = f.worker.close();
      f.advance(closeMs + 1);
      edit.release();
      await draining;
      await closing;
      expect(f.rows(effects)).toEqual([{ status: "pending", attempts: 0 }]);
      expect(
        f.rows(
          "SELECT published_revision FROM summaries WHERE project_id = ?",
          p1,
        ),
      ).toEqual([{ published_revision: 0 }]);
    } finally {
      edit.release();
      await draining;
      await f.worker.close();
    }
  },
  timeout,
);

test(
  "W7 returns a refused report wait without the summary timeout",
  async () => {
    const owner = await lifeFixture(idleSchedule);
    const peer = await owner.anotherWorker(owner.openPeer());
    try {
      await owner.worker.drain();
      const session = peer.bind();
      const requestAskId = await peer.workRequest(
        session.owner,
        session.sessionId,
        "demo-31",
      );
      await peer.answer(session.owner, requestAskId, "approve");
      let settled = false;
      let summary: string | undefined;
      const report = peer.report(session.owner, {
        sessionId: session.sessionId,
        requestAskId,
        issueId: "demo-31",
        projectId: p1,
        state: "working",
        text: "Reviewing the approved work.",
      });
      void report.then((result) => {
        settled = true;
        summary = result.ok ? result.value.summary : result.error.code;
      });
      await flushMicrotasks();
      expect(settled).toBe(true);
      expect(summary).toBe("queued");
      await report;
    } finally {
      await peer.worker.close();
      await owner.worker.close();
    }
  },
  timeout,
);

test(
  "W8 releases the lock when close timer cancellation throws",
  async () => {
    const timers = new Map<number, () => void>();
    let cancelCalls = 0;
    const schedule: EffectSchedule = (run, delay) => {
      timers.set(delay, run);
      if (delay === closeMs)
        return () => {
          cancelCalls += 1;
          throw new Error("injected cancel failure");
        };
      return () => {
        timers.delete(delay);
      };
    };
    const f = await lifeFixture(schedule);
    const replacement = await f.anotherWorker(f.openPeer());
    f.queueSummary();
    const edit = holdFirstSummaryEdit(f.chat);
    const draining = f.worker.drain();
    try {
      await edit.started;
      const closing = f.worker.close();
      timers.get(closeMs)?.();
      edit.release();
      await draining;
      await closing;
      expect(cancelCalls).toBe(1);
      await expect(replacement.worker.start()).resolves.toBeUndefined();
    } finally {
      edit.release();
      await draining;
      await f.worker.close();
      await replacement.worker.close();
    }
  },
  timeout,
);

test(
  "W9 keeps the normal start write and close path unchanged",
  async () => {
    const f = await lifeFixture(idleSchedule);
    f.queueSummary();
    await f.worker.start();
    await f.worker.drain();
    expect(f.rows(effects)).toEqual([{ status: "done", attempts: 0 }]);
    expect(
      f.rows(
        "SELECT published_revision FROM summaries WHERE project_id = ?",
        p1,
      ),
    ).toEqual([{ published_revision: 1 }]);
    expect(f.chat.writes.map(({ name }) => name)).toEqual(["editSummary"]);
    await expect(f.worker.close()).resolves.toBeUndefined();
  },
  timeout,
);

test(
  "W10 does not acquire a new lock after close",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const replacement = await f.anotherWorker(f.openPeer());
    try {
      await f.worker.start();
      await f.worker.close();
      f.worker.prepare();
      await f.worker.close();
      await expect(replacement.worker.start()).resolves.toBeUndefined();
    } finally {
      await f.worker.close();
      await replacement.worker.close();
    }
  },
  timeout,
);

test(
  "W11 carries the close deadline through Slack summary history",
  async () => {
    const f = await (await lifeFixture(idleSchedule)).reopen(slackRef);
    await using slack = await fakeSlackServer();
    const chatDb = testDb(":memory:", true);
    const historyStarted = Promise.withResolvers<void>();
    const releaseHistory = Promise.withResolvers<void>();
    const chat = createSlackChatPort({
      config: f.config,
      db: chatDb,
      log: f.log,
      people: configPeople(f.config.people),
      secret: fixtureSecret,
      slackApiUrl: slack.url,
    });
    f.chat.editSummary = chat.editSummary.bind(chat);
    slack.script("conversations.history", {
      started: () => historyStarted.resolve(),
      until: releaseHistory.promise,
      result: {
        ok: true,
        messages: [
          {
            ts: slackRef.chatMessageId,
            user: "U0BOT",
            bot_id: "B0FORGE",
            text: "Fixture One",
            blocks: [
              {
                type: "context",
                elements: [{ type: "mrkdwn", text: "forge-summary:sum_valid" }],
              },
            ],
          },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      },
    });
    f.queueSummary();
    const draining = f.worker.drain();
    try {
      await historyStarted.promise;
      const closing = f.worker.close();
      f.advance(closeMs + 1);
      releaseHistory.resolve();
      await draining;
      await closing;
      expect(slack.only("chat.update")).toEqual([]);
      expect(f.rows(effects)).toEqual([{ status: "pending", attempts: 0 }]);
      expect(
        f.rows(
          "SELECT published_revision FROM summaries WHERE project_id = ?",
          p1,
        ),
      ).toEqual([{ published_revision: 0 }]);
    } finally {
      releaseHistory.resolve();
      await draining;
      await f.worker.close();
      chatDb.close();
    }
  },
  timeout,
);

test(
  "W12 skips summary completion when the deadline passes in the transaction",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const { boundary, expire } = await transactionBoundaryWorker(f);
    boundary.queueSummary();
    const edit = holdFirstSummaryEdit(boundary.chat);
    await drainAcrossBoundary(boundary, edit, expire);
    expect(boundary.rows(effects)).toEqual([
      { status: "pending", attempts: 0 },
    ]);
    expect(
      boundary.rows(
        "SELECT published_revision FROM summaries WHERE project_id = ?",
        p1,
      ),
    ).toEqual([{ published_revision: 0 }]);
  },
  timeout,
);

test(
  "W13 skips failure bookkeeping when the deadline passes in the transaction",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const { boundary, expire } = await transactionBoundaryWorker(f);
    boundary.queueSummary();
    const queuedAt = boundary.now();
    const edit = holdFirstSummaryEdit(boundary.chat, "unknown");
    await drainAcrossBoundary(boundary, edit, expire);
    expect(
      boundary.rows(
        "SELECT status, attempts, next_attempt_at FROM summary_effects",
      ),
    ).toEqual([{ status: "pending", attempts: 0, next_attempt_at: queuedAt }]);
  },
  timeout,
);

test(
  "W14 skips ask completion when the deadline passes in the transaction",
  async () => {
    const f = await lifeFixture(idleSchedule);
    const { boundary, expire } = await transactionBoundaryWorker(f);
    const session = boundary.bind();
    const askId = await boundary.workRequest(
      session.owner,
      session.sessionId,
      "demo-2078",
    );
    await boundary.answer(session.owner, askId, "approve");
    const edit = holdFirstAskEdit(boundary.chat);
    await drainAcrossBoundary(boundary, edit, expire);
    expect(
      boundary.rows(
        "SELECT status, attempts FROM ask_edit_effects WHERE ask_id = ?",
        askId,
      ),
    ).toEqual([{ status: "pending", attempts: 0 }]);
    expect(
      boundary.rows(
        "SELECT edited_at FROM ask_deliveries WHERE ask_id = ?",
        askId,
      ),
    ).toEqual([{ edited_at: null }]);
  },
  timeout,
);
