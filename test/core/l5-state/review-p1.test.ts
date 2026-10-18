import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  RestoreConsistencyFailure,
} from "../../../src/core/state/index.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "original" };
const holder = { actor, session: { id: "session" } };

async function open() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const owner = new StateOwner(result.handle.value, { now: () => 1000 });
  owner.initialize();
  return { db: result.handle.value, owner, close: () => result.handle.close() };
}

test("a client result cannot change its bound actor on later writes", async () => {
  const store = await open();
  try {
    const client = store.owner.client(ns, actor);
    const first = client.put("one", 1, { expectRevision: 0 });
    (first.updatedBy as { id: string }).id = "impostor";
    const second = client.put("two", 2, { expectRevision: 0 });
    expect(second.updatedBy).toEqual(actor);
    expect(store.owner.events(ns, "two")[0]?.actor).toEqual(actor);
  } finally {
    await store.close();
  }
}, 30000);

test("restore rejects a second release and leaves the target untouched", async () => {
  const source = await open();
  const target = await open();
  try {
    const lease = source.owner.acquire(ns, "subject", holder, 100, "claim");
    const released = source.owner.release(ns, {
      subject: "subject",
      holder,
      generation: lease.generation,
    });
    const duplicate = { ...released, releasedAt: new Date(1001).toISOString() };
    source.db.run(
      "UPDATE state_leases SET body=? WHERE namespace=? AND subject=?",
      [JSON.stringify(duplicate), ns, "subject"],
    );
    source.db.run(
      "INSERT INTO state_events(namespace,key,body) VALUES (?,?,?)",
      [
        ns,
        "subject",
        JSON.stringify({
          type: `${ns}:lease.released@1`,
          namespace: ns,
          key: "subject",
          revision: lease.generation,
          at: duplicate.releasedAt,
          actor,
          data: duplicate,
        }),
      ],
    );
    expect(() => target.owner.restore(source.owner.export())).toThrow(
      RestoreConsistencyFailure,
    );
    expect(target.owner.events(ns)).toEqual([]);
    expect(target.owner.lease(ns, "subject")).toBeUndefined();
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);

test("restore accepts acquire, release, then acquire history", async () => {
  const source = await open();
  const target = await open();
  try {
    const first = source.owner.acquire(ns, "subject", holder, 100, "first");
    source.owner.release(ns, {
      subject: "subject",
      holder,
      generation: first.generation,
    });
    source.owner.acquire(ns, "subject", holder, 100, "second");
    target.owner.restore(source.owner.export());
    expect(target.owner.events(ns, "subject")).toHaveLength(4);
    expect(target.owner.lease(ns, "subject")?.generation).toBe(2);
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);

test("restore refuses rows only in an unregistered table without changing the target", async () => {
  for (const table of [
    "domain_omitted",
    "state_unregistered",
    'odd"table',
    "sqliteXuser",
  ]) {
    const source = await open();
    const target = await open();
    try {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      // Simulate a store initialized by a migration whose registration omitted this table.
      source.db.exec(`CREATE TABLE ${quoted} (value TEXT)`);
      target.db.exec(`CREATE TABLE ${quoted} (value TEXT)`);
      target.db.run(`INSERT INTO ${quoted} VALUES (?)`, ["keep me"]);
      const before = target.owner.export();
      expect(() => target.owner.restore(source.owner.export())).toThrow(
        "Restore target must be empty",
      );
      expect(target.db.all(`SELECT * FROM ${quoted}`)).toEqual([
        { value: "keep me" },
      ]);
      expect(target.owner.export()).toEqual(before);
    } finally {
      await source.close();
      await target.close();
    }
  }
}, 30000);

test("initialization rolls back a migration with an unregistered user table", async () => {
  const store = await open();
  try {
    const before = store.owner.export();
    expect(() =>
      store.owner.initialize([
        {
          namespace: ns,
          reviewedDigest: `sha256:${"a".repeat(64)}`,
          migrations: [
            {
              id: "002_omitted",
              statements: ["CREATE TABLE domain_omitted (value TEXT)"],
            },
          ],
          tables: [],
        },
      ]),
    ).toThrow("Unregistered user table: domain_omitted");
    expect(
      store.db.get(
        "SELECT name FROM sqlite_schema WHERE name='domain_omitted'",
      ),
    ).toBeUndefined();
    expect(store.owner.export()).toEqual(before);
  } finally {
    await store.close();
  }
}, 30000);
