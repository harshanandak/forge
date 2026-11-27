/// <reference types="bun" />

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { HubDb } from "../../src/contract/runtime.ts";
import { createOpenHubDb } from "../../src/core/db.ts";
import {
  createPrivateDirectory,
  createPrivateFile,
  openHubDb,
  protectPath,
} from "../../src/core/index.ts";
import { probeHubSchema } from "../../src/core/schema-probe.ts";
import { createTestSchema } from "./ddl.ts";
import { schemaFixture } from "./schema-fixture.ts";

const timeout = 30_000;
const { temp, track, close, cleanup } = schemaFixture();

async function dbPath(): Promise<string> {
  const data = join(realpathSync(temp()), "data");
  expect(await createPrivateDirectory(data)).toBe(true);
  return join(data, "hub.sqlite");
}

afterEach(cleanup);

test(
  "keeps SQLite locking when both schema probe timestamps are whole seconds",
  () => {
    const path = join(temp(), "hub.sqlite");
    writeFileSync(path, "fixture", { mode: 0o600 });
    const before = statSync(path, { bigint: true });
    before.mtimeNs = 1_000_000_000n;
    before.ctimeNs = 2_000_000_000n;
    const version = probeHubSchema(
      path,
      before,
      (filename) => {
        expect(filename).toBe(path);
        return 1;
      },
      true,
    );
    expect(version).toBe(1);
  },
  timeout,
);

function inspectImmutableSchema(inspect: (path: string) => 0 | 1): 0 | 1 {
  const path = join(temp(), "hub.sqlite");
  writeFileSync(path, "fixture", { mode: 0o600 });
  const fractionalTime = new Date("2026-01-01T00:00:00.500Z");
  utimesSync(path, fractionalTime, fractionalTime);
  const before = statSync(path, { bigint: true });
  return probeHubSchema(
    path,
    before,
    (filename) => {
      const uri = new URL(filename);
      expect(uri.protocol).toBe("file:");
      expect(uri.searchParams.get("immutable")).toBe("1");
      expect(fileURLToPath(uri)).toBe(path);
      return inspect(path);
    },
    true,
  );
}

test(
  "immutable schema probe returns the inspector's version for an unchanged database",
  () => {
    expect(inspectImmutableSchema(() => 0)).toBe(0);
  },
  timeout,
);

test(
  "immutable schema probe refuses a database replaced during inspection",
  () => {
    expect(() =>
      inspectImmutableSchema((path) => {
        const replacement = join(dirname(path), "replacement.sqlite");
        writeFileSync(replacement, "fixture", { mode: 0o600 });
        renameSync(replacement, path);
        return 1;
      }),
    ).toThrow("Hub database changed during schema inspection");
  },
  timeout,
);

test(
  "immutable schema probe refuses a database resized during inspection",
  () => {
    expect(() =>
      inspectImmutableSchema((path) => {
        writeFileSync(path, "updated fixture");
        return 1;
      }),
    ).toThrow("Hub database changed during schema inspection");
  },
  timeout,
);

test(
  "immutable schema probe refuses a WAL sidecar created during inspection",
  () => {
    expect(() =>
      inspectImmutableSchema((path) => {
        writeFileSync(path + "-wal", "wal fixture", { mode: 0o600 });
        return 1;
      }),
    ).toThrow("Hub database changed during schema inspection");
  },
  timeout,
);

const schemaObjects =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND name NOT GLOB 'sqlite_*' ORDER BY type, name";

