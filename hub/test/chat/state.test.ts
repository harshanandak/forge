import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, parseMarkdown } from "chat";
import { createSqliteChatState } from "../../src/chat/state.ts";
import { CHAT_STATE_DDL } from "../../src/contract/chat-state.ts";
import type { HubDb, SqlRow, SqlValue } from "../../src/contract/runtime.ts";

const timeout = 30_000;
const cleanup: Array<() => void> = [];

afterEach(() => {
  try {
    for (const close of cleanup.splice(0).reverse()) close();
  } finally {
    setSystemTime();
  }
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "forge-chat-state-"));
  const path = join(directory, "state.sqlite");
  cleanup.push(() => {
    unlinkSync(path);
    rmdirSync(directory);
  });
  return path;
}

function openDb(path = ":memory:", initialize = true): HubDb {
  const database = new Database(path);
  let closed = false;
  const db: HubDb = {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.query<SqlRow, SqlValue[]>(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) ?? undefined,
        all: (...params) => statement.all(...params),
      };
    },
    transaction: (work) => database.transaction(work).immediate(),
    claimWorker() {
      throw new Error("Chat state does not own an effect worker");
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
  cleanup.push(() => db.close());
  db.exec("PRAGMA busy_timeout = 1000");
  if (initialize) for (const sql of CHAT_STATE_DDL) db.exec(sql);
  return db;
}

