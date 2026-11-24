/// <reference types="bun" />

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HubDb } from "../../src/contract/runtime.ts";
import { createOpenHubDb } from "../../src/core/db.ts";
import { openHubDb } from "../../src/core/index.ts";
import { createTestSchema } from "./ddl.ts";

const timeout = 30_000;
const paths: string[] = [];
const handles = new Set<{ close(): void }>();

function dbPath(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "forge-hub-schema-")));
  paths.push(dir);
  return join(dir, "hub.sqlite");
}

function track<T extends { close(): void }>(db: T): T {
  handles.add(db);
  return db;
}

function close(db: { close(): void }): void {
  handles.delete(db);
  db.close();
}

afterEach(() => {
  for (const db of handles) close(db);
  for (const dir of paths.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const schemaObjects =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND name NOT GLOB 'sqlite_*' ORDER BY type, name";

function normalizedSchema(rows: readonly Record<string, unknown>[]) {
  return rows.map(({ type, name, tbl_name, sql }) => ({
    type,
    name,
    tbl_name,
    sql:
      typeof sql === "string"
        ? sql.trim().replace(/\s+/g, " ").toLowerCase()
        : sql,
  }));
}

function seedPeopleAndProject(db: HubDb): void {
  db.exec(`
    INSERT INTO people (person_id, display_name) VALUES ('per_a', 'A'), ('per_b', 'B');
    INSERT INTO projects (project_id, name, front_person_id) VALUES ('prj_a', 'A', 'per_a');
  `);
}

function insertInbox(db: HubDb) {
  return db.prepare(`
    INSERT INTO inbox_items (item_id, dedupe_key, owner_person_id, kind, sender_kind,
      sender_name, not_your_owner, text, received_at, context_from_seq, context_to_seq)
    VALUES (?, ?, 'per_a', ?, ?, 'sender', ?, 'message', 1, ?, ?)
  `);
}

test(
  "H1: creates the frozen schema and reopens without changing it",
  () => {
    const path = dbPath();
    const db = track(openHubDb(path));
    const oracle = track(new Database(dbPath()));
    createTestSchema(oracle);
    const rows = normalizedSchema(db.prepare(schemaObjects).all());
    expect(rows).toEqual(
      normalizedSchema(
        oracle.query<Record<string, unknown>, []>(schemaObjects).all(),
      ),
    );
    expect(rows.filter(({ type }) => type === "table")).toHaveLength(26);
    expect(
      rows.some(({ name }) => name === "conversations_thread_person"),
    ).toBe(true);
    expect(rows.some(({ name }) => name === "conversations_thread")).toBe(
      false,
    );
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
    ).toEqual({ value: "1" });
    close(db);
    const bytes = readFileSync(path);
    const reopened = track(openHubDb(path));
    expect(normalizedSchema(reopened.prepare(schemaObjects).all())).toEqual(
      rows,
    );
    close(reopened);
    expect(readFileSync(path)).toEqual(bytes);
  },
  timeout,
);

test.each(["read-only", "read-write"] as const)(
  "Database refuses a replacement at the %s open before writing",
  (phase) => {
    const path = dbPath();
    const saved = dbPath();
    const replacement = dbPath();
    const original = track(new Database(path));
    original.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    `);
    close(original);
    const bytes = readFileSync(path);
    writeFileSync(replacement, "", { mode: 0o600 });
    const opens: string[] = [];
    const guardedOpen = createOpenHubDb((target, options) => {
      const mode = options?.readOnly ? "read-only" : "read-write";
      opens.push(mode);
      if (mode === phase) {
        renameSync(target, saved);
        renameSync(replacement, target);
      }
      return new DatabaseSync(target, options);
    });
    expect(() => track(guardedOpen(path))).toThrow(
      "Hub database file identity changed",
    );
    expect(opens).toEqual(
      phase === "read-only" ? ["read-only"] : ["read-only", "read-write"],
    );
    expect(readFileSync(saved)).toEqual(bytes);
    expect(readFileSync(path)).toHaveLength(0);
  },
  timeout,
);

test(
  "H2: enforces CLI and agent trust checks and refuses a newer schema without writing",
  () => {
    const path = dbPath();
    const db = track(openHubDb(path));
    seedPeopleAndProject(db);
    const insert = insertInbox(db);
    expect(() =>
      insert.run("inb_a", "a", "cli_message", "agent", 1, null, null),
    ).toThrow();
    expect(() =>
      insert.run("inb_b", "b", "cli_message", "cli", 0, null, null),
    ).toThrow();
    expect(() =>
      insert.run("inb_c", "c", "agent_message", "agent", 0, null, null),
    ).toThrow();
    expect(
      Number(
        insert.run("inb_d", "d", "cli_message", "cli", 1, null, null).changes,
      ),
    ).toBe(1);
    db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    close(db);
    const bytes = readFileSync(path);
    expect(() => {
      const reopened = track(openHubDb(path));
      close(reopened);
    }).toThrow(/schema|version/i);
    expect(readFileSync(path)).toEqual(bytes);
  },
  timeout,
);

test(
  "H3: enforces thread identity, context pairs and per-person conversation uniqueness",
  () => {
    const db = track(openHubDb(dbPath()));
    seedPeopleAndProject(db);
    const thread = db.prepare(`
    INSERT INTO thread_messages (adapter, chat_thread_id, channel_id, project_id,
      chat_message_id, kind, person_id, text, created_at)
    VALUES ('slack', 'thread', 'channel', 'prj_a', ?, ?, ?, ?, 1)
  `);
    expect(() => thread.run("ref-a", "outsider", null, "visible")).toThrow();
    expect(() => thread.run("ref-b", "person", null, "message")).toThrow();
    expect(() => thread.run("ref-c", "agent", null, "message")).toThrow();
    expect(
      Number(thread.run("ref-d", "person", "per_a", "message").changes),
    ).toBe(1);
    expect(() => thread.run("ref-d", "person", "per_b", "duplicate")).toThrow();
    expect(Number(thread.run(null, "system", null, "first").changes)).toBe(1);
    expect(Number(thread.run(null, "system", null, "second").changes)).toBe(1);
    expect(
      db.prepare("SELECT kind, text FROM thread_messages ORDER BY seq").all(),
    ).toEqual([
      { kind: "person", text: "message" },
      { kind: "system", text: "first" },
      { kind: "system", text: "second" },
    ]);
    expect(() =>
      insertInbox(db).run("inb_a", "a", "cli_message", "cli", 1, 1, null),
    ).toThrow();
    const conversation = db.prepare(`
    INSERT INTO conversations (conversation_id, person_id, adapter, chat_thread_id,
      channel_id, is_direct, created_by, created_at)
    VALUES (?, ?, 'slack', 'thread', 'channel', 0, 'slack', 1)
  `);
    expect(Number(conversation.run("cnv_a", "per_a").changes)).toBe(1);
    expect(() => conversation.run("cnv_b", "per_a")).toThrow();
    expect(Number(conversation.run("cnv_c", "per_b").changes)).toBe(1);
    expect(
      db
        .prepare(
          "SELECT conversation_id FROM conversations ORDER BY conversation_id",
        )
        .all(),
    ).toEqual([{ conversation_id: "cnv_a" }, { conversation_id: "cnv_c" }]);
  },
  timeout,
);
