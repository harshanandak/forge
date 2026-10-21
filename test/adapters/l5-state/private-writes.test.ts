import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";

test("N store writes inherit one private directory without N ACL subprocesses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-acl-writes-"));
  let directoryWrites = 0;
  let fileReads = 0;
  let protectedDirectory = false;
  const sid = "S-1-5-21-1-2-3-1001";
  const security = privateFileGuard({
    sid,
    read(path) {
      if (path === dir)
        return protectedDirectory
          ? `D:P(A;OICI;FA;;;${sid})`
          : "D:AI(A;OICI;FA;;;WD)";
      fileReads++;
      return `D:AI(A;ID;FA;;;${sid})`;
    },
    protect(path) {
      expect(path).toBe(dir);
      protectedDirectory = true;
      directoryWrites++;
    },
  });
  try {
    const opened = await createSqliteStore(dir, { security }).open({
      path: join(dir, "store"),
      readOnly: false,
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    try {
      opened.handle.value.exec("CREATE TABLE sample(value INTEGER)");
      for (let n = 0; n < 10; n++)
        opened.handle.value.run("INSERT INTO sample VALUES (?)", [n]);
      expect(directoryWrites).toBe(1);
      expect(fileReads).toBeGreaterThan(0);
      expect(
        opened.handle.value.get("SELECT COUNT(*) AS n FROM sample")?.n,
      ).toBe(10n);
    } finally {
      await opened.handle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);
