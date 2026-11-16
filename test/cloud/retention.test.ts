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
import { domain } from "../../cloud/src/project.ts";
import { clearStaged, dumpOf, DUMP_USAGE_SQL } from "../../cloud/src/dump.ts";
import { migrate, stateMigrations } from "../../src/core/state/migrations.ts";

test("legacy staged restore can be abandoned before write initialization", async () => {
  const { db, close } = await fixture();
  try {
    migrate(db, [
      ...stateMigrations.filter((m) => m.id !== "006_state_retention"),
      ...domain.migrations.filter((m) => m.id !== "010_cloud_retention"),
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

test("cloud capacity metadata upgrades once without changing dump rows", () => {
  using raw = new Database(":memory:");
  const db = durableStore(browserStorage(raw).storage);
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize([
    {
      ...domain,
      usage: {},
      migrations: domain.migrations.filter(
        (m) => m.id !== "010_cloud_retention",
      ),
    },
  ]);
  owner.put(ns, "one", "\u00e9\u{1f600}", actor, { expectRevision: 0 });
  db.run(
    "INSERT INTO domain_cloud_requests(request_id,fingerprint,outcome,result) VALUES ('old','{}','ok','{}')",
  );
  const before = dumpOf(db);
  owner.initialize([domain]);
  expect(dumpOf(db)).toEqual(before);
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
