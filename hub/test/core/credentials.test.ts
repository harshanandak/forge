import { expect, test } from "bun:test";
import { createCredentialStore } from "../../src/core/credentials.ts";
import { syncDirectory } from "../../src/core/directory.ts";
import {
  a,
  b,
  closeDb,
  configPeople,
  fixture,
  openDb,
  seedDirectory,
} from "./fixture.ts";

const timeout = 30_000;
const hash = (digit: string) => digit.repeat(64);
test(
  "T1: credentials keep only hashes and refuse revoked or removed identities",
  async () => {
    const f = await fixture();
    seedDirectory(f.db);
    f.db.exec(`
    INSERT INTO sessions (session_id,person_id,host,mode,mode_reason,mode_changed_at,created_at,last_seen_at)
    VALUES ('ses_b','per_b','claude','reply_only','unbound_start',1,1,1);
    INSERT INTO asks (ask_id,project_id,kind,requested_action,from_session_id,from_person_id,
      from_session_untrusted_seq,question,choices_json,allowed_json,status,created_at,expires_at)
    VALUES ('ask_b','prj_one','choice','choice','ses_b','per_b',0,'sample','[]','[]','open',1,2);
  `);
    const store = createCredentialStore({ ...f, people: configPeople([a, b]) });
    const token = store.createToken(a.personId, "first", hash("1"));
    const key = store.createHostKey(a.personId, "host", hash("2"));
    if (!token || !key) throw new Error("Missing credential");
    expect(token).toMatchObject({
      personId: a.personId,
      label: "first",
      tokenHash: hash("1"),
    });
    expect(key).toMatchObject({
      personId: a.personId,
      label: "host",
      keyHash: hash("2"),
    });
    expect(store.findToken(hash("1"))).toEqual(token);
    expect(store.findHostKey(hash("2"))).toEqual(key);
    expect(store.isTokenCurrent(token.tokenId)).toBe(true);
    expect(
      f.db.prepare("SELECT token_hash,last_used_at FROM tokens").get(),
    ).toEqual({ token_hash: hash("1"), last_used_at: f.now() });
    expect(
      f.db.prepare("SELECT key_hash,last_used_at FROM host_keys").get(),
    ).toEqual({ key_hash: hash("2"), last_used_at: f.now() });
    expect(store.revokeToken(token.tokenId)).toBe(true);
    expect(store.revokeHostKey(key.hostInstanceId)).toBe(true);
    expect(store.findToken(hash("1"))).toBeUndefined();
    expect(store.findHostKey(hash("2"))).toBeUndefined();
    expect(store.isTokenCurrent(token.tokenId)).toBe(false);
    const other = store.createToken(b.personId, "second", hash("3"));
    expect(other).toBeDefined();
    expect(store.createHostKey(b.personId, "second", hash("4"))).toBeDefined();
    closeDb(f.db);
    const db = openDb(f.path);
    const restarted = createCredentialStore({
      ...f,
      db,
      people: configPeople([a]),
    });
    expect(restarted.findToken(hash("3"))).toBeUndefined();
    expect(restarted.findHostKey(hash("4"))).toBeUndefined();
    expect(restarted.isTokenCurrent(other?.tokenId ?? "")).toBe(false);
    const tables = ["people", "sessions", "asks", "tokens", "host_keys"];
    for (const table of tables) {
      const column = table === "asks" ? "from_person_id" : "person_id";
      const sql =
        "SELECT count(*) AS n FROM " + table + " WHERE " + column + " = ?";
      expect(db.prepare(sql).get(b.personId)?.n).toBe(1);
    }
  },
  timeout,
);

test(
  "T2: an unknown person cannot create either credential",
  async () => {
    const f = await fixture();
    const store = createCredentialStore({ ...f, people: configPeople([a]) });
    expect(store.createToken(b.personId, "token", hash("5"))).toBeUndefined();
    expect(store.createHostKey(b.personId, "host", hash("6"))).toBeUndefined();
    expect(f.db.prepare("SELECT * FROM tokens").all()).toEqual([]);
    expect(f.db.prepare("SELECT * FROM host_keys").all()).toEqual([]);
  },
  timeout,
);

test(
  "T9: directory sync admits null Slack bindings and preserves unique bindings",
  async () => {
    const f = await fixture();
    const projects = f.config.projects.map(
      ({ projectId, name, frontPersonId }) => ({
        projectId,
        name,
        frontPersonId,
        memberIds: [a.personId],
      }),
    );
    syncDirectory(f.db, { ...f.config, people: [a, b], projects });
    expect(
      f.db.prepare("SELECT slack_user_id FROM people ORDER BY person_id").all(),
    ).toEqual([{ slack_user_id: null }, { slack_user_id: null }]);
    const emptyBinding = { slack_channel_id: null, summary_channel_id: null };
    expect(
      f.db
        .prepare("SELECT slack_channel_id,summary_channel_id FROM projects")
        .all(),
    ).toEqual([emptyBinding, emptyBinding]);
    f.db.exec(
      "UPDATE people SET slack_user_id = 'U00000001' WHERE person_id = 'per_a'",
    );
    expect(() =>
      f.db.exec("INSERT INTO people VALUES ('per_c','Duplicate','U00000001')"),
    ).toThrow(/UNIQUE constraint failed: people\.slack_user_id/);
    expect(() =>
      f.db.exec(
        "INSERT INTO projects (project_id,name,slack_channel_id,front_person_id) VALUES ('prj_bad','Bad','C00000001','per_a')",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(f.db.prepare("SELECT count(*) AS n FROM people").get()?.n).toBe(2);
    expect(f.db.prepare("SELECT count(*) AS n FROM projects").get()?.n).toBe(2);
  },
  timeout,
);
