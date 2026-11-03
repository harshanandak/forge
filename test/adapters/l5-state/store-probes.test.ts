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
