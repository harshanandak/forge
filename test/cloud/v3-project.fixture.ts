import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import { browserStorage } from "./browser-storage.fixture.ts";

export const probe = "test-v3";
export const sqlMutation =
  /^\s*(ALTER|CREATE|DELETE|DROP|INSERT|REPLACE|UPDATE)\b/i;
export const noWrites = {
  sqlWriteAttempts: 0,
  alarmWrites: 0,
  sqlAndKvIntact: true,
};

export function fixture(before?: (sql: string) => void) {
  const db = new Database(":memory:");
  const { storage, values } = browserStorage(db, before);
  const alarms: number[] = [];
  storage.getAlarm = () => Promise.resolve(alarms.at(-1) ?? null);
  storage.setAlarm = (time) => {
    alarms.push(time);
    return Promise.resolve();
  };
  const context = { storage, testV3: true };
  let project = new Project(context);
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
    values,
    alarms,
    alarm: () => project.alarm(),
    request,
    restart: (testV3 = true) => {
      project = new Project(testV3 ? context : { storage });
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

export function guardFixture() {
  let sqlWriteAttempts = 0;
  const f = fixture((sql) => {
    if (sqlMutation.test(sql)) sqlWriteAttempts++;
  });
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
