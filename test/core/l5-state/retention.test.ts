import { expect, test } from "bun:test";
import { actor, ns, fixture, usage } from "./retention.fixture.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import {
  migrate,
  stateMigrations,
} from "../../../src/core/state/migrations.ts";

test.each([
  "history",
  "live",
  "retired",
  "global",
  "namespace",
  "reservations",
])(
  "restore and initialize preserve retention authority: %s",
  async (kind) => {
    const source = await fixture();
    const target = await fixture();
    try {
      source.owner.initialize();
      target.owner.initialize();
      if (kind !== "history" && kind !== "live") {
        target.owner.putNext(ns, "item:", () => ({ value: {} }), actor);
        target.owner.delete(ns, "item:1", actor, { expectRevision: 1 });
        target.owner.delete(ns, "allocation:item:", actor, {
          expectRevision: 1,
        });
        target.db.run("DELETE FROM state_events");
        if (kind !== "retired") {
          if (kind !== "global")
            target.db.run("UPDATE state_retention SET sequence=0");
          if (kind !== "namespace")
            target.db.run("DELETE FROM state_namespace_watermarks");
          if (kind !== "reservations")
            target.db.run("DELETE FROM state_allocation_keys");
        }
        const authority = () =>
          [
            "state_retention",
            "state_namespace_watermarks",
            "state_allocation_keys",
          ].map((table) => target.db.all(`SELECT * FROM ${table}`));
        const before = authority();
        expect(() => target.owner.restore(source.owner.export())).toThrow(
          "Restore target must be empty",
        );
        expect(authority()).toEqual(before);
      } else {
        source.owner.put(ns, "item:1", {}, actor, { expectRevision: 0 });
        if (kind !== "live")
          source.owner.delete(ns, "item:1", actor, { expectRevision: 1 });
        source.db.run("DELETE FROM state_allocation_keys");
        const snapshot = source.owner.export();
        for (const [path, admit] of [
          ["restore", () => target.owner.restore(snapshot)],
          ["initialize", () => source.owner.initialize()],
        ] as const) {
          if (path === "initialize" && kind === "live")
            source.db.run("DELETE FROM state_events");
          expect(admit).toThrow(/repair/i);
          try {
            admit();
          } catch (error) {
            expect(error).toMatchObject({ error: { code: "INPUT_INVALID" } });
          }
        }
        expect(target.owner.events(ns)).toEqual([]);
      }
    } finally {
      await source.close();
      await target.close();
    }
  },
  30_000,
);

test("legacy store exports without migrating before backup", async () => {
  const { db, owner, close } = await fixture();
  try {
    migrate(
      db,
      stateMigrations.filter((m) => m.id !== "006_state_retention"),
    );
    db.run("INSERT INTO state_events VALUES (7,?,?,?)", [ns, "old", "{}"]);
    const before = db.all(
      "SELECT type,name,sql FROM sqlite_master ORDER BY name",
    );
    expect(owner.export().eventHighWaterMark).toBe(7);
    expect(owner.namespaceRevision(ns)).toBe(7);
    expect(
      db.all("SELECT type,name,sql FROM sqlite_master ORDER BY name"),
    ).toEqual(before);
  } finally {
    await close();
  }
}, 30_000);

test.each(["legacy", "missing floor"])(
  "allocation retention: %s",
  async (kind) => {
    const { db, owner, close } = await fixture();
    try {
      if (kind === "legacy") {
        migrate(
          db,
          stateMigrations.filter((m) => m.id !== "006_state_retention"),
        );
        for (const [sequence, type, revision] of [
          [1, "updated", 1],
          [2, "deleted", 2],
        ] as const) {
          db.run("INSERT INTO state_events VALUES (?,?,?,?)", [
            sequence,
            ns,
            "item:1",
            JSON.stringify({
              type: `${ns}:record.${type}@1`,
              namespace: ns,
              key: "item:1",
              revision,
              at: new Date(1000).toISOString(),
              actor,
              ...(type === "updated" ? { data: {} } : {}),
            }),
          ]);
        }
        owner.initialize();
      } else {
        owner.initialize();
        owner.putNext(ns, "item:", () => ({ value: {} }), actor);
        owner.delete(ns, "item:1", actor, { expectRevision: 1 });
        owner.delete(ns, "allocation:item:", actor, { expectRevision: 1 });
      }
      db.run("DELETE FROM state_events");
      const before = db.all("SELECT * FROM state_usage ORDER BY table_name");
      const next = () =>
        owner.putNext(ns, "item:", () => ({ value: {} }), actor);
      if (kind === "legacy") expect(next().key).toBe("item:2");
      else {
        expect(next).toThrow(/allocation.*repair/i);
        expect(db.all("SELECT * FROM state_usage ORDER BY table_name")).toEqual(
          before,
        );
        expect(owner.events(ns)).toEqual([]);
      }
    } finally {
      await close();
    }
  },
  30_000,
);
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
        owner.put(ns, "one", "\u00e9\u{1f600}", actor, {
          expectRevision: 0,
          requestId: "first",
        });
      owner.initialize();
      const high = kind === "upgrade" ? 7 : 1;
      expect(
        Object.fromEntries(
          Object.entries(
            db.get(
              "SELECT sequence,policy_version FROM state_retention WHERE id=1",
            )!,
          ).map(([key, value]) => [key, Number(value)]),
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
          Number(
            db.get("SELECT sequence FROM state_events WHERE key='three'")
              ?.sequence,
          ),
        ).toBe(3);
      } else if (kind === "rollback") {
        const before = db.all("SELECT * FROM state_usage ORDER BY table_name");
        const boundary = db.get(
          "SELECT sequence FROM state_retention WHERE id=1",
        );
        const watermarks = db.all(
          "SELECT * FROM state_namespace_watermarks ORDER BY namespace",
        );
        const records = db.all(
          "SELECT * FROM state_records ORDER BY namespace,key",
        );
        const events = db.all("SELECT * FROM state_events ORDER BY sequence");
        const failingOwner = new StateOwner(
          {
            ...db,
            run(sql, params) {
              const result = db.run(sql, params);
              if (sql.startsWith("INSERT INTO state_events"))
                throw new Error("rollback");
              return result;
            },
          },
          { now: () => 1000 },
        );
        expect(() =>
          failingOwner.put(ns, "rolled", 2, actor, { expectRevision: 0 }),
        ).toThrow("rollback");
        expect(db.all("SELECT * FROM state_usage ORDER BY table_name")).toEqual(
          before,
        );
        expect(owner.namespaceRevision(ns)).toBe(1);
        expect(
          db.all("SELECT * FROM state_namespace_watermarks ORDER BY namespace"),
        ).toEqual(watermarks);
        expect(
          db.get("SELECT sequence FROM state_retention WHERE id=1"),
        ).toEqual(boundary);
        expect(
          db.all("SELECT * FROM state_records ORDER BY namespace,key"),
        ).toEqual(records);
        expect(db.all("SELECT * FROM state_events ORDER BY sequence")).toEqual(
          events,
        );
        expect(owner.get(ns, "rolled")).toBeUndefined();
        expect(
          db.get("SELECT 1 FROM state_events WHERE key='rolled'"),
        ).toBeUndefined();
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
          Number(db.get("SELECT created_at FROM state_requests")?.created_at),
        ).toBe(1000);
    } finally {
      await close();
    }
  },
  30_000,
);
