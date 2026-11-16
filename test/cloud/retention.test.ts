import { expect, test } from "bun:test";
import {
  actor,
  fixture,
  ns,
  usage,
} from "../core/l5-state/retention.fixture.ts";
import { domain } from "../../cloud/src/project.ts";
import { dumpOf, DUMP_USAGE_SQL } from "../../cloud/src/dump.ts";

test("cloud capacity metadata upgrades once without changing dump rows", async () => {
  const { db, owner, close } = await fixture();
  try {
    db.exec(
      "CREATE TABLE domain_cloud_pragma (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
    );
    owner.initialize([
      {
        ...domain,
        migrations: domain.migrations.filter(
          (m) => m.id !== "010_cloud_retention",
        ),
      },
    ]);
    owner.put(ns, "one", "Ã©ðŸ˜€", actor, { expectRevision: 0 });
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
    db.run(
      "UPDATE domain_cloud_requests SET result='Ã©ðŸ˜€' WHERE request_id='old'",
    );
    usage(db, "domain_cloud_requests", [
      "request_id",
      "fingerprint",
      "outcome",
      "result",
    ]);
    expect(
      Number(
        db.get("SELECT created_at FROM domain_cloud_requests")?.created_at,
      ),
    ).toBeGreaterThan(0);
    owner.initialize([domain]);
    db.run(
      "UPDATE state_usage SET bytes=bytes+1 WHERE table_name='domain_cloud_requests'",
    );
    expect(() => owner.initialize([domain])).toThrow(/retention.*repair/i);
  } finally {
    await close();
  }
});
