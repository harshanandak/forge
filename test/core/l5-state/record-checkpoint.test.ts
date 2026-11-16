import { expect, setDefaultTimeout, test } from "bun:test";
import { verifyEventDerivedState } from "../../../src/core/state/index.ts";
import { readReplayStart } from "../../../src/core/state/checkpoint.ts";
import { withinRestoreBudget } from "../../../src/core/state/restore-json.ts";
import {
  migrate,
  stateMigrations,
  NewerStoreError,
} from "../../../src/core/state/migrations.ts";
import {
  actor,
  ns,
  fixture,
  capture,
  high,
  prefix,
  put,
  tail,
} from "./record-checkpoint.fixture.ts";

setDefaultTimeout(30_000);

test("a malformed live floor reserves nothing during checkpoint admission", async () => {
  const s = await fixture(),
    target = await fixture();
  try {
    prefix(s);
    target.owner.initialize();
    const malformed = { prefix: "item:", number: 0, extra: true };
    put(s, "allocation:item:", malformed, 1);
    expect(
      verifyEventDerivedState(s.db, high(s), undefined, {
        namespace: ns,
        prefix: "item:",
      })?.earlier,
    ).toBe(1);
    capture(s);
    s.owner.initialize();
    target.owner.restore(s.owner.export());
    expect(target.owner.get(ns, "allocation:item:")?.value).toEqual(malformed);
    put(target, "allocation:item:", { prefix: "item:", number: 1 }, 2);
    expect(
      target.owner.putNext(ns, "item:", () => ({ value: {} }), actor).key,
    ).toBe("item:2");
  } finally {
    await s.close();
    await target.close();
  }
});

test("pre-reader writers refuse checkpoint authority before any write", async () => {
  const s = await fixture();
  try {
    prefix(s);
    capture(s);
    const before = s.db.get("SELECT total_changes() AS n");
    expect(() =>
      migrate(
        s.db,
        stateMigrations.filter((m) => m.id < "008_record_checkpoint_reader"),
      ),
    ).toThrow(NewerStoreError);
    expect(s.db.get("SELECT total_changes() AS n")).toEqual(before);
  } finally {
    await s.close();
  }
});

test.each([
  "namespace watermark",
  "nonfinite body",
  "unknown version",
  "missing header",
])("checkpoint refuses forged %s on initialize and restore", async (kind) => {
  const s = await fixture(),
    target = await fixture();
  try {
    s.owner.initialize();
    target.owner.initialize();
    put(s, "kept", null);
    if (kind === "namespace watermark")
      s.owner.put("forge/other", "other", {}, actor, { expectRevision: 0 });
    capture(s);
    if (kind === "namespace watermark") {
      expect(s.owner.namespaceRevision(ns)).toBe(1);
      s.db.run(
        "UPDATE state_namespace_watermarks SET sequence=? WHERE namespace=?",
        [high(s), ns],
      );
    } else if (kind === "unknown version") {
      s.db.run("UPDATE state_checkpoint_header SET format_version=99");
    } else if (kind === "missing header") {
      s.db.run("DELETE FROM state_checkpoint_header");
    } else {
      const body = String(
        s.db.get("SELECT body FROM state_checkpoint_live WHERE key='kept'")
          ?.body,
      ).replace('"value":null', '"value":1e999');
      expect(body).toContain("1e999");
      s.db.run("UPDATE state_checkpoint_live SET body=? WHERE key='kept'", [
        body,
      ]);
    }
    expect(() => s.owner.initialize()).toThrow(/checkpoint|retention|repair/i);
    expect(() => target.owner.restore(s.owner.export())).toThrow(
      /checkpoint|retention|repair/i,
    );
    expect(target.owner.export().records).toEqual([]);
  } finally {
    await s.close();
    await target.close();
  }
});

test("record checkpoint plus tail equals full replay, including restore", async () => {
  const full = await fixture(),
    saved = await fixture(),
    target = await fixture();
  try {
    prefix(full);
    prefix(saved);
    target.owner.initialize();
    const count = high(saved);
    expect(capture(saved)).toBe(count);
    expect(saved.db.all("SELECT sequence FROM state_events")).toHaveLength(
      count,
    );
    tail(full);
    tail(saved);
    verifyEventDerivedState(full.db, high(full), 2);
    verifyEventDerivedState(saved.db, high(saved), 2);
    expect(saved.owner.export().records).toEqual(full.owner.export().records);
    expect(
      saved.db.all("SELECT * FROM state_allocation_keys ORDER BY key"),
    ).toEqual(full.db.all("SELECT * FROM state_allocation_keys ORDER BY key"));
    target.owner.restore(saved.owner.export());
    expect(target.owner.export().records).toEqual(full.owner.export().records);
    expect(target.owner.get(ns, "gone")?.revision).toBe(3);
  } finally {
    await full.close();
    await saved.close();
    await target.close();
  }
});

test.each([
  "allocator",
  "deleted",
  "reservation",
  "deletion floor",
  "ghost floor",
])("checkpoint initialize and restore: %s", async (kind) => {
  const s = await fixture(),
    target = await fixture();
  try {
    prefix(s);
    target.owner.initialize();
    capture(s);
    // Fault injection models the future compacted prefix, without adding compaction to production.
    s.db.run("DELETE FROM state_events");
    const watermark = high(s);
    if (["reservation", "deletion floor", "ghost floor"].includes(kind)) {
      if (kind === "ghost floor")
        s.db.run("INSERT INTO state_checkpoint_floors VALUES (?,?,?,?)", [
          ns,
          "ghost:",
          1,
          99,
        ]);
      else
        s.db.run(
          kind === "reservation"
            ? "DELETE FROM state_allocation_keys WHERE key='kept'"
            : "DELETE FROM state_checkpoint_deleted WHERE key='gone'",
        );
      expect(() => target.owner.restore(s.owner.export())).toThrow(
        /retention|repair/i,
      );
      expect(() => s.owner.initialize()).toThrow(/retention|repair/i);
      expect(target.owner.export().records).toEqual([]);
    } else {
      s.owner.initialize();
      target.owner.restore(s.owner.export());
      expect(target.owner.get(ns, "gone")).toBeUndefined();
      if (kind === "allocator") {
        expect(
          target.owner.putNext(ns, "item:", () => ({ value: {} }), actor).key,
        ).toBe("item:2");
        expect(high(target)).toBe(watermark + 2);
      } else {
        expect(put(target, "gone").revision).toBe(3);
        expect(high(target)).toBe(watermark + 1);
      }
    }
  } finally {
    await s.close();
    await target.close();
  }
});

test("checkpoint beyond 5,000 JSON values is decoded row by row", async () => {
  const s = await fixture();
  try {
    s.owner.initialize();
    s.db.run(
      "INSERT INTO state_checkpoint_header VALUES (1,1,'synthetic',1,1200,1,0)",
    );
    s.db.transaction(() => {
      for (let n = 1; n <= 1200; n++)
        s.db.run("INSERT INTO state_checkpoint_deleted VALUES (?,?,?,?)", [
          ns,
          `gone:${n}`,
          n,
          2,
        ]);
    });
    const parse = JSON.parse;
    try {
      JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        if (!withinRestoreBudget(args[0]))
          throw new Error("synthetic 5,000-value parser cap");
        return parse(...args) as unknown;
      };
      const seed = readReplayStart(s.db, 16, true).checkpoint;
      expect(seed?.deleted).toHaveLength(1200);
      expect(seed?.coveredSequence).toBe(1200);
    } finally {
      JSON.parse = parse;
    }
  } finally {
    await s.close();
  }
});
