import { expect, test } from "bun:test";
import {
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteStore,
  StoreRestoringError,
} from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";

test.each(["get", "putMany"])(
  "%s probes only at transaction boundaries",
  async (method) => {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-store-probes-")),
    );
    let probes = 0;
    let locks = 0;
    try {
      const opened = await createSqliteStore(work, {
        step(name) {
          if (name === "store-probe") probes++;
          if (name === "write-lock-attempt") locks++;
        },
      }).open({ path: "state.db", readOnly: false });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      try {
        const owner = new StateOwner(opened.handle.value, { now: () => 1 });
        owner.initialize();
        probes = 0;
        locks = 0;
        if (method === "get") {
          expect(owner.get("test/probes", "missing")).toBeUndefined();
        } else {
          expect(
            owner.putMany(
              "test/probes",
              ["first", "second", "third"].map((key) => ({
                key,
                value: key,
                expectRevision: 0,
              })),
              { kind: "human", id: "test" },
            ),
          ).toHaveLength(3);
        }
        expect(locks).toBe(1);
        expect(probes).toBe(2);
      } finally {
        await opened.handle.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  30000,
);

test.each(["fence", "hard link"])(
  "%s created after the last SQL statement refuses commit and rolls back",
  async (change) => {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-store-precommit-")),
    );
    const path = join(work, "state.db");
    const injectedPath =
      change === "fence" ? `${path}.restore-lock` : join(work, "alias.db");
    try {
      const opened = await createSqliteStore(work).open({
        path,
        readOnly: false,
      });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      try {
        const db = opened.handle.value;
        db.exec("CREATE TABLE marker(value TEXT)");
        const sentinel = Symbol("committed");
        let returned: unknown;
        let failure: unknown;
        let bodyFinished = false;
        try {
          returned = db.transaction(() => {
            expect(
              db.run("INSERT INTO marker VALUES (?)", ["pending"]).changes,
            ).toBe(1);
            // Both mutations happen after the last SQL statement. Removing the
            // pre-commit check or moving it before the body would commit the row
            // and return the sentinel in both cases.
            if (change === "fence")
              writeFileSync(injectedPath, "", { flag: "wx" });
            else linkSync(path, injectedPath);
            bodyFinished = true;
            return sentinel;
          });
        } catch (error) {
          failure = error;
        }
        expect(bodyFinished).toBe(true);
        expect(failure).toBeInstanceOf(StoreRestoringError);
        expect(failure).toMatchObject({ code: "restoring" });
        expect(returned).not.toBe(sentinel);
        await opened.handle.close();
        unlinkSync(injectedPath);
        const reopened = await createSqliteStore(work).open({
          path,
          readOnly: true,
        });
        if (!reopened.ok) throw new Error(reopened.unavailable.reason);
        try {
          expect(reopened.handle.value.all("SELECT value FROM marker")).toEqual(
            [],
          );
        } finally {
          await reopened.handle.close();
        }
      } finally {
        await opened.handle.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  30000,
);

test.each(["lock", "statement"])(
  "%s failure after a hard link is added reports the typed refusal",
  async (at) => {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-store-failure-")),
    );
    const path = join(work, "state.db");
    const alias = join(work, "alias.db");
    try {
      const created = await createSqliteStore(work).open({
        path,
        readOnly: false,
      });
      if (!created.ok) throw new Error(created.unavailable.reason);
      try {
        created.handle.value.exec("CREATE TABLE marker(value TEXT)");
      } finally {
        await created.handle.close();
      }
      const opened = await createSqliteStore(work).open({
        path,
        readOnly: at === "lock",
      });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      try {
        const db = opened.handle.value;
        if (at === "lock") {
          // A read-only handle makes BEGIN IMMEDIATE fail on every platform.
          expect(() => db.transaction(() => db.get("SELECT 1"))).toThrow(
            /readonly/i,
          );
          linkSync(path, alias);
        }
        let bodyRan = false;
        let failure: unknown;
        let statementFailure: unknown;
        try {
          db.transaction(() => {
            bodyRan = true;
            db.run("INSERT INTO marker VALUES (?)", ["pending"]);
            linkSync(path, alias);
            try {
              db.run("INSERT INTO missing_table VALUES (?)", ["pending"]);
            } catch (error) {
              // Capture the statement's refusal before the transaction unwinds;
              // an outer transaction check alone must not satisfy this case.
              statementFailure = error;
              throw error;
            }
          });
        } catch (error) {
          failure = error;
        }
        expect(bodyRan).toBe(at === "statement");
        expect(failure).toBeInstanceOf(StoreRestoringError);
        expect(failure).toMatchObject({ code: "restoring" });
        if (at === "statement") {
          expect(statementFailure).toBeInstanceOf(StoreRestoringError);
          expect(statementFailure).toMatchObject({ code: "restoring" });
        }
        await opened.handle.close();
        unlinkSync(alias);
        const reopened = await createSqliteStore(work).open({
          path,
          readOnly: true,
        });
        if (!reopened.ok) throw new Error(reopened.unavailable.reason);
        try {
          expect(reopened.handle.value.all("SELECT value FROM marker")).toEqual(
            [],
          );
        } finally {
          await reopened.handle.close();
        }
      } finally {
        await opened.handle.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  30000,
);
