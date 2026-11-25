export const CHAT_STATE_TABLES = [
  "chat_kv",
  "chat_lists",
  "chat_locks",
  "chat_queue",
  "chat_subscriptions",
] as const;
export const CHAT_DEDUPE_TTL_MS = 86_400_000;
export const CHAT_STATE_DDL: readonly string[] = [
  "create table chat_kv (key text primary key not null, value_json text not null, expires_at integer)",
  "create table chat_lists (key text not null, seq integer not null, value_json text not null, expires_at integer, primary key (key, seq))",
  "create table chat_locks (thread_id text primary key not null, token text not null, expires_at integer not null)",
  "create table chat_queue (thread_id text not null, seq integer not null, entry_json text not null, expires_at integer not null, primary key (thread_id, seq))",
  "create table chat_subscriptions (thread_id text primary key not null)",
];
