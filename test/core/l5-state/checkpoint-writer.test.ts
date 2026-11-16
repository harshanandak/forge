import { expect, setDefaultTimeout, test } from "bun:test";
import {
  actor,
  ns,
  fixture,
  capture,
  high,
  prefix,
  put,
} from "./record-checkpoint.fixture.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import { StateOwner } from "../../../src/core/state/index.ts";

setDefaultTimeout(30_000);

test("checkpoint writes bodies, deletion floors and allocator high-water without resurrection", async () => {
  const s = await fixture();
  try {
    prefix(s);
    const before = s.owner.export();
    const value = (sql: string, field: string) =>
      Number(s.db.get(sql)?.[field]);
    capture(s);
    expect(
      value(
        "SELECT highest FROM state_checkpoint_floors WHERE prefix='item:'",
        "highest",
      ),
    ).toBe(1);
    expect(
      value(
        "SELECT revision FROM state_checkpoint_deleted WHERE key='gone'",
        "revision",
      ),
    ).toBe(2);
    expect(
      value(
        "SELECT revision FROM state_checkpoint_deleted WHERE key='item:1'",
        "revision",
      ),
    ).toBe(2);
    expect(
      value(
        "SELECT number FROM state_checkpoint_reservations WHERE prefix='item:'",
        "number",
      ),
    ).toBe(1);
    expect(
      s.db.get("SELECT body FROM state_checkpoint_live WHERE key='gone'"),
    ).toBeUndefined();
    expect(
      s.db.get("SELECT body FROM state_checkpoint_live WHERE key='item:1'"),
    ).toBeUndefined();
    expect(
      JSON.parse(
        String(
          s.db.get("SELECT body FROM state_checkpoint_live WHERE key='kept'")!
            .body,
        ),
      ),
    ).toEqual(s.owner.get(ns, "kept"));
    expect(s.owner.export().records).toEqual(before.records);
    expect(s.owner.export().events).toEqual(before.events);
    expect(
      value(
        "SELECT covered_sequence FROM state_checkpoint_header",
        "covered_sequence",
      ),
    ).toBe(high(s));
    expect(s.owner.putNext(ns, "item:", () => ({ value: {} }), actor).key).toBe(
      "item:2",
    );
    expect(put(s, "gone").revision).toBe(3);
    capture(s);
    expect(
      value(
        "SELECT revision FROM state_checkpoint_live WHERE key='gone'",
        "revision",
      ),
    ).toBe(3);
    expect(
      s.db.get(
        "SELECT revision FROM state_checkpoint_deleted WHERE key='gone'",
      ),
    ).toBeUndefined();
  } finally {
    await s.close();
  }
});

test.each([1, 2, 256])(
  "checkpoint transactions bound each prefix and resume after interruption: %s",
  async (batch) => {
    const s = await fixture();
    try {
      prefix(s);
      let armed = true,
        depth = 0,
        writes = 0;
      const counts: number[] = [];
      const proxy: SqlDatabase = {
        exec: (sql) => s.db.exec(sql),
        get: (sql, args) => s.db.get(sql, args),
        all: (sql, args) => s.db.all(sql, args),
        run(sql, args) {
          if (sql.startsWith("INSERT INTO state_checkpoint_live")) {
            if (armed && args?.[1] === "allocation:item:")
              throw new Error("synthetic interruption");
          }
          if (/^INSERT INTO state_checkpoint_(live|deleted)/.test(sql))
            writes++;
          return s.db.run(sql, args);
        },
        transaction(work) {
          return s.db.transaction(() => {
            if (depth++ === 0) writes = 0;
            try {
              return work();
            } finally {
              if (--depth === 0) counts.push(writes);
            }
          });
        },
      };
      const owner = new StateOwner(proxy, { now: () => 1000 });
      const write = () => capture({ ...s, owner }, batch);
      expect(write).toThrow("synthetic interruption");
      const covered = Number(
        s.db.get("SELECT covered_sequence FROM state_checkpoint_header")
          ?.covered_sequence ?? 0,
      );
      expect(covered).toBeLessThan(5);
      expect(
        s.db.get("SELECT 1 FROM state_checkpoint_live WHERE sequence>?", [
          covered,
        ]),
      ).toBeUndefined();
      armed = false;
      expect(write()).toBe(high(s));
      expect(counts.every((n) => n <= batch)).toBe(true);
      expect(
        Number(
          s.db.get("SELECT generation FROM state_checkpoint_header")
            ?.generation,
        ),
      ).toBe(Math.ceil(high(s) / batch));
      expect(s.owner.events(ns)).toHaveLength(high(s));
    } finally {
      await s.close();
    }
  },
);

test.each(["request", "gap", "floor"])(
  "checkpoint refuses unsafe input: %s",
  async (kind) => {
    const s = await fixture();
    try {
      prefix(s);
      if (kind === "request")
        s.owner.put(ns, "receipt", {}, actor, {
          expectRevision: 0,
          requestId: "synthetic",
        });
      else if (kind === "gap")
        s.db.run("DELETE FROM state_events WHERE sequence=2");
      else {
        capture(s);
        put(s, "allocation:item:", { prefix: "item:", number: 0 }, 1);
      }
      const before = s.owner.export();
      if (kind === "floor")
        expect(() =>
          s.owner.putNext(ns, "item:", () => ({ value: {} }), actor),
        ).toThrow(/checkpoint.*repair/i);
      else expect(() => capture(s, 256)).toThrow();
      expect(s.owner.export().records).toEqual(before.records);
      expect(s.owner.export().events).toEqual(before.events);
    } finally {
      await s.close();
    }
  },
);
