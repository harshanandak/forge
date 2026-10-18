import { expect, test } from "bun:test";
import {
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteStore,
  StoreRestoringError,
} from "../../../src/adapters/store-sqlite/index.ts";
import {
  type StateImageStore,
  StateOwner,
} from "../../../src/core/state/index.ts";

// Real hard links exercise POSIX in CI and NTFS on Windows; both expose stat.nlink.
test("hard-linked store aliases refuse writable and read-only opens", async () => {
  const work = realpathSync(
    mkdtempSync(join(tmpdir(), "forge-hardlink-open-")),
  );
  const path = join(work, "state.db");
  const alias = join(work, "alias.db");
  const store = createSqliteStore(work);
  const opened = await store.open({ path, readOnly: false });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  try {
    opened.handle.value.exec("CREATE TABLE marker(value INTEGER)");
    await opened.handle.close();
    linkSync(path, alias);
    expect(statSync(alias).nlink).toBe(2);
    for (const name of [path, alias]) {
      for (const readOnly of [false, true]) {
        const result = await store.open({ path: name, readOnly });
        if (result.ok) await result.handle.close();
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.unavailable.reason).toContain(
            "Hard-linked store files are refused",
          );
      }
    }
    unlinkSync(alias);
    const reopened = await store.open({ path, readOnly: false });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) await reopened.handle.close();
  } finally {
    await opened.handle.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

test("a hard link created during open is refused", async () => {
  const work = realpathSync(
    mkdtempSync(join(tmpdir(), "forge-hardlink-race-")),
  );
  const path = join(work, "state.db");
  try {
    const result = await createSqliteStore(work, {
      step(name) {
        if (name === "opening") linkSync(path, join(work, "alias.db"));
      },
    }).open({ path, readOnly: false });
    if (result.ok) await result.handle.close();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.unavailable.reason).toContain(
        "Hard-linked store files are refused",
      );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

test("restore refuses links added after open or during final approval and preserves live data", async () => {
  for (const at of ["before", "prepared", "fenced", "retained"]) {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-hardlink-restore-")),
    );
    const path = join(work, "state.db");
    const alias = join(work, "alias.db");
    const result = await createSqliteStore(work, {
      step(name) {
        if (name === at) linkSync(path, alias);
      },
    }).open({ path, readOnly: false });
    if (!result.ok) throw new Error(result.unavailable.reason);
    const db = result.handle.value;
    const owner = new StateOwner(db, { now: () => 1 });
    try {
      owner.initialize();
      const image = (db as StateImageStore).exportImage();
      db.exec("CREATE TABLE preserved(value INTEGER)");
      db.run("INSERT INTO preserved VALUES (?)", [42]);
      if (at === "before") linkSync(path, alias);
      expect(() =>
        (db as StateImageStore).restoreImage(
          image,
          () => {},
          () => {},
          () => {},
        ),
      ).toThrow(StoreRestoringError);
      expect(statSync(path).ino).toBe(statSync(alias).ino);
      expect(() => db.run("INSERT INTO preserved VALUES (?)", [99])).toThrow(
        StoreRestoringError,
      );
      await result.handle.close();
      unlinkSync(alias);
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
}, 30000);
