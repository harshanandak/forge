import { expect, setDefaultTimeout, test } from "bun:test";
import { StateOwner } from "../../../src/core/state/index.ts";
import {
  checkpointTables,
  readReplayStart,
} from "../../../src/core/state/checkpoint.ts";
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
      expect(
        s.owner.put(ns, "item:1", {}, actor, { expectRevision: 0 }).revision,
      ).toBe(3);
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

test.each([
  "holder",
  "missing lease",
  "missing receipt",
  "boundary",
  "zero boundary",
])("compacted %s corruption refuses initialize and restore", async (kind) => {
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
      s.db.run("UPDATE state_checkpoint_header SET archive_through=?", [
        kind === "boundary" ? high(s) - 1 : 0,
      ]);
    expect(() => s.owner.initialize()).toThrow(/checkpoint/i);
    target.owner.initialize();
    const before = target.owner.export();
    expect(() => target.owner.restore(s.owner.export())).toThrow(/checkpoint/i);
    expect(target.owner.export()).toEqual(before);
  } finally {
    await s.close();
    await target.close();
  }
});

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

test("the hard byte limit rolls back a write until maintenance retires the pending prefix", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    for (let i = 0; i < 85; i++)
      s.owner.put(ns, "large", "x".repeat(100_000), actor, {
        expectRevision: i,
      });
    expect(compact(s.owner, 1, 84, 8 * 1024 * 1024)).toBe(1);
    const sequence = high(s);
    expect(() =>
      s.owner.put(ns, "blocked", {}, actor, { expectRevision: 0 }),
    ).toThrow(/MAINTENANCE_REQUIRED/);
    expect(high(s)).toBe(sequence);
    expect(s.owner.get(ns, "blocked")).toBeUndefined();
    expect(compact(s.owner, 1, 8192, 8 * 1024 * 1024)).toBe(1);
    expect(
      s.owner.put(ns, "blocked", {}, actor, { expectRevision: 0 }).revision,
    ).toBe(1);
    expect(high(s)).toBe(sequence + 1);
    drain(s.owner, s.db, 256);
  } finally {
    await s.close();
  }
});

const nearByteLimit = (owner: StateOwner, db: SqlDatabase, target: number) => {
  for (let i = 0; i < 84; i++)
    owner.put(ns, "large", "x".repeat(100_000), actor, { expectRevision: i });
  owner.acquire(ns, "held", holder, 60_000, "held");
  expect(compact(owner, 1, 84, 8388608)).toBe(1);
  const bytes = Number(
    db.get("SELECT bytes FROM state_usage WHERE table_name='state_events'")
      ?.bytes,
  );
  owner.put(ns, "fill", "x".repeat(target - bytes - 400), actor, {
    expectRevision: 0,
  });
};

test("maintenance at the byte boundary always frees room for a full event", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    nearByteLimit(s.owner, s.db, 8_380_000);
    const bytes = Number(
      s.db.get("SELECT bytes FROM state_usage WHERE table_name='state_events'")
        ?.bytes,
    );
    expect(bytes).toBeGreaterThan(8_368_608);
    expect(bytes).toBeLessThanOrEqual(8_388_607);
    const large = "x".repeat(20_000);
    expect(() =>
      s.owner.put(ns, "next", large, actor, { expectRevision: 0 }),
    ).toThrow(/MAINTENANCE_REQUIRED/);
    expect(compact(s.owner, 1, 8192, 8388608)).toBe(1);
    expect(
      s.owner.put(ns, "next", large, actor, { expectRevision: 0 }).revision,
    ).toBe(1);
  } finally {
    await s.close();
  }
});

const eventBytes = (db: SqlDatabase) =>
  Number(
    db.get("SELECT bytes FROM state_usage WHERE table_name='state_events'")
      ?.bytes,
  );
const fillToLimit = (owner: StateOwner, db: SqlDatabase) => {
  nearByteLimit(owner, db, 8_380_000);
  for (let i = 0; i < 200; i++) {
    try {
      owner.put(ns, `tiny:${i}`, 0, actor, { expectRevision: 0 });
    } catch {
      break;
    }
  }
};
const archiveThrough = (db: SqlDatabase) =>
  Number(
    db.get("SELECT archive_through FROM state_checkpoint_header WHERE id=1")
      ?.archive_through,
  );

test("an image exported at the byte boundary restores and releases its leases", async () => {
  const s = await fixture(),
    target = await fixture();
  try {
    s.owner.initialize();
    fillToLimit(s.owner, s.db);
    const headroom = 8388608 - eventBytes(s.db);
    expect(headroom).toBeGreaterThanOrEqual(0);
    expect(headroom).toBeLessThan(1024);
    target.owner.initialize();
    target.owner.restore(s.owner.export(), undefined, 1);
    expect(target.owner.lease(ns, "held")?.releasedAt).toBeDefined();
    expect(compact(target.owner, 1, 8192, 8388608)).toBe(1);
  } finally {
    await s.close();
    await target.close();
  }
});