function normalizedSchema(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => ({ ...row }));
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
  "H1: creates the frozen schema and reopens with live, leftover and clean WAL state",
  async () => {
    const path = await dbPath();
    const db = track(openHubDb(path));
    const oracle = track(new Database(await dbPath()));
    createTestSchema(oracle, 2);
    const literal = "CHECK (kind = 'Case Sensitive')";
    expect(normalizedSchema([{ sql: literal }])[0]?.sql).toBe(literal);
    const rows = normalizedSchema(db.prepare(schemaObjects).all());
    expect(rows).toEqual(
      normalizedSchema(
        oracle.query<Record<string, unknown>, []>(schemaObjects).all(),
      ),
    );
    expect(rows.filter(({ type }) => type === "table")).toHaveLength(26);
    const names = new Set(rows.map(({ name }) => name));
    expect(names.has("conversations_thread_person")).toBe(true);
    expect(names.has("conversations_thread")).toBe(false);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
    ).toEqual({ value: "2" });
    db.exec("PRAGMA wal_autocheckpoint=0");
    seedPeopleAndProject(db);
    const leftover = await dbPath();
    for (const suffix of ["", "-wal", "-shm"])
      writeFileSync(leftover + suffix, readFileSync(path + suffix), {
        mode: 0o600,
      });
    for (const candidate of [path, leftover]) {
      const reopened = track(openHubDb(candidate));
      expect(reopened.prepare("SELECT person_id FROM people").get()).toEqual({
        person_id: "per_a",
      });
      close(reopened);
    }
    close(db);
    expect(protectPath(path, "file")).toBe(true);
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
  async (phase) => {
    const path = await dbPath();
    const saved = await dbPath();
    const replacement = await dbPath();
    const seed = await createPrivateFile(path);
    if (seed === null) throw new Error("Expected a private database fixture");
    await seed.close();
    const original = track(new Database(path));
    createTestSchema(original);
    close(original);
    const bytes = readFileSync(path);
    writeFileSync(replacement, "", { mode: 0o600 });
    const opens: string[] = [];
    const guardedOpen = createOpenHubDb((target, options) => {
      const mode = options.readOnly ? "read-only" : "read-write";
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

test.skipIf(process.platform === "win32")(
  "Database refuses a readable database or sidecar before opening SQLite",
  async () => {
    const path = await dbPath();
    close(track(openHubDb(path)));
    const guardedOpen = createOpenHubDb(() => {
      throw new Error("SQLite was opened before privacy verification");
    });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = path + suffix;
      if (suffix) writeFileSync(file, "sidecar");
      chmodSync(file, 0o644);
      const bytes = readFileSync(file);
      expect(() => guardedOpen(path)).toThrow(
        "Hub database file is not private",
      );
      expect(readFileSync(file)).toEqual(bytes);
      chmodSync(file, 0o600);
    }
    chmodSync(dirname(path), 0o755);
    expect(() => guardedOpen(path)).toThrow(
      "Hub database directory is not private",
    );
  },
  timeout,
);

test(
  "H2: enforces CLI and agent trust checks and refuses a newer schema without writing",
  async () => {
    const path = await dbPath();
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
    const directory = dirname(path);
    const files = () =>
      readdirSync(directory).map((name) => join(directory, name));
    const before = new Map(files().map((file) => [file, readFileSync(file)]));
    expect(() => close(track(openHubDb(path)))).toThrow(/schema|version/i);
    for (const [file, bytes] of before)
      expect(readFileSync(file)).toEqual(bytes);
    for (const file of files()) {
      if (before.has(file)) continue;
      if (file === path + "-wal") expect(statSync(file).size).toBe(0);
      else expect(file).toBe(path + "-shm");
    }
  },
  timeout,
);

test(
  "refuses an unsupported schema in a crash-leftover WAL without changing data files",
  async () => {
    const path = await dbPath();
    close(track(openHubDb(path)));
    const database = readFileSync(path);
    const writer = fileURLToPath(
      new URL("./schema-crash.fixture.ts", import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      ["run", "--no-env-file", "--no-install", writer, path],
      { encoding: "utf8", env: {}, timeout: 10_000, windowsHide: true },
    );
    if (child.error) throw child.error;
    expect(child.status).not.toBe(0);

    const files = ["hub.sqlite", "hub.sqlite-shm", "hub.sqlite-wal"];
    const directory = dirname(path);
    expect(readdirSync(directory).sort()).toEqual(files);
    expect(readFileSync(path)).toEqual(database);
    const wal = readFileSync(path + "-wal");
    expect(wal.byteLength).toBeGreaterThan(32);

    throws(() => close(track(openHubDb(path))), {
      name: "Error",
      message: "Unsupported hub database schema version",
    });
    expect(readFileSync(path)).toEqual(database);
    expect(readFileSync(path + "-wal")).toEqual(wal);
    expect(readdirSync(directory).sort()).toEqual(files);
  },
  timeout,
);

test(
  "refuses a marker-only database",
  async () => {
    const path = await dbPath();
    const marker = track(new Database(path));
    marker.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1')",
    );
    close(marker);
    chmodSync(path, 0o600);
    expect(() => close(track(openHubDb(path)))).toThrow(
      "Hub database schema is incomplete",
    );
  },
  timeout,
);

test(
  "H3: enforces thread identity, context pairs and per-person conversation uniqueness",
  async () => {
    const db = track(openHubDb(await dbPath()));
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

function seedSlackConversation(db: Pick<HubDb, "exec">) {
  db.exec(`
    INSERT INTO people (person_id, display_name, slack_user_id) VALUES ('per_a', 'A', 'U00000001');
    INSERT INTO projects (project_id, name, front_person_id) VALUES ('prj_a', 'A', 'per_a');
    INSERT INTO sessions (session_id, person_id, host, mode, mode_reason, mode_changed_at, created_at, last_seen_at)
    VALUES ('ses_a', 'per_a', 'claude', 'normal', 'start', 1, 1, 1);
    INSERT INTO conversations VALUES ('conv_a', 'prj_a', 'per_a', 'ses_a', 'slack', 'thread', 'channel', 0, 'slack', 4, 1);
    INSERT INTO inbox_items (item_id, dedupe_key, owner_person_id, conversation_id, project_id, kind, sender_kind,
      sender_name, not_your_owner, text, received_at)
    VALUES ('item_a','dedupe','per_a','conv_a','prj_a','chat_message','person','A',0,'Hello',2);
    INSERT INTO reply_owed VALUES ('item_a', 'ses_a', 'conv_a', 0, 2);
    INSERT INTO thread_messages (seq, adapter, chat_thread_id, channel_id, project_id, kind, text, created_at)
    VALUES (4,'slack','thread','channel','prj_a','system','Hello',2),
      (9,'slack','thread','channel','prj_a','system','Removed fixture',2);
    DELETE FROM thread_messages WHERE seq = 9;
    INSERT INTO asks VALUES ('ask_a','prj_a','choice','choice','ses_a','per_a',0,'Question','[]','["per_a"]',
      NULL,'item_a','answered',1,10);
    INSERT INTO ask_deliveries (ask_id,person_id,delivery_state,chat_thread_id,chat_message_id,channel_id,delivered_at)
    VALUES ('ask_a','per_a','delivered','thread','message','channel',2);
    INSERT INTO ask_answers VALUES ('ask_a','first','per_a',3,'button','event',NULL,NULL);
    INSERT INTO answer_attempts (event_key,ask_id,slack_user_id,choice_id,outcome,at)
    VALUES ('event','ask_a','U00000001','first','locked',3);
  `);
}

function insertConversation(
  db: Pick<HubDb, "prepare">,
  adapter: string,
  source: string,
) {
  return db
    .prepare(
      `
    INSERT INTO conversations VALUES ('conv_' || ?, 'prj_a', 'per_a', 'ses_a', ?, 'thread', 'channel', 0, ?, 4, 1)
  `,
    )
    .run(adapter, adapter, source);
}

test(
  "T1A-MIG1 fresh chat tables allow Slack and Telegram and reject foreign adapters",
  async () => {
    const db = track(openHubDb(await dbPath()));
    seedSlackConversation(db);
    expect(insertConversation(db, "telegram", "telegram").changes).toBe(1);
    expect(() => insertConversation(db, "other", "agent")).toThrow("CHECK");
    const post = db.prepare(`
      INSERT INTO thread_messages (adapter, chat_thread_id, channel_id, project_id, kind, text, created_at)
      VALUES (?, 'thread', 'channel', 'prj_a', 'system', 'Hello', 2)
    `);
    expect(post.run("telegram").changes).toBe(1);
    expect(() => post.run("other")).toThrow("CHECK");
  },
  timeout,
);

test.each([false, true])(
  "T1A-MIG2 upgrades a seeded Slack database atomically (injected failure: %s)",
  async (fail) => {
    const path = await dbPath();
    const file = await createPrivateFile(path);
    if (!file) throw new Error("Expected a private database fixture");
    await file.close();
    const original = track(new DatabaseSync(path));
    createTestSchema(original);
    seedSlackConversation(original);
    const tables = original
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name <> 'meta' ORDER BY name",
      )
      .all();
    const queries = tables.map(({ name }) => {
      if (typeof name !== "string" || !/^\w+$/.test(name))
        throw new Error("Unexpected fixture table name");
      const columns = original
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((row) => row.name)
        .join(", ");
      return `SELECT rowid, ${columns} FROM ${name} ORDER BY rowid`;
    });
    const snapshot = (db: Pick<HubDb, "prepare">) =>
      queries.map((sql) => db.prepare(sql).all());
    const before = snapshot(original);
    if (fail)
      original.exec(`
        CREATE TRIGGER stop_upgrade BEFORE UPDATE ON meta WHEN old.key = 'schema_version'
        BEGIN SELECT RAISE(ABORT, 'version update fault'); END
      `);
    close(original);

    if (fail)
      expect(() => track(openHubDb(path))).toThrow("version update fault");
    const db = fail
      ? track(new DatabaseSync(path, { readOnly: true }))
      : track(openHubDb(path));
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
    ).toEqual({ value: fail ? "1" : "2" });
    if (fail) {
      expect(
        db
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'conversations'")
          .get()?.sql,
      ).toContain("adapter = 'slack'");
      expect(
        db
          .prepare("PRAGMA table_info(ask_deliveries)")
          .all()
          .map(({ name }) => name),
      ).not.toContain("adapter");
    } else {
      expect(insertConversation(db, "telegram", "telegram").changes).toBe(1);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(
        db
          .prepare(
            `
        INSERT INTO thread_messages (adapter, chat_thread_id, channel_id, project_id, kind, text, created_at)
        VALUES ('telegram','thread','channel','prj_a','system','Hello',2)
      `,
          )
          .run().lastInsertRowid,
      ).toBe(10);
    }
  },
  timeout,
);
