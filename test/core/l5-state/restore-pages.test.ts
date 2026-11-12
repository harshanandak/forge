import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  RestoreConsistencyFailure,
  StateOwner,
  verifyEventDerivedState,
  type NumberedSummary,
} from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";
import { instrument, reads } from "./numbered-fixture.ts";

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

// forge-1311: the replay's numbered summary and the restore-only floor seed.
const request = { namespace: ns, prefix: "n-" };
const mark = (db: SqlDatabase) =>
  Number(db.get("SELECT MAX(sequence) AS n FROM state_events")!.n);
const write = (
  owner: StateOwner,
  key: string,
  value: unknown = 1,
  expectRevision = 0,
  namespace = ns,
) => owner.put(namespace, key, value, actor, { expectRevision });
const floorKey = "allocation:n-";
const floorValue = (number: unknown, prefix = "n-") => ({ prefix, number });
const rowsOf = (db: SqlDatabase) =>
  JSON.stringify([
    db.all("SELECT * FROM state_records ORDER BY namespace,key"),
    db.all("SELECT * FROM state_events ORDER BY sequence"),
  ]);

test("the replay reports the highest number under a prefix, deleted keys included, and ignores every other key", async () => {
  const { db, owner, close } = await open(false);
  try {
    for (const key of [
      "n-9",
      "n-10",
      "n-2",
      "n-x1",
      "n-007",
      "m-500",
      "comment:n-600",
    ])
      write(owner, key);
    write(owner, "n-500", 1, 0, "forge/other");
    write(owner, "n-30");
    owner.delete(ns, "n-30", actor, { expectRevision: 1 });
    owner.acquire(ns, "n-99", holder, 100, "claim-99");
    const high = mark(db);
    expect(verifyEventDerivedState(db, high)).toBeUndefined();
    expect(verifyEventDerivedState(db, high, undefined, request)).toEqual({
      highest: 30,
      earlier: 0,
    });
    expect(verifyEventDerivedState(db, high, 1, request)).toEqual({
      highest: 30,
      earlier: 0,
    });
    expect(
      verifyEventDerivedState(db, high, undefined, {
        namespace: ns,
        prefix: "z-",
      }),
    ).toEqual({ highest: 0, earlier: 0 });
  } finally {
    await close();
  }
}, 30_000);

test("the replay remembers the highest earlier floor value after the floor is lowered or deleted, and skips values that are not a floor", async () => {
  const { db, owner, close } = await open(false);
  try {
    write(owner, floorKey, floorValue(20));
    write(owner, floorKey, floorValue(15), 1);
    write(owner, floorKey, { ...floorValue(99), extra: true }, 2);
    write(owner, floorKey, floorValue(98, "m-"), 3);
    owner.delete(ns, floorKey, actor, { expectRevision: 4 });
    expect(verifyEventDerivedState(db, mark(db), undefined, request)).toEqual({
      highest: 0,
      earlier: 20,
    });
  } finally {
    await close();
  }
}, 30_000);

for (const deleted of [false, true])
  test(`the replay refuses an unsafe ${deleted ? "deleted" : "live"} number instead of rounding it`, async () => {
    const { db, owner, close } = await open(false);
    try {
      write(owner, "n-9007199254740993");
      if (deleted)
        owner.delete(ns, "n-9007199254740993", actor, { expectRevision: 1 });
      expectFailure(
        () => verifyEventDerivedState(db, mark(db), undefined, request),
        deleted ? "state_events" : "state_records",
        "n-9007199254740993",
      );
    } finally {
      await close();
    }
  }, 30_000);

test("the replay reads a deletion type the way it parses it, last duplicate label authoritative", async () => {
  const { db, owner, close } = await open(false);
  try {
    write(owner, "n-8");
    owner.delete(ns, "n-8", actor, { expectRevision: 1 });
    for (const sequence of [1, 2])
      db.run(
        `UPDATE state_events SET body=replace(body,'"type":','"type":"ignored","type":') WHERE sequence=?`,
        [sequence],
      );
    expect(verifyEventDerivedState(db, mark(db), undefined, request)).toEqual({
      highest: 8,
      earlier: 0,
    });
  } finally {
    await close();
  }
}, 30_000);

test("the replay reads every table sixteen rows at a time and folds the summary without another pass", async () => {
  const { db, owner, close } = await open(false);
  try {
    for (let n = 1; n <= 40; n++) write(owner, `n-${n}`);
    // Forty-one events: the deletion of the highest number is in the third batch.
    owner.delete(ns, "n-40", actor, { expectRevision: 1 });
    const probe = instrument(db);
    expect(
      verifyEventDerivedState(probe.db, mark(db), undefined, request),
    ).toEqual({ highest: 40, earlier: 0 });
    const lists = reads(probe.log).filter((access) =>
      /ORDER BY/.test(access.sql),
    );
    for (const access of lists) expect(access.params.at(-1)).toBe(16);
    expect(
      lists.filter((access) => access.sql.includes("FROM state_events")).length,
    ).toBe(3);
  } finally {
    await close();
  }
}, 30_000);

