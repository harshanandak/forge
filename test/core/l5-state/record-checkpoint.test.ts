import { expect, setDefaultTimeout, test } from "bun:test";
import { verifyEventDerivedState } from "../../../src/core/state/index.ts";
import { readReplayStart } from "../../../src/core/state/checkpoint.ts";
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
    const seed = readReplayStart(s.db, 16, true).checkpoint;
    expect(seed?.deleted).toHaveLength(1200);
    expect(seed?.coveredSequence).toBe(1200);
  } finally {
    await s.close();
  }
});
