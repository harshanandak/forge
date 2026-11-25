/// <reference types="bun" />

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestSchema } from "./ddl.ts";
import { schemaFixture } from "./schema-fixture.ts";

const timeout = 30_000;
const { temp, track, cleanup } = schemaFixture();

afterEach(cleanup);

test(
  "C1: the independent schema admits just one answer across two raw connections",
  () => {
    const path = join(temp(), "hub.sqlite");
    const first = track(new Database(path));
    createTestSchema(first);
    first.exec(`
    INSERT INTO people (person_id, display_name) VALUES ('per_a', 'A');
    INSERT INTO projects (project_id, name, front_person_id) VALUES ('prj_a', 'A', 'per_a');
    INSERT INTO sessions (session_id, person_id, host, mode, mode_reason,
      mode_changed_at, created_at, last_seen_at)
    VALUES ('ses_a', 'per_a', 'claude', 'normal', 'start', 1, 1, 1);
    INSERT INTO asks (ask_id, project_id, kind, requested_action, from_session_id,
      from_person_id, from_session_untrusted_seq, question, choices_json, allowed_json,
      status, created_at, expires_at)
    VALUES ('ask_a', 'prj_a', 'choice', 'choice', 'ses_a', 'per_a', 0, 'Question', '[]',
      '[]', 'open', 1, 2);
  `);
    const second = track(new Database(path));
    second.exec("PRAGMA foreign_keys=ON");
    const insert = `INSERT INTO ask_answers
    (ask_id, choice_id, answered_by_person_id, answered_at, source, event_key)
    VALUES ('ask_a', ?, 'per_a', 1, 'button', ?) ON CONFLICT(ask_id) DO NOTHING`;
    expect(first.query(insert).run("first", "event-a").changes).toBe(1);
    expect(second.query(insert).run("second", "event-b").changes).toBe(0);
    expect(second.query("SELECT choice_id FROM ask_answers").all()).toEqual([
      { choice_id: "first" },
    ]);
  },
  timeout,
);
