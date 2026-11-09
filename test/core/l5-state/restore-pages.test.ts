import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  RestoreConsistencyFailure,
  StateOwner,
  verifyEventDerivedState,
} from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";

// The optional page size keeps this tests-first commit type-correct with the old verifier.
const verify: (
  candidate: SqlDatabase,
  highWaterMark: number,
  pageSize?: number,
) => void = verifyEventDerivedState;
const ns = "forge/test";
const actor = { kind: "agent" as const, id: "restore-pages" };
const holder = { actor, session: { id: "session" } };

async function open() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const db = opened.handle.value;
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  for (const namespace of [ns, "forge/other"])
    for (const key of ["a", "b", "c"]) {
      const lease = owner.acquire(namespace, key, holder, 100, `claim-${key}`);
      const fence = { subject: key, holder, generation: lease.generation };
      owner.put(namespace, key, { first: key }, actor, {
        expectRevision: 0,
        requestId: `put-${key}`,
        fence,
        readSet: [{ key: "absent", expectRevision: 0 }],
      });
      owner.renew(namespace, fence, 200);
      owner.put(namespace, key, { second: key }, actor, {
        expectRevision: 1,
        requestId: `update-${key}`,
        readSet: [{ key, expectRevision: 1 }],
      });
      owner.release(namespace, fence);
      owner.acquire(namespace, key, holder, 100, `reclaim-${key}`);
      owner.delete(namespace, key, actor, { expectRevision: 2 });
      owner.put(namespace, key, { recreated: key }, actor, {
        expectRevision: 0,
        requestId: `recreate-${key}`,
      });
    }
  const highWaterMark = Number(
    db.get("SELECT MAX(sequence) AS n FROM state_events")!.n,
  );
  return { db, highWaterMark, close: () => opened.handle.close() };
}

for (const pageSize of [1, 2, undefined]) {
  const label = pageSize ?? "default";
  for (const damage of [
    "none",
    "lease column",
    "event",
    "derived record",
  ] as const)
    test(`restore verdict is unchanged for ${damage}, page size ${label}`, async () => {
      const { db, highWaterMark, close } = await open();
      try {
        let table = "";
        if (damage === "lease column") {
          db.run(
            "UPDATE state_leases SET generation=generation+1 WHERE namespace=? AND subject=?",
            [ns, "c"],
          );
          table = "state_leases";
        } else if (damage === "event") {
          db.run("UPDATE state_events SET body=? WHERE sequence=?", [
            "not json",
            highWaterMark,
          ]);
          table = "state_events";
        } else if (damage === "derived record") {
          db.run(
            "UPDATE state_records SET body=json_set(body,'$.value',?) WHERE namespace=? AND key=?",
            ["changed", ns, "c"],
          );
          table = "state_records";
        }
        if (damage === "none") {
          expect(() => verify(db, highWaterMark, pageSize)).not.toThrow();
        } else {
          const key = JSON.stringify([
            damage === "event" ? "forge/other" : ns,
            "c",
          ]);
          let failure: unknown;
          try {
            verify(db, highWaterMark, pageSize);
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(RestoreConsistencyFailure);
          if (!(failure instanceof RestoreConsistencyFailure))
            throw new Error("Expected a restore consistency failure", {
              cause: failure,
            });
          expect(failure.table).toBe(table);
          expect(failure.key).toBe(key);
          expect(failure.message).toBe(
            `INPUT_INVALID: Inconsistent imported ${table} key ${key}`,
          );
          expect(failure.error).toEqual({
            code: "INPUT_INVALID",
            message: `Inconsistent imported ${table} key ${key}`,
            retry: "never",
          });
        }
      } finally {
        await close();
      }
    }, 30_000);

  test(`restore reads bounded key-ordered pages, page size ${label}`, async () => {
    const { db, highWaterMark, close } = await open();
    const observed = new Map<string, number[]>();
    const rejectWrite = (): never => {
      throw new Error("Verification must not write");
    };
    const candidate: SqlDatabase = {
      ...db,
      all(sql, params) {
        // Check before executing: a whole-table read must never allocate its rows.
        const match =
          /\bFROM\s+(state_events|state_records|state_leases|state_requests)\b/i.exec(
            sql,
          );
        expect(match).not.toBeNull();
        expect(sql).toMatch(/\bORDER\s+BY\b/i);
        expect(sql).not.toMatch(/\bOFFSET\b/i);
        const limit = /\bLIMIT\s+(\?|\d+)\s*$/i.exec(sql);
        expect(limit).not.toBeNull();
        const bound =
          limit![1] === "?" ? Number(params?.at(-1)) : Number(limit![1]);
        expect(Number.isSafeInteger(bound)).toBe(true);
        expect(bound).toBeGreaterThan(0);
        if (pageSize !== undefined) expect(bound).toBeLessThanOrEqual(pageSize);
        const rows = db.all(sql, params);
        expect(rows.length).toBeLessThanOrEqual(bound);
        const table = match![1]!.toLowerCase();
        observed.set(table, [...(observed.get(table) ?? []), rows.length]);
        return rows;
      },
      exec: rejectWrite,
      run: rejectWrite,
    };
    try {
      verify(candidate, highWaterMark, pageSize);
      expect([...observed.keys()].sort()).toEqual([
        "state_events",
        "state_leases",
        "state_records",
        "state_requests",
      ]);
      if (pageSize !== undefined)
        for (const pages of observed.values()) {
          expect(pages.length).toBeGreaterThan(1);
          expect(Math.max(...pages)).toBeLessThanOrEqual(pageSize);
        }
    } finally {
      await close();
    }
  }, 30_000);
}
