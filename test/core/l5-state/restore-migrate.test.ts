import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import {
  StateOwner,
  type StateImageStore,
} from "../../../src/core/state/index.ts";
import {
  baseline,
  migrate,
  stateMigrations,
} from "../../../src/core/state/migrations.ts";

const ns = "forge/test";
const actor = { kind: "agent" as const, id: "restore" };
const holder = { actor, session: { id: "restore-session" } };

async function open(file = false) {
  const directory = mkdtempSync(join(tmpdir(), "forge-restore-migrate-"));
  const result = await createSqliteStore(directory).open({
    path: file ? join(directory, "state.db") : ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const db = result.handle.value as StateImageStore;
  migrate(db, [baseline]);
  return {
    db,
    owner: new StateOwner(db, { now: () => 1000 }),
    async close() {
      await result.handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const file of [false, true]) {
  test(`restore migrates a baseline snapshot and retains records, events, leases and receipts (${file ? "file" : "memory"})`, async () => {
    const source = await open();
    const target = await open(file);
    try {
      const options = { expectRevision: 0, requestId: "write" };
      const record = source.owner.put(
        ns,
        "key",
        { saved: true },
        actor,
        options,
      );
      const lease = source.owner.acquire(ns, "subject", holder, 100, "claim");
      source.owner.release(ns, {
        subject: "subject",
        holder,
        generation: lease.generation,
      });
      const snapshot = source.owner.export();
      expect(source.db.all("SELECT id FROM state_migrations")).toEqual([
        { id: baseline.id },
      ]);
      target.owner.initialize();
      target.owner.restore(snapshot);
      expect(target.owner.get(ns, "key")).toEqual(record);
      expect(target.owner.events(ns)).toEqual(snapshot.events);
      expect(target.owner.lease(ns, "subject")).toEqual(
        snapshot.leases[0]?.lease,
      );
      expect(target.owner.export().requests).toEqual(snapshot.requests);
      expect(
        target.owner.put(ns, "key", { saved: true }, actor, options),
      ).toEqual(record);
      expect(
        target.db.all("SELECT id FROM state_migrations ORDER BY id"),
      ).toEqual(stateMigrations.map(({ id }) => ({ id })));
      expect(
        target.db.get(
          "SELECT name FROM sqlite_master WHERE name='state_events_by_key'",
        ),
      ).toEqual({ name: "state_events_by_key" });
      expect(source.owner.export()).toEqual(snapshot);
    } finally {
      await source.close();
      await target.close();
    }
  }, 30000);
}

for (const version of ["schema:1", "999_future", "002_unknown"]) {
  test(`restore refuses snapshot version ${version} without changing the live store`, async () => {
    const source = await open();
    const target = await open(true);
    try {
      target.owner.initialize();
      if (version === "schema:1") source.db.exec("PRAGMA user_version=1");
      else
        source.db.run("INSERT INTO state_migrations(id) VALUES (?)", [version]);
      const before = target.owner.export();
      let failure: unknown;
      try {
        target.owner.restore(source.owner.export());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ForgeFailure);
      if (!(failure instanceof ForgeFailure))
        throw new Error("Expected refusal");
      expect(failure.error.code).toBe("INPUT_INVALID");
      expect(failure.error.message).toContain(version);
      expect(failure.error.message).toContain(stateMigrations.at(-1)!.id);
      expect(target.owner.export()).toEqual(before);
    } finally {
      await source.close();
      await target.close();
    }
  }, 30000);
}

test("a staged migration failure leaves the live store and snapshot unchanged", async () => {
  const source = await open();
  const target = await open(true);
  try {
    target.owner.initialize();
    const before = target.owner.export();
    const snapshot = source.owner.export();
    let attempted = false;
    let fenced = false;
    const intercepted: StateImageStore = {
      ...target.db,
      restoreImage(image, validate, prepare, verify) {
        target.db.restoreImage(
          image,
          validate,
          (candidate) =>
            prepare({
              ...candidate,
              exec(sql) {
                if (
                  sql.includes("CREATE INDEX IF NOT EXISTS state_events_by_key")
                ) {
                  attempted = true;
                  throw new Error("injected migration failure");
                }
                candidate.exec(sql);
              },
            }),
          () => {
            fenced = true;
            verify();
          },
        );
      },
    };
    const owner = new StateOwner(intercepted, { now: () => 1000 });
    owner.initialize();
    expect(() => owner.restore(snapshot)).toThrow("injected migration failure");
    expect(attempted).toBe(true);
    expect(fenced).toBe(false);
    expect(target.owner.export()).toEqual(before);
    expect(source.owner.export()).toEqual(snapshot);
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);

test("restore verifies baseline history before running a staged migration", async () => {
  const source = await open();
  const target = await open();
  try {
    target.owner.initialize();
    source.owner.put(ns, "key", true, actor, { expectRevision: 0 });
    source.db.exec("DELETE FROM state_records");
    const before = target.owner.export();
    let prepared = false;
    const intercepted: StateImageStore = {
      ...target.db,
      restoreImage(image, validate, prepare, verify) {
        target.db.restoreImage(
          image,
          validate,
          (candidate) => {
            prepared = true;
            prepare(candidate);
          },
          verify,
        );
      },
    };
    const owner = new StateOwner(intercepted, { now: () => 1000 });
    expect(() => owner.restore(source.owner.export())).toThrow("state_records");
    expect(prepared).toBe(false);
    expect(target.owner.export()).toEqual(before);
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);
