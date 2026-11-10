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

async function open(fill = true) {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const db = opened.handle.value;
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  if (fill)
    for (const namespace of [ns, "forge/other"])
      for (const key of ["a", "b", "c"]) {
        const lease = owner.acquire(
          namespace,
          key,
          holder,
          100,
          `claim-${key}`,
        );
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
  return { db, owner, highWaterMark, close: () => opened.handle.close() };
}

function expectFailure(work: () => void, table: string, name: string): void {
  const key = JSON.stringify([ns, name]);
  let failure: unknown;
  try {
    work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RestoreConsistencyFailure);
  if (!(failure instanceof RestoreConsistencyFailure)) throw failure;
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

for (const pageSize of [1, 2, undefined]) {
  const label = pageSize ?? "default";
  test(`restore preserves the consistency failure without rowid, page size ${label}`, async () => {
    const { db, owner, close } = await open(false);
    try {
      owner.put(ns, "a", "value", actor, { expectRevision: 0 });
      db.exec("DROP TABLE state_records");
      db.exec(
        "CREATE TABLE state_records (namespace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), body TEXT NOT NULL, PRIMARY KEY(namespace,key)) WITHOUT ROWID",
      );
      db.run(
        "INSERT INTO state_records(namespace,key,revision,body) VALUES(?,?,1,'not json')",
        [ns, "a"],
      );
      expectFailure(() => verify(db, 1, pageSize), "state_records", "a");
    } finally {
      await close();
    }
  }, 30_000);

  for (const table of [
    "state_records",
    "state_leases",
    "state_requests",
  ] as const)
    for (const damage of ["single", "multiple", "missing"] as const)
      test(`restore reports the earliest invalid ${table} row by rowid for ${damage} corruption, page size ${label}`, async () => {
        const { db, owner, close } = await open(false);
        try {
          // The earliest row sorts last, beyond the first default page.
          for (const key of [
            "z",
            ...Array.from({ length: 17 }, (_, n) => `m${n}`),
            "a",
          ]) {
            owner.acquire(ns, key, holder, 100, `claim-${key}`);
            owner.put(ns, key, key, actor, {
              expectRevision: 0,
              requestId: `put-${key}`,
            });
          }
          const column =
            table === "state_records"
              ? "key"
              : table === "state_leases"
                ? "subject"
                : "request_id";
          const name = table === "state_requests" ? "put-z" : "z";
          expect(
            db.get(
              `SELECT ${column} AS name FROM ${table} ORDER BY rowid LIMIT 1`,
            )?.name,
          ).toBe(table === "state_requests" ? "claim-z" : "z");
          const names = damage === "single" ? ["z"] : ["z", "a"];
          const change =
            table === "state_records"
              ? "body='not json'"
              : table === "state_leases"
                ? "generation=generation+1"
                : "result='null'";
          for (const key of names)
            db.run(`UPDATE ${table} SET ${change} WHERE ${column}=?`, [
              table === "state_requests" ? `put-${key}` : key,
            ]);
          if (damage === "missing")
            db.run(`DELETE FROM ${table} WHERE ${column}=?`, [
              table === "state_requests" ? "put-m0" : "m0",
            ]);
          expectFailure(() => verify(db, 38, pageSize), table, name);
        } finally {
          await close();
        }
      }, 30_000);

  test(`restore rejects a blob receipt id instead of matching its string form, page size ${label}`, async () => {
    const { db, owner, close } = await open(false);
    try {
      owner.put(ns, "a", "value", actor, { expectRevision: 0, requestId: "1" });
      db.run("UPDATE state_requests SET request_id=X'01' WHERE request_id='1'");
      expect(
        db.get("SELECT typeof(request_id) AS kind FROM state_requests")?.kind,
      ).toBe("blob");
      expectFailure(() => verify(db, 1, pageSize), "state_requests", "1");
    } finally {
      await close();
    }
  }, 30_000);

  test(`restore uses the last duplicate type label, page size ${label}`, async () => {
    const { db, owner, close } = await open(false);
    try {
      owner.put(ns, "a", "first", actor, { expectRevision: 0 });
      const record = owner.put(ns, "a", "second", actor, { expectRevision: 1 });
      const first = String(
        db.get("SELECT body FROM state_events WHERE sequence=1")!.body,
      );
      db.run("UPDATE state_events SET body=? WHERE sequence=1", [
        first.replace('"type":', '"type":"ignored","type":'),
      ]);
      const second = JSON.parse(
        String(db.get("SELECT body FROM state_events WHERE sequence=2")!.body),
      ) as Record<string, unknown>;
      second.revision = 1;
      db.run("UPDATE state_events SET body=? WHERE sequence=2", [
        JSON.stringify(second),
      ]);
      db.run("UPDATE state_records SET revision=1,body=?", [
        JSON.stringify({ ...record, revision: 1 }),
      ]);
      expectFailure(() => verify(db, 2, pageSize), "state_records", "a");
    } finally {
      await close();
    }
  }, 30_000);

  test(`restore finds a request id hidden by duplicate labels, page size ${label}`, async () => {
    const { db, owner, close } = await open(false);
    try {
      owner.put(ns, "a", "first", actor, {
        expectRevision: 0,
        requestId: "first",
      });
      owner.put(ns, "b", "second", actor, {
        expectRevision: 0,
        requestId: "same",
      });
      const first = String(
        db.get("SELECT body FROM state_events WHERE sequence=1")!.body,
      );
      db.run("UPDATE state_events SET body=? WHERE sequence=1", [
        first.replace(
          '"requestId":"first"',
          '"requestId":"hidden","requestId":"same"',
        ),
      ]);
      db.run("DELETE FROM state_requests WHERE request_id='first'");
      expectFailure(() => verify(db, 2, pageSize), "state_requests", "same");
    } finally {
      await close();
    }
  }, 30_000);

  test(`restore preserves missing-record insertion order after recreation, page size ${label}`, async () => {
    const { db, owner, close } = await open(false);
    try {
      owner.put(ns, "a", "first", actor, { expectRevision: 0 });
      owner.put(ns, "b", "second", actor, { expectRevision: 0 });
      owner.delete(ns, "a", actor, { expectRevision: 1 });
      owner.put(ns, "a", "again", actor, { expectRevision: 0 });
      db.run("DELETE FROM state_records");
      expectFailure(() => verify(db, 4, pageSize), "state_records", "b");
    } finally {
      await close();
    }
  }, 30_000);

  for (const table of [
    "state_records",
    "state_leases",
    "state_requests",
  ] as const)
    test(`restore rejects ${table} corruption beyond the first default page, page size ${label}`, async () => {
      const { db, owner, close } = await open(false);
      try {
        for (let index = 0; index < 20; index++) {
          const key = `k${String(index).padStart(2, "0")}`;
          owner.acquire(ns, key, holder, 100, `claim-${key}`);
          owner.put(ns, key, index, actor, {
            expectRevision: 0,
            requestId: `put-${key}`,
          });
        }
        if (table === "state_records")
          db.run("UPDATE state_records SET body='not json' WHERE key='k19'");
        else if (table === "state_leases")
          db.run(
            "UPDATE state_leases SET generation=generation+1 WHERE subject='k19'",
          );
        else
          db.run(
            "UPDATE state_requests SET result='null' WHERE request_id='put-k19'",
          );
        expectFailure(
          () => verify(db, 40, pageSize),
          table,
          table === "state_requests" ? "put-k19" : "k19",
        );
      } finally {
        await close();
      }
    }, 30_000);

  test(`restore query count grows by pages rather than keys, page size ${label}`, async () => {
    const { db, owner, close } = await open(false);
    try {
      for (let index = 0; index < 40; index++)
        owner.put(ns, `key-${index}`, index, actor, {
          expectRevision: 0,
          requestId: `put-${index}`,
        });
      let queries = 0;
      const candidate: SqlDatabase = {
        ...db,
        all(sql, params) {
          queries++;
          return db.all(sql, params);
        },
        get(sql, params) {
          queries++;
          return db.get(sql, params);
        },
      };
      verify(candidate, 40, pageSize);
      // One event and record pass, two receipt passes, and one empty lease page.
      expect(queries).toBeLessThanOrEqual(
        4 * (Math.floor(40 / (pageSize ?? 16)) + 1) + 1,
      );
    } finally {
      await close();
    }
  }, 30_000);
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