function queueEntry(id: string, expiresAt: number) {
  return {
    enqueuedAt: Date.now(),
    expiresAt,
    message: new Message({
      id,
      threadId: "thread",
      text: id,
      formatted: parseMarkdown(id),
      raw: { id },
      author: {
        userId: "U0WRITER",
        userName: "writer",
        fullName: "Writer",
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
    }),
  };
}

for (const separateHandles of [false, true]) {
  test(
    `S1 atomic setIfNotExists with ${separateHandles ? "two handles" : "one handle"}`,
    async () => {
      const path = separateHandles ? freshPath() : ":memory:";
      const firstDb = openDb(path);
      const secondDb = separateHandles ? openDb(path, false) : firstDb;
      const first = createSqliteChatState(firstDb);
      const second = createSqliteChatState(secondDb);
      setSystemTime(1_800_000_000_000);
      const [wroteFirst, wroteSecond] = await Promise.all([
        first.setIfNotExists("key", "first", 1_000),
        second.setIfNotExists("key", "second", 1_000),
      ]);
      expect([wroteFirst, wroteSecond].sort()).toEqual([false, true]);
      const winningValue = wroteFirst ? "first" : "second";
      expect(await first.get("key")).toBe(winningValue);
      expect(await second.get("key")).toBe(winningValue);
    },
    timeout,
  );
}

test(
  "S2 expired values and queue entries are absent and expired keys can be claimed",
  async () => {
    const db = openDb();
    const now = 1_800_000_000_000;
    setSystemTime(now);
    const expired = queueEntry("expired", now + 1_000);
    const state = createSqliteChatState(db);
    await state.set("key", "old", 1_000);
    await state.set("live", "retained");
    await state.appendToList("list", "old", { ttlMs: 1_000 });
    await state.enqueue("queue", expired, 3);
    setSystemTime(now + 1_001);
    expect(await state.get("key")).toBeNull();
    expect(await state.setIfNotExists("key", "new")).toBe(true);
    expect(await state.get("key")).toBe("new");
    expect(await state.getList("list")).toEqual([]);
    expect(await state.dequeue("queue")).toBeNull();
    expect(await state.get("live")).toBe("retained");
    await state.delete("key");
    expect(await state.get("key")).toBeNull();
  },
  timeout,
);

test(
  "S3 only a live owner's token can extend or release a lock",
  async () => {
    const db = openDb();
    const now = 1_800_000_000_000;
    setSystemTime(now);
    const state = createSqliteChatState(db);
    const first = await state.acquireLock("thread", 1_000);
    if (!first) throw new Error("first lock was not acquired");
    const wrong = { ...first, token: "different" };
    expect(await state.acquireLock("thread", 1_000)).toBeNull();
    expect(await state.extendLock(wrong, 2_000)).toBe(false);
    await state.releaseLock(wrong);
    expect(await state.acquireLock("thread", 1_000)).toBeNull();
    expect(await state.extendLock(first, 2_000)).toBe(true);
    setSystemTime(now + 1_001);
    expect(await state.acquireLock("thread", 1_000)).toBeNull();
    setSystemTime(now + 2_001);
    expect(await state.extendLock(first, 1_000)).toBe(false);
    expect(db.prepare("select token from chat_locks").all()).toEqual([]);
    const replacement = await state.acquireLock("thread", 1_000);
    if (!replacement) throw new Error("replacement lock was not acquired");
    expect(replacement.token).not.toBe(first.token);
    await state.releaseLock(first);
    expect(await state.acquireLock("thread", 1_000)).toBeNull();
    await state.releaseLock(replacement);
    expect(await state.acquireLock("thread", 1_000)).not.toBeNull();
    await state.forceReleaseLock("thread");
    expect(await state.acquireLock("thread", 1_000)).not.toBeNull();
  },
  timeout,
);

test(
  "S4 lists retain the newest values and dequeue returns the oldest live message",
  async () => {
    const db = openDb();
    const now = 1_800_000_000_000;
    setSystemTime(now);
    const entries = [
      queueEntry("first", now + 900),
      queueEntry("second", now + 900),
      queueEntry("expired", now + 50),
      queueEntry("last", now + 900),
    ];
    const state = createSqliteChatState(db);
    for (let value = 1; value <= 4; value++) {
      await state.appendToList("list", value, { maxLength: 3 });
    }
    expect(await state.getList("list")).toEqual([2, 3, 4]);
    const depths = [];
    for (const entry of entries) {
      depths.push(await state.enqueue("queue", entry, 3));
    }
    expect(depths).toEqual([1, 2, 3, 3]);
    expect(await state.queueDepth("queue")).toBe(3);
    setSystemTime(now + 51);
    expect(await state.queueDepth("queue")).toBe(2);
    const second = await state.dequeue("queue");
    expect(second?.message).toBeInstanceOf(Message);
    expect(second?.message.id).toBe("second");
    expect(second?.message.metadata.dateSent).toEqual(new Date(now));
    expect((await state.dequeue("queue"))?.message.id).toBe("last");
    expect(await state.dequeue("queue")).toBeNull();
  },
  timeout,
);

test(
  "S4 list append refreshes TTL for earlier live entries",
  async () => {
    const db = openDb();
    const now = 1_800_000_000_000;
    setSystemTime(now);
    const state = createSqliteChatState(db);
    await state.appendToList("list", "first", { ttlMs: 100 });
    setSystemTime(now + 80);
    await state.appendToList("list", "second", { ttlMs: 100 });
    setSystemTime(now + 101);
    expect(await state.getList("list")).toEqual(["first", "second"]);
    setSystemTime(now + 181);
    expect(await state.getList("list")).toEqual([]);
  },
  timeout,
);

test(
  "S5 subscriptions are idempotent and survive a database reopen",
  async () => {
    const path = freshPath();
    const db = openDb(path);
    const state = createSqliteChatState(db);
    await state.connect();
    await state.subscribe("thread");
    await state.subscribe("thread");
    expect(
      db.prepare("select thread_id from chat_subscriptions").all(),
    ).toEqual([{ thread_id: "thread" }]);
    await state.disconnect();
    db.close();
    const reopened = createSqliteChatState(openDb(path, false));
    expect(await reopened.isSubscribed("thread")).toBe(true);
    await reopened.unsubscribe("thread");
    expect(await reopened.isSubscribed("thread")).toBe(false);
  },
  timeout,
);