const seed = (owner: StateOwner, db: SqlDatabase, found: NumberedSummary) =>
  owner.seedNumberFloor(ns, "n-", found, actor, mark(db));

test("seeding a missing floor writes one record and one event at the highest number, and the result verifies", async () => {
  const { db, owner, close } = await open(false);
  try {
    write(owner, "n-3");
    seed(owner, db, { highest: 3, earlier: 0 });
    expect(owner.get(ns, floorKey)).toMatchObject({
      revision: 1,
      value: floorValue(3),
    });
    expect(
      db
        .all("SELECT key FROM state_events ORDER BY sequence")
        .map((row) => row.key),
    ).toEqual(["n-3", floorKey]);
    expect(verifyEventDerivedState(db, mark(db), undefined, request)).toEqual({
      highest: 3,
      earlier: 3,
    });
  } finally {
    await close();
  }
}, 30_000);

test("seeding writes 0 for an empty project, and continues a deleted floor history at the next revision", async () => {
  const { db, owner, close } = await open(false);
  try {
    seed(owner, db, { highest: 0, earlier: 0 });
    expect(owner.get(ns, floorKey)?.value).toEqual(floorValue(0));
  } finally {
    await close();
  }
  const again = await open(false);
  try {
    write(again.owner, floorKey, floorValue(12));
    again.owner.delete(ns, floorKey, actor, { expectRevision: 1 });
    seed(again.owner, again.db, { highest: 1, earlier: 12 });
    // The deleted floor history continues: update 1, delete 2, restore 3.
    expect(again.owner.get(ns, floorKey)).toMatchObject({
      revision: 3,
      value: floorValue(12),
    });
  } finally {
    await again.close();
  }
}, 30_000);

test("seeding keeps a floor that covers the history exactly, and writes nothing", async () => {
  const { db, owner, close } = await open(false);
  try {
    write(owner, "n-3");
    write(owner, floorKey, floorValue(12));
    const before = rowsOf(db);
    seed(owner, db, { highest: 3, earlier: 12 });
    expect(rowsOf(db)).toBe(before);
  } finally {
    await close();
  }
}, 30_000);

const covered = { highest: 1, earlier: 0 };
for (const [name, value, found] of [
  ["below the highest number", floorValue(2), { highest: 3, earlier: 0 }],
  ["below an earlier floor value", floorValue(5), { highest: 1, earlier: 9 }],
  ["holding null", null, covered],
  ["with an extra field", { ...floorValue(5), extra: 1 }, covered],
  ["with another prefix", floorValue(5, "m-"), covered],
  ["with a fraction", floorValue(1.5), covered],
  ["with a negative number", floorValue(-1), covered],
  ["with an unsafe number", floorValue(2 ** 53), covered],
] as const)
  test(`seeding refuses a floor ${name} as an inconsistent state_records row, and writes nothing`, async () => {
    const { db, owner, close } = await open(false);
    try {
      write(owner, floorKey, value);
      const before = rowsOf(db);
      expectFailure(() => seed(owner, db, found), "state_records", floorKey);
      expect(rowsOf(db)).toBe(before);
    } finally {
      await close();
    }
  }, 30_000);

test("seeding reads a malformed floor with the same loader a numbered write uses", async () => {
  const { db, owner, close } = await open(false);
  try {
    write(owner, floorKey, floorValue(1.5));
    expect(() =>
      owner.putNext(ns, "n-", (key) => ({ value: key }), actor),
    ).toThrow("Invalid allocation record");
    expectFailure(
      () => seed(owner, db, { highest: 0, earlier: 0 }),
      "state_records",
      floorKey,
    );
  } finally {
    await close();
  }
}, 30_000);

for (const [name, statement, expected] of [
  [
    "the floor read",
    "SELECT revision,body FROM state_records",
    "injected storage fault",
  ],
  [
    "the readback of the written event",
    "SELECT body, (SELECT MAX(sequence)",
    "injected readback fault",
  ],
] as const)
  test(`a storage fault in ${name} is not read as a floor refusal, and rolls the seed back`, async () => {
    const { db, owner, close } = await open(false);
    try {
      write(owner, "n-3");
      const before = rowsOf(db);
      const faulty = new StateOwner(
        {
          ...db,
          get: (sql, params) => {
            if (sql.startsWith(statement)) throw new Error(expected);
            return db.get(sql, params);
          },
        },
        { now: () => 1000 },
      );
      let failure: unknown;
      try {
        faulty.seedNumberFloor(
          ns,
          "n-",
          { highest: 3, earlier: 0 },
          actor,
          mark(db),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RestoreConsistencyFailure);
      expect((failure as Error).message).toBe(expected);
      expect(rowsOf(db)).toBe(before);
    } finally {
      await close();
    }
  }, 30_000);
