import { expect, setDefaultTimeout, test } from "bun:test";
import { StateOwner } from "../../../src/core/state/index.ts";
import { checkpointTables } from "../../../src/core/state/checkpoint.ts";
import { actor, ns, fixture, high } from "./record-checkpoint.fixture.ts";
import { usage } from "./retention.fixture.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";

setDefaultTimeout(30_000);

type CompactOwner = StateOwner & {
  compact?: (batch?: number, keepRows?: number, keepBytes?: number) => number;
};
const compact = (owner: StateOwner, batch = 256, keepRows = 0, keepBytes = 0) =>
  (owner as CompactOwner).compact?.(batch, keepRows, keepBytes);
const holder = { actor, session: { id: "compaction", device: "synthetic" } };
const eventCount = (db: SqlDatabase) =>
  Number(db.get("SELECT COUNT(*) AS n FROM state_events")?.n);
const seed = (owner: StateOwner) => {
  owner.initialize();
  const lease = owner.acquire(ns, "subject", holder, 60_000, "first");
  owner.release(ns, lease);
  owner.acquire(ns, "subject", holder, 60_000, "second");
  owner.putNext(ns, "item:", () => ({ value: {} }), actor);
  owner.delete(ns, "item:1", actor, { expectRevision: 1 });
  owner.put(ns, "answer", { original: true }, actor, {
    expectRevision: 0,
    requestId: "answer",
  });
};
const drain = (owner: StateOwner, db: SqlDatabase, batch: number) => {
  for (let count = 0; eventCount(db) > 0; count++) {
    expect(count).toBeLessThan(100);
    const removed = compact(owner, batch);
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThanOrEqual(batch);
  }
};

test.each([1, 2, 256])(
  "compaction preserves authority, replay and recovery with batch %s",
  async (batch) => {
    const s = await fixture(),
      target = await fixture();
    try {
      seed(s.owner);
      const before = s.owner.export(),
        watermark = high(s);
      drain(s.owner, s.db, batch);
      expect(high(s)).toBe(watermark);
      expect(s.owner.namespaceRevision(ns)).toBe(watermark);
      expect(s.owner.export().records).toEqual(before.records);
      expect(s.owner.export().leases).toEqual(before.leases);
      expect(s.owner.export().requests).toEqual(before.requests);
      expect(() => s.owner.initialize()).not.toThrow();
      expect(
        s.owner.put(ns, "answer", { original: true }, actor, {
          expectRevision: 0,
          requestId: "answer",
        }).value,
      ).toEqual({ original: true });
      expect(high(s)).toBe(watermark);
      expect(() => s.owner.events(ns)).toThrow(/CHECKPOINT_REQUIRED/);
      expect(() =>
        s.owner.history(ns, { key: "answer", limit: 1, before: 2 }),
      ).toThrow(/CHECKPOINT_REQUIRED/);
      target.owner.initialize();
      target.owner.restore(s.owner.export(), undefined, 1);
      expect(target.owner.lease(ns, "subject")?.releasedAt).toBeDefined();
      expect(
        target.owner.acquire(ns, "subject", holder, 60_000, "third").generation,
      ).toBe(3);
      expect(
        s.owner.putNext(ns, "item:", () => ({ value: {} }), actor).key,
      ).toBe("item:2");
      s.owner.put(ns, "answer", { original: false }, actor, {
        expectRevision: 1,
      });
      drain(s.owner, s.db, batch);
      expect(() => s.owner.initialize()).not.toThrow();
      usage(s.db, "state_events", ["sequence", "namespace", "key", "body"]);
      expect(compact(s.owner, batch)).toBe(0);
    } finally {
      await s.close();
      await target.close();
    }
  },
);

test.each(["rows", "bytes"])(
  "maintenance keeps the requested %s tail and makes progress per call",
  async (kind) => {
    const s = await fixture();
    try {
      s.owner.initialize();
      for (let i = 0; i < 9; i++)
        s.owner.put(ns, "record", { pad: "x".repeat(100) }, actor, {
          expectRevision: i,
        });
      const keepRows = kind === "rows" ? 3 : 4096,
        keepBytes = kind === "bytes" ? 1 : 4 * 1024 * 1024;
      const limit = kind === "rows" ? 3 : 0;
      for (let i = 0; eventCount(s.db) > limit; i++) {
        expect(i).toBeLessThan(10);
        expect(compact(s.owner, 2, keepRows, keepBytes)).toBeGreaterThan(0);
      }
      expect(eventCount(s.db)).toBe(limit);
      expect(compact(s.owner, 2, keepRows, keepBytes)).toBe(0);
      expect(() => s.owner.initialize()).not.toThrow();
    } finally {
      await s.close();
    }
  },
);

test("a failed deletion rolls back the archive boundary, commitment and usage counters", async () => {
  const s = await fixture();
  try {
    seed(s.owner);
    s.owner.checkpoint();
    const tables = [
      ...Object.keys(checkpointTables),
      "state_events",
      "state_usage",
      "state_retention",
      "state_namespace_watermarks",
    ];
    const snapshot = () =>
      tables.map((table) => s.db.all(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = snapshot();
    const proxy: SqlDatabase = {
      ...s.db,
      run(sql, params) {
        const result = s.db.run(sql, params);
        if (sql.startsWith("DELETE FROM state_events"))
          throw new Error("synthetic prune interruption");
        return result;
      },
    };
    expect(() =>
      compact(new StateOwner(proxy, { now: () => 1000 }), 2),
    ).toThrow("synthetic prune interruption");
    expect(snapshot()).toEqual(before);
    drain(s.owner, s.db, 2);
    expect(() => s.owner.initialize()).not.toThrow();
  } finally {
    await s.close();
  }
});

test.each(["holder", "missing lease", "missing receipt", "boundary"])(
  "compacted %s corruption refuses initialize and restore",
  async (kind) => {
    const s = await fixture(),
      target = await fixture();
    try {
      seed(s.owner);
      drain(s.owner, s.db, 2);
      if (kind === "holder") {
        for (const table of ["state_checkpoint_leases", "state_leases"])
          s.db.run(
            `UPDATE ${table} SET body=json_set(body,'$.holder.session.id','other')`,
          );
      } else if (kind === "missing lease") {
        s.db.run("DELETE FROM state_checkpoint_leases");
        s.db.run("DELETE FROM state_leases");
      } else if (kind === "missing receipt") {
        s.db.run(
          "DELETE FROM state_checkpoint_receipts WHERE request_id='first'",
        );
        s.db.run("DELETE FROM state_requests WHERE request_id='first'");
      } else
        s.db.run(
          "UPDATE state_checkpoint_header SET archive_through=archive_through-1",
        );
      expect(() => s.owner.initialize()).toThrow(/checkpoint/i);
      target.owner.initialize();
      const before = target.owner.export();
      expect(() => target.owner.restore(s.owner.export())).toThrow(
        /checkpoint/i,
      );
      expect(target.owner.export()).toEqual(before);
    } finally {
      await s.close();
      await target.close();
    }
  },
);

test.each([
  [0, 0, 0],
  [257, 0, 0],
  [1, -1, 0],
  [1, 8193, 0],
  [1, 0, 8388609],
])("compaction refuses invalid budgets %j", async (batch, rows, bytes) => {
  const s = await fixture();
  try {
    seed(s.owner);
    const before = s.owner.export();
    expect(() => compact(s.owner, batch, rows, bytes)).toThrow();
    expect(s.owner.export()).toEqual(before);
  } finally {
    await s.close();
  }
});
