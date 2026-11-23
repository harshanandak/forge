import { randomUUID } from "node:crypto";
import {
  Message,
  type QueueEntry,
  type SerializedMessage,
  type StateAdapter,
} from "chat";
import type { HubDb, SqlValue } from "../contract/runtime.ts";

function encode(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("invalid_chat_state");
  return json;
}

function decode<T = unknown>(json: SqlValue | undefined): T {
  if (typeof json !== "string") throw new Error("invalid_chat_state");
  const value: unknown = JSON.parse(json);
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedMessage(value: unknown): value is SerializedMessage {
  if (!isRecord(value)) return false;
  const { author, metadata, formatted, attachments, replyTo, links } = value;
  return (
    value._type === "chat:Message" &&
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.text === "string" &&
    (value.isMention === undefined || typeof value.isMention === "boolean") &&
    isRecord(author) &&
    typeof author.userId === "string" &&
    typeof author.userName === "string" &&
    typeof author.fullName === "string" &&
    (typeof author.isBot === "boolean" || author.isBot === "unknown") &&
    typeof author.isMe === "boolean" &&
    isRecord(metadata) &&
    typeof metadata.dateSent === "string" &&
    Number.isFinite(Date.parse(metadata.dateSent)) &&
    typeof metadata.edited === "boolean" &&
    (metadata.editedAt === undefined ||
      (typeof metadata.editedAt === "string" &&
        Number.isFinite(Date.parse(metadata.editedAt)))) &&
    isRecord(formatted) &&
    formatted.type === "root" &&
    Array.isArray(formatted.children) &&
    Array.isArray(attachments) &&
    (links === undefined || Array.isArray(links)) &&
    (replyTo === undefined || isSerializedMessage(replyTo))
  );
}

function readQueueEntry(value: SqlValue | undefined): QueueEntry {
  const entry = decode(value);
  if (
    !isRecord(entry) ||
    typeof entry.enqueuedAt !== "number" ||
    !Number.isSafeInteger(entry.enqueuedAt) ||
    typeof entry.expiresAt !== "number" ||
    !Number.isSafeInteger(entry.expiresAt) ||
    !isSerializedMessage(entry.message)
  )
    throw new Error("invalid_chat_state");
  return {
    enqueuedAt: entry.enqueuedAt,
    expiresAt: entry.expiresAt,
    message: Message.fromJSON(entry.message),
  };
}

function sqlite<T>(operation: () => T): Promise<T> {
  return new Promise((resolve) => resolve(operation()));
}

export function createSqliteChatState(db: HubDb): StateAdapter {
  const prepare = (sql: string) => db.prepare(sql);
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    get: <T = unknown>(key: string) =>
      sqlite(() => {
        const row = prepare(
          "select value_json from chat_kv where key = ? and (expires_at is null or expires_at > ?)",
        ).get(key, Date.now());
        return row ? decode<T>(row.value_json) : null;
      }),
    set: (key, value, ttlMs) =>
      sqlite(() => {
        const expiry = ttlMs === undefined ? null : Date.now() + ttlMs;
        prepare(
          `insert into chat_kv (key, value_json, expires_at) values (?, ?, ?)
         on conflict (key) do update set value_json = excluded.value_json, expires_at = excluded.expires_at`,
        ).run(key, encode(value), expiry);
      }),
    setIfNotExists: (key, value, ttlMs) =>
      sqlite(() => {
        const now = Date.now();
        const expiry = ttlMs === undefined ? null : now + ttlMs;
        const { changes } = prepare(
          `insert into chat_kv (key, value_json, expires_at) values (?, ?, ?)
         on conflict (key) do update set value_json = excluded.value_json, expires_at = excluded.expires_at
         where chat_kv.expires_at <= ?`,
        ).run(key, encode(value), expiry, now);
        return Number(changes) === 1;
      }),
    delete: (key) =>
      sqlite(() => {
        prepare("delete from chat_kv where key = ?").run(key);
      }),
    appendToList: (key, value, { maxLength, ttlMs } = {}) =>
      sqlite(() => {
        const now = Date.now();
        const expiry = ttlMs === undefined ? null : now + ttlMs;
        const json = encode(value);
        db.transaction(() => {
          prepare(
            "delete from chat_lists where key = ? and expires_at <= ?",
          ).run(key, now);
          prepare(
            `insert into chat_lists (key, seq, value_json, expires_at)
           select ?, coalesce(max(seq), 0) + 1, ?, ? from chat_lists where key = ?`,
          ).run(key, json, expiry, key);
          if (expiry !== null) {
            prepare("update chat_lists set expires_at = ? where key = ?").run(
              expiry,
              key,
            );
          }
          if (maxLength !== undefined) {
            prepare(
              `delete from chat_lists where key = ? and seq in
             (select seq from chat_lists where key = ? order by seq desc limit -1 offset ?)`,
            ).run(key, key, maxLength);
          }
        });
      }),
    getList: <T = unknown>(key: string) =>
      sqlite(() =>
        prepare(
          `select value_json from chat_lists where key = ? and (expires_at is null or expires_at > ?)
         order by seq`,
        )
          .all(key, Date.now())
          .map((row) => decode<T>(row.value_json)),
      ),
    acquireLock: (threadId, ttlMs) =>
      sqlite(() => {
        const now = Date.now();
        const token = randomUUID();
        const expiresAt = now + ttlMs;
        const { changes } = prepare(
          `insert into chat_locks (thread_id, token, expires_at) values (?, ?, ?)
         on conflict (thread_id) do update set token = excluded.token, expires_at = excluded.expires_at
         where chat_locks.expires_at <= ?`,
        ).run(threadId, token, expiresAt, now);
        return Number(changes) === 1 ? { threadId, token, expiresAt } : null;
      }),
    extendLock: ({ threadId, token }, ttlMs) =>
      sqlite(() => {
        const now = Date.now();
        return db.transaction(() => {
          prepare(
            "delete from chat_locks where thread_id = ? and token = ? and expires_at <= ?",
          ).run(threadId, token, now);
          const { changes } = prepare(
            "update chat_locks set expires_at = ? where thread_id = ? and token = ? and expires_at > ?",
          ).run(now + ttlMs, threadId, token, now);
          return Number(changes) === 1;
        });
      }),
    releaseLock: ({ threadId, token }) =>
      sqlite(() => {
        prepare("delete from chat_locks where thread_id = ? and token = ?").run(
          threadId,
          token,
        );
      }),
    forceReleaseLock: (threadId) =>
      sqlite(() => {
        prepare("delete from chat_locks where thread_id = ?").run(threadId);
      }),
    subscribe: (threadId) =>
      sqlite(() => {
        prepare(
          "insert into chat_subscriptions (thread_id) values (?) on conflict (thread_id) do nothing",
        ).run(threadId);
      }),
    unsubscribe: (threadId) =>
      sqlite(() => {
        prepare("delete from chat_subscriptions where thread_id = ?").run(
          threadId,
        );
      }),
    isSubscribed: (threadId) =>
      sqlite(() =>
        Boolean(
          prepare("select 1 from chat_subscriptions where thread_id = ?").get(
            threadId,
          ),
        ),
      ),
    enqueue: (threadId, entry, maxSize) =>
      sqlite(() => {
        const now = Date.now();
        return db.transaction(() => {
          prepare(
            "delete from chat_queue where thread_id = ? and expires_at <= ?",
          ).run(threadId, now);
          if (entry.expiresAt > now) {
            prepare(
              `insert into chat_queue (thread_id, seq, entry_json, expires_at)
             select ?, coalesce(max(seq), 0) + 1, ?, ? from chat_queue where thread_id = ?`,
            ).run(threadId, encode(entry), entry.expiresAt, threadId);
          }
          prepare(
            `delete from chat_queue where thread_id = ? and seq in
           (select seq from chat_queue where thread_id = ? order by seq desc limit -1 offset ?)`,
          ).run(threadId, threadId, maxSize);
          const row = prepare(
            "select count(*) as depth from chat_queue where thread_id = ?",
          ).get(threadId);
          return Number(row?.depth);
        });
      }),
    dequeue: (threadId) =>
      sqlite(() => {
        const now = Date.now();
        return db.transaction(() => {
          prepare(
            "delete from chat_queue where thread_id = ? and expires_at <= ?",
          ).run(threadId, now);
          const row = prepare(
            `delete from chat_queue where thread_id = ? and seq =
           (select min(seq) from chat_queue where thread_id = ?) returning entry_json`,
          ).get(threadId, threadId);
          return row ? readQueueEntry(row.entry_json) : null;
        });
      }),
    queueDepth: (threadId) =>
      sqlite(() => {
        const row = prepare(
          "select count(*) as depth from chat_queue where thread_id = ? and expires_at > ?",
        ).get(threadId, Date.now());
        return Number(row?.depth);
      }),
  };
}
