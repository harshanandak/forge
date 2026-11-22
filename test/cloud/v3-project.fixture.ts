import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import type { DurableState } from "../../cloud/src/store.ts";
import { sealOf, signRow } from "../../cloud/src/v3-seal.ts";
import { browserStorage } from "./browser-storage.fixture.ts";

export const probe = "test-v3";
export const sqlMutation =
  /^\s*(ALTER|CREATE|DELETE|DROP|INSERT|REPLACE|UPDATE)\b/i;
export const noWrites = {
  sqlWriteAttempts: 0,
  alarmWrites: 0,
  sqlAndKvIntact: true,
};

export interface SealSetup {
  key?: string | null;
  previous?: string;
  id?: string | null;
}
export const newKey = () => randomBytes(32).toString("base64url");

export function fixture(
  before?: (sql: string) => void,
  env?: unknown,
  setup: SealSetup = {},
) {
  const {
    key = newKey(),
    previous,
    id = randomBytes(32).toString("hex"),
  } = setup;
  const sealed = {
    ...(env as Record<string, unknown> | undefined),
    ...(key === null ? {} : { V3_SEAL_KEY: key }),
    ...(previous === undefined ? {} : { V3_SEAL_KEY_PREVIOUS: previous }),
  };
  const db = new Database(":memory:");
  const { storage, values } = browserStorage(db, before);
  const reads = { rows: 0, bytes: 0 };
  const exec = storage.sql.exec.bind(storage.sql);
  storage.sql.exec = (statement, ...bindings) => {
    const rows = exec(statement, ...bindings).toArray();
    reads.rows += rows.length;
    for (const value of rows.flatMap((row) => Object.values(row)))
      reads.bytes +=
        typeof value === "string"
          ? Buffer.byteLength(value)
          : value instanceof Uint8Array
            ? value.byteLength
            : typeof value === "number"
              ? 8
              : 0;
    return { toArray: () => rows };
  };
  const alarms: number[] = [];
  storage.getAlarm = () => Promise.resolve(alarms.at(-1) ?? null);
  storage.setAlarm = (time) => {
    alarms.push(time);
    return Promise.resolve();
  };
  const context: DurableState = {
    storage,
    testV3: true,
    ...(id === null ? {} : { id: { toString: () => id } }),
  };
  let project = new Project(context, sealed);
  const seal = () => sealOf(sealed, context.id);
  const sign = (sequence: number, body: string) =>
    signRow(
      seal(),
      (
        JSON.parse(
          db
            .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
            .get()!.body,
        ) as { incarnation: string }
      ).incarnation,
      sequence,
      body,
    );
  const request = (
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(`https://fixture.example/p/a/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    db,
    storage,
    values,
    reads,
    alarms,
    alarm: () => project.alarm(),
    request,
    env: sealed,
    context,
    seal,
    sign,
    restart: (testV3 = true) => {
      project = new Project(testV3 ? context : { storage }, sealed);
    },
    send: async (
      route: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const response = await project.fetch(request(route, body, headers));
      return {
        status: response.status,
        body: await response.json(),
      };
    },
    snapshot: () => ({ sql: db.serialize(), kv: [...values] }),
  };
}

export function guardFixture(env?: unknown, setup?: SealSetup) {
  let sqlWriteAttempts = 0;
  const f = fixture(
    (sql) => {
      if (sqlMutation.test(sql)) sqlWriteAttempts++;
    },
    env,
    setup,
  );
  return {
    ...f,
    observeEffects() {
      const before = f.snapshot();
      const priorAlarmWrites = f.alarms.length;
      sqlWriteAttempts = 0;
      return () => {
        const after = f.snapshot();
        return {
          sqlWriteAttempts,
          alarmWrites: f.alarms.length - priorAlarmWrites,
          sqlAndKvIntact:
            Buffer.from(before.sql).equals(after.sql) &&
            JSON.stringify(before.kv) === JSON.stringify(after.kv),
        };
      };
    },
  };
}

export function copyTables(from: { db: Database }, to: { db: Database }) {
  for (const table of ["cloud_v3_commits", "cloud_v3_pages", "cloud_v3_root"]) {
    to.db.run(`DELETE FROM ${table}`);
    for (const row of from.db
      .query<Record<string, string | number>, []>(`SELECT * FROM ${table}`)
      .all()) {
      const names = Object.keys(row);
      to.db.run(
        `INSERT INTO ${table} (${names.join()}) VALUES (${names.map(() => "?").join()})`,
        Object.values(row),
      );
    }
  }
}
