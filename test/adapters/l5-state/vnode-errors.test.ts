import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteStore,
  StoreRestoringError,
  sqliteIdentityError,
} from "../../../src/adapters/store-sqlite/index.ts";
import type { StateImageStore } from "../../../src/core/state/index.ts";

const vnodeErrors = [
  Object.assign(new Error("disk I/O error"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 6922,
    errstr: "disk I/O error",
  }),
  Object.assign(new Error("disk I/O error"), {
    name: "SQLiteError",
    errno: 6922,
    code: "SQLITE_IOERR_VNODE",
  }),
  Object.assign(new Error("disk I/O error"), { errno: 6922 }),
  Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_VNODE" }),
];

test("SQLite VNODE codes map to identity refusal without hiding unrelated I/O errors", () => {
  for (const native of vnodeErrors) {
    const mapped = sqliteIdentityError(native);
    expect(mapped).toBeInstanceOf(StoreRestoringError);
    expect(mapped).toMatchObject({ code: "restoring", cause: native });
    expect(String(mapped)).toContain("identity changed");
  }
  const generic = new Error("disk I/O error");
  expect(sqliteIdentityError(generic)).toBe(generic);
  expect(sqliteIdentityError(generic, true)).toBeInstanceOf(
    StoreRestoringError,
  );
  for (const error of [
    new Error("unrelated"),
    { errno: 10 },
    { errcode: 266 },
    null,
    "SQLITE_IOERR_VNODE",
  ]) {
    expect(sqliteIdentityError(error)).toBe(error);
  }
}, 30000);

test("injected VNODE during restore or live access is typed and never swaps or commits", async () => {
  for (const native of vnodeErrors) {
    for (const at of [
      "prepared",
      "fenced",
      "closed",
      "retained",
      "write-lock-attempt",
      "write-locked",
      "transaction-body",
    ]) {
      const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-vnode-")));
      const path = join(work, "state.db");
      let armed = false;
      let swapped = false;
      const result = await createSqliteStore(work, {
        step(name) {
          if (name === "renamed") swapped = true;
          if (armed && name === at) throw native;
        },
      }).open({ path, readOnly: false });
      if (!result.ok) throw new Error(result.unavailable.reason);
      const db = result.handle.value as StateImageStore;
      try {
        db.exec("CREATE TABLE preserved(value INTEGER)");
        const image = db.exportImage();
        db.run("INSERT INTO preserved VALUES (?)", [42]);
        const before = statSync(path, { bigint: true });
        armed = true;
        expect(() =>
          at === "transaction-body"
            ? db.transaction(() => {
                db.run("INSERT INTO preserved VALUES (?)", [99]);
                throw native;
              })
            : at.startsWith("write-")
              ? db.run("INSERT INTO preserved VALUES (?)", [99])
              : db.restoreImage(
                  image,
                  () => {},
                  () => {},
                  () => {},
                ),
        ).toThrow(StoreRestoringError);
        armed = false;
        expect(swapped).toBe(false);
        expect(statSync(path, { bigint: true }).ino).toBe(before.ino);
        await result.handle.close();
        const reopened = await createSqliteStore(work).open({
          path,
          readOnly: true,
        });
        if (!reopened.ok) throw new Error(reopened.unavailable.reason);
        try {
          expect(
            reopened.handle.value.all("SELECT value FROM preserved"),
          ).toEqual([{ value: 42n }]);
        } finally {
          await reopened.handle.close();
        }
      } finally {
        await result.handle.close();
        rmSync(work, { recursive: true, force: true });
      }
    }
  }
}, 30000);
