import { expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  inspectRecoveryFile,
  withRecoveryFence,
} from "../../../src/adapters/store-sqlite/recovery.ts";
import { StateOwner } from "../../../src/core/state/index.ts";

test("newer ledgers and schema versions refuse initialization without writes", async () => {
  for (const future of ["999_future", "000_unknown", "schema"]) {
    const opened = await createSqliteStore(tmpdir()).open({
      path: ":memory:",
      readOnly: false,
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    const db = opened.handle.value;
    try {
      new StateOwner(db, { now: () => 1 }).initialize();
      if (future === "schema") db.exec("PRAGMA user_version=999");
      else db.run("INSERT INTO state_migrations VALUES (?)", [future]);
      const before = db.all("SELECT * FROM state_migrations ORDER BY id");
      const writes: string[] = [];
      const guarded = {
        ...db,
        exec(sql: string) {
          writes.push(sql);
          db.exec(sql);
        },
        run(
          sql: string,
          params?: readonly import("../../../src/ports/store.ts").SqlValue[],
        ) {
          writes.push(sql);
          return db.run(sql, params);
        },
      };
      let caught: unknown;
      try {
        new StateOwner(guarded, { now: () => 1 }).initialize();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        name: "NewerStoreError",
        newestKnownVersion: "001_state_010",
        foundVersion: future === "schema" ? "schema:999" : future,
      });
      expect(String(caught)).toContain("Store written by a newer Forge");
      expect(writes).toEqual([]);
      expect(db.all("SELECT * FROM state_migrations ORDER BY id")).toEqual(
        before,
      );
    } finally {
      await opened.handle.close();
    }
  }
}, 30000);

test("recovery syncs the POSIX parent before commit and skips directory fsync on Windows", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-dir-sync-"));
  try {
    for (const platform of ["linux", "win32"]) {
      const source = join(work, `source-${platform}`),
        backup = join(work, `backup-${platform}`),
        recovery = join(work, `recovery-${platform}`);
      writeFileSync(source, "source");
      writeFileSync(backup, "backup");
      const calls: string[] = [];
      await withRecoveryFence(
        {
          source: inspectRecoveryFile(source),
          backup: inspectRecoveryFile(backup),
        },
        recovery,
        async () => {},
        () => {
          calls.push("commit");
        },
        {
          platform,
          openSync(path: string, flags: string) {
            expect(path).toBe(dirname(recovery));
            expect(flags).toBe("r");
            calls.push("open-dir");
            return 123;
          },
          fsyncSync(fd: number) {
            expect(fd).toBe(123);
            calls.push(
              inspectRecoveryFile(recovery).digest ===
                inspectRecoveryFile(backup).digest
                ? "sync-dir-complete"
                : "sync-dir-created",
            );
          },
          closeSync(fd: number) {
            expect(fd).toBe(123);
            calls.push("close-dir");
          },
        },
      );
      expect(calls).toEqual(
        platform === "win32"
          ? ["commit"]
          : [
              "open-dir",
              "sync-dir-created",
              "close-dir",
              "open-dir",
              "sync-dir-complete",
              "close-dir",
              "commit",
            ],
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

test("restore syncs the POSIX parent after swap and rollback renames", async () => {
  for (const rollback of [false, true]) {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-rename-sync-")),
    );
    const calls: string[] = [];
    const source = await createSqliteStore(work).open({
      path: ":memory:",
      readOnly: false,
    });
    const target = await createSqliteStore(work, {
      fs: {
        platform: "linux",
        openSync(path, flags) {
          expect(path).toBe(work);
          expect(flags).toBe("r");
          calls.push("open-dir");
          return 123;
        },
        fsyncSync(fd) {
          expect(fd).toBe(123);
          calls.push("sync-dir");
        },
        closeSync(fd) {
          expect(fd).toBe(123);
          calls.push("close-dir");
        },
        renameSync(from, to) {
          renameSync(from, to);
          calls.push("rename");
        },
      },
      step(name) {
        if (rollback && name === "renamed")
          throw new Error("injected rollback");
      },
    }).open({ path: "live.db", readOnly: false });
    if (!source.ok || !target.ok) throw new Error("store open failed");
    try {
      const left = new StateOwner(source.handle.value, { now: () => 1 });
      const right = new StateOwner(target.handle.value, { now: () => 1 });
      left.initialize();
      right.initialize();
      if (rollback)
        expect(() => right.restore(left.export())).toThrow("injected rollback");
      else right.restore(left.export());
      expect(calls.filter((call) => call === "rename")).toHaveLength(
        rollback ? 2 : 1,
      );
      calls.forEach((call, index) => {
        if (call === "rename")
          expect(calls.slice(index + 1, index + 4)).toEqual([
            "open-dir",
            "sync-dir",
            "close-dir",
          ]);
      });
    } finally {
      await source.handle.close();
      await target.handle.close();
      rmSync(work, { recursive: true, force: true });
    }
  }
}, 30000);
