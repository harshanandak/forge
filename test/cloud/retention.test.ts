import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StateOwner } from "../../src/core/state/index.ts";
import { durableStore } from "../../cloud/src/store.ts";
import { browserStorage } from "./browser-storage.fixture.ts";
import {
  actor,
  fixture,
  ns,
  usage,
} from "../core/l5-state/retention.fixture.ts";
import { domain, Project } from "../../cloud/src/project.ts";
import {
  clearStaged,
  dumpOf,
  DUMP_USAGE_SQL,
  PAGE_FORMAT,
} from "../../cloud/src/dump.ts";
import { fixture as projectFixture } from "./dump-capacity.fixture.ts";
import { migrate, stateMigrations } from "../../src/core/state/migrations.ts";

test.each([false, true])(
  "paged restore resumes after restart: gap=%s",
  async (gap) => {
    const source = await projectFixture();
    const target = await projectFixture(undefined, false);
    const db = durableStore(target.storage),
      sourceDb = durableStore(source.storage);
    const writer = new StateOwner(sourceDb, { now: () => 1000 });
    writer.put(ns, "item:1", {}, actor, { expectRevision: 0 });
    const tables = dumpOf(sourceDb).tables;
    const empty = Object.fromEntries(
      Object.keys(tables).map((table) => [table, []]),
    );
    const send = (page: number, rows: typeof tables, last = false) => {
      target.restart();
      return target.send("restore", {
        format: PAGE_FORMAT,
        page,
        last,
        next: last ? null : "next",
        tables: rows,
      });
    };
    expect(
      (await send(0, { ...empty, state_records: tables.state_records! })).ok,
    ).toBe(true);
    expect(db.all("SELECT * FROM state_allocation_keys")).toEqual([]);
    expect((await send(1, { ...tables, state_records: [] })).ok).toBe(true);
    if (gap)
      db.run(
        "DELETE FROM state_allocation_keys WHERE namespace=? AND key='item:1'",
        [ns],
      );
    const final = await send(2, empty, true);
    if (gap) {
      expect(final.ok).toBe(false);
      expect(final.error.code).toBe("INPUT_INVALID");
      expect(final.error.message).toMatch(/repair/i);
      expect(target.values.has("provisioned")).toBe(false);
    } else {
      expect(final.ok).toBe(true);
      expect(target.values.get("provisioned")).toBe(true);
      const published = new StateOwner(db, { now: () => 1000 });
      expect(() => published.initialize([domain])).not.toThrow();
    }
  },
  30_000,
);
test("legacy staged restore can be abandoned before write initialization", async () => {
  const { db, close } = await fixture();
  try {
    migrate(db, [
      ...stateMigrations.filter((m) => m.id < "006_state_retention"),
      ...domain.migrations.filter(
        (m) =>
          !["010_cloud_retention", "011_cloud_request_age_dump"].includes(m.id),
      ),
    ]);
    db.run("INSERT INTO state_events VALUES (7,?,?,?)", [ns, "old", "{}"]);
    const before = db.all(
      "SELECT type,name,sql FROM sqlite_master ORDER BY name",
    );
    clearStaged(db);
    expect(
      Object.values(dumpOf(db).tables).every((rows) => rows.length === 0),
    ).toBe(true);
    expect(
      db.all("SELECT type,name,sql FROM sqlite_master ORDER BY name"),
    ).toEqual(before);
  } finally {
    await close();
  }
}, 30_000);

