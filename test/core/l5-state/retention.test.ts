import { expect, test } from "bun:test";
import { actor, ns, fixture, usage } from "./retention.fixture.ts";
import {
  migrate,
  stateMigrations,
} from "../../../src/core/state/migrations.ts";
test.each(["fresh", "upgrade", "prefix", "all", "rollback", "drift"])(
  "retention: %s",
  async (kind) => {
    const { db, owner, close } = await fixture();
    try {
      if (kind === "upgrade")
        migrate(
          db,
          stateMigrations.filter((m) => m.id !== "006_state_retention"),
        );
      else owner.initialize();
      if (kind === "upgrade")
        db.run("INSERT INTO state_events VALUES (7,?,?,?)", [ns, "old", "{}"]);
      else
        owner.put(ns, "one", "Ã©ðŸ˜€", actor, {
          expectRevision: 0,
          requestId: "first",
        });
      owner.initialize();
      const high = kind === "upgrade" ? 7 : 1;
      expect(
        db.get(
          "SELECT sequence,policy_version FROM state_retention WHERE id=1",
        ),
      ).toEqual({ sequence: high, policy_version: 1 });
      expect(owner.namespaceRevision(ns)).toBe(high);
      if (kind === "prefix" || kind === "all") {
        owner.put("forge/other", "two", 2, actor, { expectRevision: 0 });
        db.run(
          kind === "all"
            ? "DELETE FROM state_events"
            : "DELETE FROM state_events WHERE sequence=1",
        );
        owner.initialize();
        expect(owner.namespaceRevision(ns)).toBe(1);
        owner.put(ns, "three", 3, actor, { expectRevision: 0 });
        expect(
          db.get("SELECT sequence FROM state_events WHERE key='three'")
            ?.sequence,
        ).toBe(3);
      } else if (kind === "rollback") {
        const before = db.all("SELECT * FROM state_usage ORDER BY table_name");
        expect(() =>
          db.transaction(() => {
            owner.put(ns, "rolled", 2, actor, { expectRevision: 0 });
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(db.all("SELECT * FROM state_usage ORDER BY table_name")).toEqual(
          before,
        );
        expect(owner.namespaceRevision(ns)).toBe(1);
      } else if (kind === "drift") {
        db.run(
          "UPDATE state_usage SET rows=rows+1 WHERE table_name='state_records'",
        );
        const before = db.all("SELECT * FROM state_usage ORDER BY table_name");
        expect(() => owner.initialize()).toThrow(/retention.*repair/i);
        expect(db.all("SELECT * FROM state_usage ORDER BY table_name")).toEqual(
          before,
        );
      }
      for (const [table, columns] of Object.entries({
        state_records: ["namespace", "key", "revision", "body"],
        state_events: ["sequence", "namespace", "key", "body"],
        state_leases: ["namespace", "subject", "generation", "body"],
        state_requests: ["namespace", "request_id", "fingerprint", "result"],
      })) {
        if (kind !== "drift") usage(db, table, columns);
      }
      if (kind === "fresh")
        expect(
          db.get("SELECT created_at FROM state_requests")?.created_at,
        ).toBe(1000);
    } finally {
      await close();
    }
  },
);
