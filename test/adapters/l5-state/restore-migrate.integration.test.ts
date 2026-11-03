import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteStore,
  type RestoreHooks,
} from "../../../src/adapters/store-sqlite/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import {
  StateOwner,
  RestoreConsistencyFailure,
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

async function open(file = false, hooks: RestoreHooks = {}) {
  const directory = mkdtempSync(join(tmpdir(), "forge-restore-migrate-"));
  const result = await createSqliteStore(directory, hooks).open({
    path: file ? join(directory, "state.db") : ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const db = result.handle.value as StateImageStore;
  migrate(db, [baseline]);
  return {
    directory,
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

test("restore rejects history damaged by a migration before fencing or renaming", async () => {
  const source = await open();
  const steps: string[] = [];
  const target = await open(true, { step: (step) => steps.push(step) });
  try {
    source.owner.put(ns, "key", true, actor, { expectRevision: 0 });
    target.owner.initialize([
      {
        namespace: ns,
        reviewedDigest: `sha256:${"a".repeat(64)}`,
        tables: [],
        migrations: [
          {
            id: "004_delete_records",
            statements: ["DELETE FROM state_records"],
          },
        ],
      },
    ]);
    const path = join(target.directory, "state.db");
    const before = readFileSync(path);
    const files = readdirSync(target.directory).sort();
    expect(() => target.owner.restore(source.owner.export())).toThrow(
      RestoreConsistencyFailure,
    );
    expect(steps).toContain("validated");
    expect(steps).not.toContain("fenced");
    expect(steps).not.toContain("renamed");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(target.directory).sort()).toEqual(files);
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);

test("restore registers a domain table added by a newer reviewed migration", async () => {
  const source = await open();
  const target = await open(true);
  try {
    const old = {
      namespace: ns,
      reviewedDigest: `sha256:${"a".repeat(64)}`,
      tables: ["domain_old"],
      migrations: [
        {
          id: "004_domain_old",
          statements: ["CREATE TABLE domain_old (value TEXT)"],
        },
      ],
    };
    source.owner.initialize([old]);
    target.owner.initialize([
      {
        ...old,
        tables: [...old.tables, "domain_new"],
        migrations: [
          ...old.migrations,
          {
            id: "005_domain_new",
            statements: ["CREATE TABLE domain_new (value TEXT)"],
          },
        ],
      },
    ]);
    source.db.run("INSERT INTO domain_old VALUES (?)", ["retained"]);
    const registrations = target.db.all(
      "SELECT * FROM state_domains ORDER BY table_name",
    );
    target.owner.restore(source.owner.export());
    expect(target.db.all("SELECT * FROM domain_old")).toEqual([
      { value: "retained" },
    ]);
    expect(target.db.all("SELECT * FROM domain_new")).toEqual([]);
    expect(
      target.db.all("SELECT * FROM state_domains ORDER BY table_name"),
    ).toEqual(registrations);
    expect(registrations.map((row) => row.table_name)).toEqual([
      "domain_new",
      "domain_old",
    ]);
  } finally {
    await source.close();
    await target.close();
  }
}, 30000);

for (const ledger of ["newer missing", "missing", "malformed"]) {
  test(`restore refuses a ${ledger} migration ledger before querying ids`, async () => {
    const source = await open();
    const target = await open(true);
    try {
      target.owner.initialize();
      source.db.exec("DROP TABLE state_migrations");
      if (ledger === "newer missing") source.db.exec("PRAGMA user_version=1");
      if (ledger === "malformed")
        source.db.exec("CREATE TABLE state_migrations (unexpected TEXT)");
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
      if (ledger === "newer missing") {
        expect(failure.error.message).toContain("schema:1");
        expect(failure.error.message).toContain(stateMigrations.at(-1)!.id);
      } else expect(failure.error.message).toContain("migration ledger");
      expect(target.owner.export()).toEqual(before);
    } finally {
      await source.close();
      await target.close();
    }
  }, 30000);
}

test("restoring a baseline snapshot releases an unreleased lease and preserves receipts", async () => {
  const source = await open();
  const target = await open();
  try {
    source.owner.acquire(ns, "subject", holder, 100, "claim");
    const snapshot = source.owner.export();
    target.owner.initialize();
    target.owner.restore(snapshot);
    expect(target.owner.lease(ns, "subject")?.releasedAt).toBe(
      new Date(1000).toISOString(),
    );
    expect(target.owner.events(ns).slice(0, -1)).toEqual([...snapshot.events]);
    expect(target.owner.events(ns).at(-1)?.type).toBe(`${ns}:lease.released@1`);
    expect(target.owner.export().eventHighWaterMark).toBe(
      snapshot.eventHighWaterMark + 1,
    );
    expect(target.owner.export().requests).toEqual(snapshot.requests);
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
