import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const adapterUrl = new URL(
  "../../../src/adapters/store-sqlite/index.ts",
  import.meta.url,
).href;

for (const runtime of [process.execPath, Bun.which("node")!]) {
  for (const mode of [
    "file",
    "restore",
    "memory",
    "wal",
    "synchronous",
    "bigint",
  ]) {
    test(`integration: durability settings (${runtime}, ${mode})`, () => {
      const result = spawnSync(
        runtime,
        [
          "--input-type=module",
          "-e",
          `
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as adapter from ${JSON.stringify(adapterUrl)};

const mode = process.argv[1];
if (["wal", "synchronous", "bigint"].includes(mode)) {
  const values = {
    journal_mode: mode === "wal" ? "WAL" : "DELETE",
    synchronous: mode === "synchronous" ? 1n : 2n,
    fullfsync: process.platform === "darwin" ? 1n : 0n,
  };
  const writes = [];
  const raw = {
    exec(sql) { writes.push(sql); },
    prepare(sql) { return { get: () => values, finalize() {} }; },
    close() {},
  };
  if (mode === "bigint") {
    assert.doesNotThrow(() => adapter.applyDurability(raw, "live.db"));
    const sql = writes.join(";");
    assert.match(sql, /PRAGMA journal_mode=DELETE/);
    assert.match(sql, /PRAGMA synchronous=FULL/);
    if (process.platform === "darwin") assert.match(sql, /PRAGMA fullfsync=ON/);
  } else {
    assert.throws(
      () => adapter.applyDurability(raw, "live.db"),
      {
        name: "StoreRestoringError",
        message: "Store durability settings did not take: journal_mode=" +
          values.journal_mode.toLowerCase() + " synchronous=" +
          values.synchronous + " fullfsync=" + values.fullfsync,
      },
    );
  }
} else {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "forge-durability-")));
  const handles = [];
  try {
    const open = async (path) => {
      const result = await adapter.createSqliteStore(directory).open({
        path, readOnly: false,
      });
      if (!result.ok) throw new Error(result.unavailable.reason);
      handles.push(result.handle);
      return result.handle.value;
    };
    const check = (db, journal) => {
      assert.equal(db.get("PRAGMA journal_mode").journal_mode, journal);
      assert.equal(Number(db.get("PRAGMA synchronous").synchronous), 2);
      if (process.platform === "darwin")
        assert.equal(Number(db.get("PRAGMA fullfsync").fullfsync), 1);
    };
    if (mode === "file") {
      // Persist a different mode so opening must actively restore the contract.
      const path = join(directory, "live.db");
      const raw = "Bun" in globalThis
        ? new (await import("bun:sqlite")).Database(path)
        : new (await import("node:sqlite")).DatabaseSync(path);
      try { raw.exec("PRAGMA journal_mode=WAL"); } finally { raw.close(); }
    }
    const db = await open(mode === "memory" ? ":memory:" : "live.db");
    if (mode === "restore") {
      const source = await open(":memory:");
      source.exec("CREATE TABLE entries(value TEXT)");
      source.run("INSERT INTO entries VALUES ('snapshot')");
      let prepared = false;
      db.restoreImage(
        source.exportImage(),
        () => {},
        (candidate) => { check(candidate, "delete"); prepared = true; },
        () => {},
      );
      check(db, "delete");
      assert.equal(prepared, true);
      assert.equal(db.get("SELECT value FROM entries").value, "snapshot");
    } else check(db, mode === "memory" ? "memory" : "delete");
  } finally {
    for (const handle of handles.reverse()) await handle.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log("PASS " + mode);
`,
          mode,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 20000 },
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain(`PASS ${mode}`);
      expect(result.status).toBe(0);
    }, 30000);
  }
}
