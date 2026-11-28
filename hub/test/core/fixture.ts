import { afterEach } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PeopleDirectory } from "../../src/contract/domain.ts";
import type { HubResult } from "../../src/contract/core.ts";
import type { HubConfig, HubDb, HubLog } from "../../src/contract/runtime.ts";
import { openHubDb, createPrivateDirectory } from "../../src/core/index.ts";
import { createSessionStore } from "../../src/core/sessions.ts";
import { hubTestTemp } from "../temp.ts";
import { configFixture } from "./config-fixture.ts";

const paths = new Set<string>();
const handles = new Set<HubDb>();
const cleanups = new Set<() => Promise<void>>();

export const a = { personId: "per_a", displayName: "Fixture Alpha" };
export const b = { personId: "per_b", displayName: "Fixture Beta" };
export const p1 = "prj_one";
export const p2 = "prj_two";
export const caller = { person: a, tokenId: "tok_a" };
export const secretName = "xapp" + "-" + "fixture".repeat(3);
export const secretCaller = {
  ...caller,
  person: { ...a, displayName: secretName },
};

export function openDb(path: string): HubDb {
  const db = openHubDb(path);
  handles.add(db);
  return db;
}

export function closeDb(db: HubDb): void {
  handles.delete(db);
  db.close();
}

afterEach(async () => {
  const pending = [...cleanups];
  cleanups.clear();
  try {
    await Promise.all(pending.map((close) => close()));
  } finally {
    for (const db of handles) closeDb(db);
    for (const path of paths) await rm(path, { recursive: true, force: true });
    paths.clear();
  }
});

export function onFixtureCleanup(close: () => Promise<void>): () => void {
  cleanups.add(close);
  return () => {
    cleanups.delete(close);
  };
}

export async function fixture(change: Partial<HubConfig> = {}) {
  const root = hubTestTemp("forge-hub-sessions-");
  paths.add(root);
  const dataDir = join(realpathSync(root), "data");
  if (!(await createPrivateDirectory(dataDir)))
    throw new Error("Private test directory is unavailable");
  const path = join(dataDir, "hub.sqlite");
  const db = openDb(path);
  const config: HubConfig = { ...configFixture(), ...change, dataDir };
  const logged: unknown[] = [];
  const record: HubLog["info"] = (event, fields) =>
    logged.push([event, fields]);
  const log = { info: record, warn: record, error: record };
  return { root, path, db, config, now: () => 1234, logged, log };
}

export function seedDirectory(db: HubDb): void {
  db.exec(`
    INSERT INTO people VALUES ('per_a', 'Fixture Alpha', 'U00000001'),
      ('per_b', 'Fixture Beta', 'U00000002'), ('per_c', 'Fixture Gamma', 'U00000003');
    INSERT INTO projects (project_id,name,purpose,front_person_id) VALUES
      ('prj_one','Fixture One','Shared project context','per_a'),
      ('prj_two','Fixture Two',NULL,'per_a');
    INSERT INTO project_members VALUES ('prj_one','per_a'), ('prj_one','per_b'),
      ('prj_two','per_a'), ('prj_two','per_c');
  `);
}

export function seedHost(db: HubDb, id = "hst_a"): void {
  db.prepare(
    "INSERT INTO host_keys (host_instance_id,person_id,label,key_hash,created_at) VALUES (?,'per_a','fixture',?,1)",
  ).run(id, "hash_" + id);
}

export function seedRemovedMemberName(db: HubDb, personId: string): void {
  db.prepare("UPDATE people SET display_name = ? WHERE person_id = ?").run(
    secretName,
    personId,
  );
  db.prepare("DELETE FROM project_members WHERE person_id = ?").run(personId);
}

export function seedItem(
  db: HubDb,
  itemId: string,
  options: {
    readonly projectId?: string;
    readonly target?: string;
    readonly delivered?: string;
    readonly held?: boolean;
    readonly senderName?: string;
  } = {},
): void {
  db.prepare(
    `
    INSERT INTO inbox_items
      (item_id,dedupe_key,owner_person_id,target_session_id,project_id,kind,sender_kind,sender_person_id,
       sender_name,not_your_owner,held,text,received_at,delivered_at,delivered_to_session_id)
    VALUES (?,?,'per_a',?,?,'chat_message','person','per_b',?,1,?,'sample message',1,?,?)
  `,
  ).run(
    itemId,
    itemId,
    options.target ?? null,
    options.projectId ?? p1,
    options.senderName ?? "Fixture Beta",
    Number(options.held ?? false),
    options.delivered ? 1 : null,
    options.delivered ?? null,
  );
}

export function value<T>(result: HubResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

export function configPeople(people: HubConfig["people"]): PeopleDirectory {
  return {
    all: () => people,
    byPersonId: (id: string) => people.find((person) => person.personId === id),
    byChatUserId: (adapter, id) =>
      people.find(
        (person) =>
          (adapter === "slack" ? person.slackUserId : person.telegramUserId) ===
          id,
      ),
    bySlackUserId: (id: string) =>
      people.find((person) => person.slackUserId === id),
  };
}

export async function sessionFixture(change: Partial<HubConfig> = {}) {
  const f = await fixture(change);
  seedDirectory(f.db);
  const people = configPeople(f.config.people);
  return { ...f, sessions: createSessionStore({ ...f, people }) };
}