test("pre-retention dump reads preserve the schema and every stored byte, and status refuses until the upgrade", async () => {
  using raw = new Database(":memory:");
  const calls: string[] = [];
  const { storage } = browserStorage(raw, (sql) => calls.push(sql));
  const db = durableStore(storage);
  migrate(db, [
    ...stateMigrations.filter((m) => m.id < "006_state_retention"),
    ...domain.migrations.filter(
      (m) =>
        !["010_cloud_retention", "011_cloud_request_age_dump"].includes(m.id),
    ),
  ]);
  db.run("INSERT INTO domain_cloud_requests VALUES ('old','{}','ok','{}')");
  await storage.put("provisioned", true);
  const before = raw.serialize();
  calls.length = 0;
  const project = new Project({ storage });
  const schemaChecks = () =>
    calls.filter((sql) => sql.includes("pragma_table_info")).length;
  for (const route of ["dump", "dump?cursor=start"]) {
    const checksBefore = schemaChecks();
    const response = await project.fetch(
      new Request(`https://fixture.example/p/a/${route}`),
    );
    expect(response.status).toBe(200);
    expect(schemaChecks()).toBe(checksBefore + 1);
    const reply = (await response.json()) as {
      value: {
        tables?: Record<string, Record<string, string | number>[]>;
      };
    };
    expect(reply.value.tables?.domain_cloud_requests).toEqual([
      {
        request_id: "old",
        fingerprint: "{}",
        outcome: "ok",
        result: "{}",
        created_at: 0,
      },
    ]);
  }
  const status = await project.fetch(
    new Request("https://fixture.example/p/a/status"),
  );
  expect(status.status).toBe(503);
  expect(calls.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
  expect(raw.serialize()).toEqual(before);
}, 30_000);

test("status names the upgrade only when a table is missing", async () => {
  const message = async (
    broken: boolean,
    migrations: typeof stateMigrations,
  ) => {
    using raw = new Database(":memory:");
    let armed = false;
    const { storage } = browserStorage(raw, (sql) => {
      if (armed && sql.includes("FROM state_usage"))
        throw new Error("disk I/O error");
    });
    migrate(durableStore(storage), migrations);
    armed = broken;
    await storage.put("provisioned", true);
    const response = await new Project({ storage }).fetch(
      new Request("https://fixture.example/p/a/status"),
    );
    expect(response.status).toBe(503);
    return ((await response.json()) as { error: { message: string } }).error
      .message;
  };
  expect(
    await message(true, [...stateMigrations, ...domain.migrations]),
  ).not.toMatch(/upgrade/);
  const legacy = [
    ...stateMigrations.filter((m) => m.id < "006_state_retention"),
    ...domain.migrations.filter(
      (m) =>
        !["010_cloud_retention", "011_cloud_request_age_dump"].includes(m.id),
    ),
  ];
  expect(await message(false, legacy)).toMatch(/POST \/p\/<project>\/upgrade/);
}, 30_000);

test("cloud capacity metadata upgrades once without changing dump rows", () => {
  using raw = new Database(":memory:");
  const db = durableStore(browserStorage(raw).storage);
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize([
    {
      ...domain,
      usage: {},
      migrations: domain.migrations.filter(
        (m) =>
          !["010_cloud_retention", "011_cloud_request_age_dump"].includes(m.id),
      ),
    },
  ]);
  owner.put(ns, "one", "\u00e9\u{1f600}", actor, { expectRevision: 0 });
  db.run(
    "INSERT INTO domain_cloud_requests(request_id,fingerprint,outcome,result) VALUES ('old','{}','ok','{}')",
  );
  // The pre-retention schema has no request age yet; compare every other column in all six tables.
  const snapshot = () =>
    Object.fromEntries(
      Object.keys(dumpOf(undefined).tables).map((table) => [
        table,
        db.all(`SELECT * FROM ${table}`).map((row) => {
          if (table !== "domain_cloud_requests") return row;
          const { created_at: _age, ...original } = row;
          return original;
        }),
      ]),
    );
  const before = snapshot();
  owner.initialize([domain]);
  expect(snapshot()).toEqual(before);
  for (const sql of DUMP_USAGE_SQL) {
    const table = sql.split(" FROM ")[1]!;
    const actual = db.get(sql)!;
    expect(
      db.get("SELECT rows AS n,bytes FROM state_usage WHERE table_name=?", [
        table,
      ]),
    ).toEqual(actual);
  }
  db.run("UPDATE domain_cloud_requests SET result=? WHERE request_id='old'", [
    "\u00e9\u{1f600}",
  ]);
  usage(db, "domain_cloud_requests", [
    "request_id",
    "fingerprint",
    "outcome",
    "result",
    "created_at",
  ]);
  expect(
    Number(db.get("SELECT created_at FROM domain_cloud_requests")?.created_at),
  ).toBeGreaterThan(0);
  owner.initialize([domain]);
  db.run(
    "UPDATE state_usage SET bytes=bytes+1 WHERE table_name='domain_cloud_requests'",
  );
  expect(() => owner.initialize([domain])).toThrow(/retention.*repair/i);
}, 30_000);

test("installed request-age dump accounting upgrades without changing witness rows", () => {
  using raw = new Database(":memory:");
  const db = durableStore(browserStorage(raw).storage);
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize([
    {
      ...domain,
      usage: {
        ...domain.usage,
        domain_cloud_requests: domain.usage.domain_cloud_requests!.filter(
          (column) => column !== "created_at",
        ),
      },
      migrations: domain.migrations.filter(
        (m) => m.id !== "011_cloud_request_age_dump",
      ),
    },
  ]);
  db.run(
    "INSERT INTO domain_cloud_requests(request_id,fingerprint,outcome,result) VALUES ('old','{}','ok','{}')",
  );
  db.run("UPDATE domain_cloud_requests SET created_at=1234");
  const before = db.all("SELECT * FROM domain_cloud_requests");
  owner.initialize([domain]);
  expect(db.all("SELECT * FROM domain_cloud_requests")).toEqual(before);
  for (const age of [0, 12345]) {
    db.run("UPDATE domain_cloud_requests SET created_at=?", [age]);
    usage(db, "domain_cloud_requests", [
      "request_id",
      "fingerprint",
      "outcome",
      "result",
      "created_at",
    ]);
    expect(() => owner.initialize([domain])).not.toThrow();
  }
}, 30_000);
