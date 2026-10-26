// [integration] Public SQLite entry points on disposable Windows files.
import { expect, test, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { windowsPrivateFiles } from "../../src/adapters/process/windows-acl.ts";
import { createSqliteStore as rawSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { privateFileGuard } from "../../src/adapters/store-sqlite/private-files.ts";
import { sddlTrustees } from "../../src/adapters/store-sqlite/private-acl.ts";
import type { StateImageStore } from "../../src/core/state/index.ts";
import type { SqlDatabase, StorePort } from "../../src/ports/store.ts";

setDefaultTimeout(30000);

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { exports: { "./adapters/sqlite": { default: string } } };
const target = manifest.exports["./adapters/sqlite"].default
  .replace(/^\.\/dist\//, "../../")
  .replace(/\.js$/, ".ts");
const api = (await import(
  new URL(target, import.meta.url).href
)) as typeof import("../../src/adapters/store-sqlite/index.ts");

test.skipIf(process.platform !== "win32")(
  "public SQLite reports unavailable when native ACL initialization fails",
  () => {
    const root = mkdtempSync(
      join(tmpdir(), "forge-public-sqlite-native-failure-"),
    );
    try {
      const script = `
        import { mock } from "bun:test";
        import assert from "node:assert/strict";
        mock.module(${JSON.stringify(fileURLToPath(new URL("../../src/adapters/process/windows-acl.ts", import.meta.url)))}, () => ({
          windowsPrivateFiles() { throw new Error("injected native failure"); }
        }));
        const api = await import(${JSON.stringify(new URL(target, import.meta.url).href)});
        const factory = api.createSqliteStore(${JSON.stringify(root)});
        for (const store of [factory, api.sqliteStore]) {
          const opened = await store.open({ path: ${JSON.stringify(join(root, "state.sqlite"))}, readOnly: false });
          assert.equal(opened.ok, false);
          assert.equal(opened.unavailable.kind, "unavailable");
          assert.match(opened.unavailable.reason, /injected native failure/);
        }
      `;
      const result = spawnSync(process.execPath, ["--eval", script], {
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const entry of ["singleton", "factory"] as const) {
  const store = (root: string): StorePort =>
    entry === "singleton" ? api.sqliteStore : api.createSqliteStore(root);

  test.skipIf(process.platform !== "win32")(
    `public SQLite ${entry} refuses a borrowed broad parent without changing it`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "forge-public-sqlite-"));
      const native = windowsPrivateFiles();
      try {
        native.protect(root, `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`);
        const sentinel = join(root, "borrowed.txt");
        writeFileSync(sentinel, "borrowed data");
        const descriptor = native.read(root);
        const sentinelDescriptor = native.read(sentinel);
        const path = join(root, "state.sqlite");
        const opened = await store(root).open({ path, readOnly: false });
        if (opened.ok) await opened.handle.close();
        expect(opened.ok).toBe(false);
        if (!opened.ok) {
          expect(opened.unavailable.reason).toContain("Private ACL");
          expect(opened.unavailable.reason).toContain(
            "Move the store into a folder only you can access, or let Forge create the folder.",
          );
          expect(opened.unavailable.reason).not.toContain(
            "Repair in PowerShell:",
          );
          expect(opened.unavailable.reason).not.toMatch(
            /SetAccessControl|SetSecurityDescriptorSddlForm|DirectorySecurity|Set-Acl|icacls/i,
          );
        }
        expect(native.read(root)).toBe(descriptor);
        expect(native.read(sentinel)).toBe(sentinelDescriptor);
        expect(readFileSync(sentinel, "utf8")).toBe("borrowed data");
        expect(existsSync(path)).toBe(false);
        expect(readdirSync(root)).toEqual(["borrowed.txt"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    `public SQLite ${entry} creates a private database under a private parent`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "forge-public-sqlite-private-"));
      const native = windowsPrivateFiles();
      const guard = privateFileGuard(native);
      try {
        native.protect(root, `D:P(A;OICI;FA;;;${native.sid})`);
        const descriptor = native.read(root);
        const path = join(root, "state.sqlite");
        const opened = await store(root).open({ path, readOnly: false });
        if (!opened.ok) throw new Error(opened.unavailable.reason);
        try {
          opened.handle.value.exec("CREATE TABLE sample(value INTEGER)");
          guard.file(path);
          expect(native.read(root)).toBe(descriptor);
        } finally {
          await opened.handle.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    `public SQLite ${entry} refuses an existing database with broad explicit access`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "forge-public-sqlite-refuse-"));
      const native = windowsPrivateFiles();
      try {
        native.protect(root, `D:P(A;OICI;FA;;;${native.sid})`);
        const path = join(root, "state.sqlite");
        writeFileSync(path, "");
        native.protect(path, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
        for (const readOnly of [false, true]) {
          const opened = await store(root).open({ path, readOnly });
          if (opened.ok) await opened.handle.close();
          expect(opened.ok).toBe(false);
          if (!opened.ok)
            expect(opened.unavailable.reason).toContain("Private ACL");
        }
        expect(native.read(path)).toContain(";;;WD)");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  for (const readOnly of [true, false]) {
    test.skipIf(process.platform !== "win32")(
      `public SQLite ${entry} refuses inherited broad file access without changes on a ${readOnly ? "read-only" : "writable"} open`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "forge-public-sqlite-legacy-"));
        const native = windowsPrivateFiles();
        try {
          native.protect(
            root,
            `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`,
          );
          const path = join(root, "state.sqlite");
          const legacy = await rawSqliteStore(root).open({
            path,
            readOnly: false,
          });
          if (!legacy.ok) throw new Error(legacy.unavailable.reason);
          legacy.handle.value.exec(
            "CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (42)",
          );
          await legacy.handle.close();
          const inherited = native.read(path);
          expect(inherited).toContain(";ID;");
          expect(inherited).toContain(";;;WD)");
          expect(native.owner(path)).toBe(native.sid);
          const parentDescriptor = native.read(root);
          const fileDescriptor = native.read(path);
          const bytes = readFileSync(path);
          const opened = await store(root).open({ path, readOnly });
          if (opened.ok) await opened.handle.close();
          expect(opened.ok).toBe(false);
          if (!opened.ok) {
            const reason = opened.unavailable.reason;
            expect(reason).toContain("Private ACL");
            if (readOnly) {
              expect(reason).toContain("Repair in PowerShell:");
              expect(reason).toContain(
                "System.Security.AccessControl.FileSecurity",
              );
              expect(reason).toContain(`D:P(A;;FA;;;${native.sid})`);
              expect(reason).not.toContain("DirectorySecurity");
            } else {
              expect(reason).toContain(
                "Move the store into a folder only you can access, or let Forge create the folder.",
              );
              expect(reason).not.toContain("Repair in PowerShell:");
              expect(reason).not.toMatch(
                /SetAccessControl|SetSecurityDescriptorSddlForm|DirectorySecurity|Set-Acl|icacls/i,
              );
            }
          }
          expect(native.read(path)).toBe(fileDescriptor);
          expect(native.owner(path)).toBe(native.sid);
          expect(native.read(root)).toBe(parentDescriptor);
          expect(readFileSync(path)).toEqual(bytes);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }

  test.skipIf(process.platform !== "win32")(
    `public SQLite ${entry} keeps memory export and restore spill files private`,
    async () => {
      const native = windowsPrivateFiles();
      const guard = privateFileGuard(native);
      const opened = await store(tmpdir()).open({
        path: ":memory:",
        readOnly: false,
      });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      let inspected = 0;
      const inspect = (db: SqlDatabase): void => {
        const path = db.all("PRAGMA database_list")[0]?.file;
        if (typeof path !== "string" || path === "")
          throw new Error("Expected a temporary database file");
        guard.file(path);
        expect(
          sddlTrustees(native.sid).some((sid) =>
            [`D:P(A;OICI;FA;;;${sid})`, `D:PAI(A;OICI;FA;;;${sid})`].includes(
              native.read(dirname(path)),
            ),
          ),
        ).toBe(true);
        inspected++;
      };
      try {
        const db = opened.handle.value as StateImageStore;
        db.exec("CREATE TABLE sample(value INTEGER)");
        const image = db.exportImage(inspect);
        db.restoreImage(
          image,
          inspect,
          () => {},
          () => {},
        );
        expect(inspected).toBe(3);
      } finally {
        await opened.handle.close();
      }
    },
  );
}

test.skipIf(process.platform !== "win32")(
  "public SQLite singleton refuses a broad cwd for a relative database path",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-public-sqlite-cwd-"));
    const native = windowsPrivateFiles();
    try {
      native.protect(root, `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`);
      const sentinel = join(root, "borrowed.txt");
      writeFileSync(sentinel, "borrowed data");
      const descriptor = native.read(root);
      const sentinelDescriptor = native.read(sentinel);
      const script = `
        import assert from "node:assert/strict";
        const api = await import(${JSON.stringify(new URL(target, import.meta.url).href)});
        const opened = await api.sqliteStore.open({ path: "state.sqlite", readOnly: false });
        if (opened.ok) await opened.handle.close();
        assert.equal(opened.ok, false);
        assert.match(opened.unavailable.reason, /Private ACL/);
      `;
      const result = spawnSync(process.execPath, ["--eval", script], {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(native.read(root)).toBe(descriptor);
      expect(native.read(sentinel)).toBe(sentinelDescriptor);
      expect(readFileSync(sentinel, "utf8")).toBe("borrowed data");
      expect(readdirSync(root)).toEqual(["borrowed.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