test("floor events written by a restore at capacity are exempt and keep archive_through", async () => {
  const s = await fixture(),
    target = await fixture();
  try {
    s.owner.initialize();
    fillToLimit(s.owner, s.db);
    target.owner.initialize();
    target.owner.restore(s.owner.export(), undefined, 1);
    const archived = archiveThrough(target.db);
    expect(archived).toBeGreaterThan(0);
    expect(() =>
      target.owner.put(ns, "after", 0, actor, { expectRevision: 0 }),
    ).toThrow(/MAINTENANCE_REQUIRED/);
    expect(
      target.owner.seedNumberFloor(
        ns,
        "n-",
        { highest: 0, earlier: 0, floorRevision: 0 },
        actor,
        high(target),
      ),
    ).toBe(true);
    expect(target.owner.get(ns, "allocation:n-")?.value).toEqual({
      prefix: "n-",
      number: 0,
    });
    expect(archiveThrough(target.db)).toBe(archived);
  } finally {
    await s.close();
    await target.close();
  }
});

test("archive_through is unchanged after a throw inside releaseRestoredLeases", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    nearByteLimit(s.owner, s.db, 8_380_000);
    const archived = archiveThrough(s.db);
    expect(archived).toBeGreaterThan(0);
    const proxy: SqlDatabase = {
      ...s.db,
      run(sql, params) {
        if (sql.startsWith("UPDATE state_leases SET body"))
          throw new Error("synthetic release interruption");
        return s.db.run(sql, params);
      },
    };
    expect(() =>
      new StateOwner(proxy, { now: () => 1000 }).releaseRestoredLeases(),
    ).toThrow("synthetic release interruption");
    expect(archiveThrough(s.db)).toBe(archived);
    expect(s.owner.lease(ns, "held")?.releasedAt).toBeUndefined();
  } finally {
    await s.close();
  }
});

const rowBytes = (db: SqlDatabase, key: string) =>
  Number(
    db.get(
      "SELECT LENGTH(CAST(sequence AS BLOB))+LENGTH(CAST(namespace AS BLOB))+LENGTH(CAST(key AS BLOB))+LENGTH(CAST(body AS BLOB)) AS n FROM state_events WHERE key=?",
      [key],
    )?.n,
  );

test("at the post-compaction cap the largest accepted event is inserted and one byte more is refused", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    for (let i = 0; i < 70; i++)
      s.owner.put(ns, "large", "x".repeat(100_000), actor, {
        expectRevision: i,
      });
    expect(compact(s.owner, 1, 69, 8388608)).toBe(1);
    expect(archiveThrough(s.db)).toBeGreaterThan(0);
    const cap = 8388608 - 1048576;
    s.owner.put(ns, "k:a", "", actor, { expectRevision: 0 });
    const base = rowBytes(s.db, "k:a");
    const fill = cap - eventBytes(s.db) - base;
    expect(fill).toBeGreaterThan(0);
    s.owner.put(ns, "k:b", "x".repeat(fill), actor, { expectRevision: 0 });
    expect(eventBytes(s.db)).toBe(cap);
    const pad = 1048576 - base;
    const sequence = high(s);
    expect(() =>
      s.owner.put(ns, "k:c", "x".repeat(pad + 1), actor, {
        expectRevision: 0,
      }),
    ).toThrow(/INPUT_INVALID/);
    expect(high(s)).toBe(sequence);
    expect(s.owner.get(ns, "k:c")).toBeUndefined();
    s.owner.put(ns, "k:c", "x".repeat(pad), actor, { expectRevision: 0 });
    expect(rowBytes(s.db, "k:c")).toBe(1048576);
    expect(eventBytes(s.db)).toBe(8388608);
  } finally {
    await s.close();
  }
});
test("checkpoint commitments and mutation costs scale with bounded prefixes", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    for (let i = 1; i <= 16; i++)
      s.owner.put(ns, `item:${i}`, i, actor, {
        expectRevision: 0,
        requestId: `r${i}`,
      });
    const writes = () => Number(s.db.get("SELECT total_changes() AS n")?.n);
    const before = writes();
    expect(compact(s.owner, 16)).toBe(16);
    expect(writes() - before).toBe(5 * 16 + 3);
    s.owner.put(ns, "item:17", 17, actor, {
      expectRevision: 0,
      requestId: "r17",
    });
    const next = writes();
    expect(compact(s.owner, 16)).toBe(1);
    expect(writes() - next).toBe(9);
    expect(readReplayStart(s.db, 1, true).checkpoint?.receipts).toHaveLength(
      17,
    );
  } finally {
    await s.close();
  }
});

test("compacted witnesses above the document value limit load in bounded pages", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    for (let i = 0; i < 600; i++)
      s.owner.put(ns, `item:${i}`, i, actor, {
        expectRevision: 0,
        requestId: `r${i}`,
      });
    s.owner.checkpoint(256);
    drain(s.owner, s.db, 256);
    const seed = readReplayStart(s.db, 16, true).checkpoint;
    expect(seed?.receipts).toHaveLength(600);
    expect(seed?.live).toHaveLength(600);
    expect(() => s.owner.initialize()).not.toThrow();
  } finally {
    await s.close();
  }
});
