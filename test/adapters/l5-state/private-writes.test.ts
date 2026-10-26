import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";

test("a broadened file ACL fails closed even when file metadata is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-acl-cache-"));
  try {
    const file = join(dir, "file");
    writeFileSync(file, "private");
    const sid = "S-1-5-21-1-2-3-1001";
    let descriptor = `D:P(A;;FA;;;${sid})`;
    const guard = privateFileGuard({
      sid,
      owner: () => sid,
      read: () => descriptor,
      protect: () => {
        throw new Error("A file ACL must be refused, never repaired");
      },
    });
    guard.file(file);
    const before = lstatSync(file, { bigint: true });
    // Model Windows changing a DACL without publishing a new stat change time.
    descriptor = `D:P(A;;FA;;;${sid})(A;;FR;;;WD)`;
    expect(lstatSync(file, { bigint: true })).toEqual(before);
    expect(() => guard.file(file)).toThrow(file);
    expect(() => guard.file(file)).toThrow("Repair in PowerShell:");
    expect(() => guard.file(file)).toThrow("SetSecurityDescriptorSddlForm");
    descriptor = `D:P(A;;FA;;;${sid})`;
    guard.file(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);

async function storeWrites(parent: string): Promise<void> {
  const dir = realpathSync(parent);
  let directoryWrites = 0;
  let fileReads = 0;
  let protectedDirectory = false;
  const sid = "S-1-5-21-1-2-3-1001";
  const security = privateFileGuard({
    sid,
    owner: () => sid,
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
    expect(opened.handle.value.get("SELECT COUNT(*) AS n FROM sample")?.n).toBe(
      10n,
    );
  } finally {
    await opened.handle.close();
  }
}

test("N store writes inherit one private directory without N ACL subprocesses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-acl-writes-"));
  try {
    await storeWrites(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);

test("legacy inherited file access is narrowed only for its full-control owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-acl-upgrade-"));
  const sid = "S-1-5-21-1-2-3-1001";
  const file = join(dir, "file");
  writeFileSync(file, "private data");
  try {
    let descriptor = `D:AI(A;ID;FA;;;${sid})(A;ID;FR;;;WD)`;
    const writes: string[] = [];
    const guard = privateFileGuard({
      sid,
      owner: () => sid,
      read: () => descriptor,
      protect: (_path, next) => {
        writes.push(next);
        descriptor = next;
      },
    });
    guard.file(file);
    expect(writes).toEqual([`D:P(A;;FA;;;${sid})`]);
    expect(descriptor).toBe(`D:P(A;;FA;;;${sid})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);

test("an ownership handoff before narrowing refuses without an executable repair", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-acl-owner-handoff-"));
  const sid = "S-1-5-21-1-2-3-1001";
  const foreign = "S-1-5-21-1-2-3-1002";
  const file = join(dir, "file");
  writeFileSync(file, "private data");
  let owner = sid;
  let writes = 0;
  try {
    const guard = privateFileGuard({
      sid,
      owner: () => owner,
      read: () => {
        owner = foreign;
        return `D:AI(A;ID;FA;;;${sid})(A;ID;FR;;;WD)`;
      },
      protect: () => {
        writes++;
      },
    });
    let refusal = "";
    try {
      guard.file(file);
    } catch (error) {
      refusal = String(error);
    }
    expect(writes).toBe(0);
    expect(refusal).toContain(foreign);
    expect(refusal).not.toContain("Repair in PowerShell:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);

test("a domain Administrator RID does not prove access through the local Administrator alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-acl-alias-authority-"));
  const sid = "S-1-5-21-111-222-333-500";
  const file = join(dir, "file");
  writeFileSync(file, "private data");
  let descriptor = "D:AI(A;ID;FA;;;LA)(A;ID;FR;;;WD)";
  let writes = 0;
  try {
    const guard = privateFileGuard({
      sid,
      owner: () => sid,
      read: () => descriptor,
      protect: (_path, next) => {
        writes++;
        descriptor = next;
      },
    });
    let refusal = "";
    try {
      guard.file(file);
    } catch (error) {
      refusal = String(error);
    }
    expect(writes).toBe(0);
    expect(refusal).toContain("Private ACL");
    expect(refusal).not.toContain("Repair in PowerShell:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);

for (const scenario of [
  "explicit extra",
  "foreign owner",
  "restricted owner",
  "deny",
] as const) {
  test(`unsafe file ACL is refused without broadening access: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-acl-authority-"));
    const sid = "S-1-5-21-1-2-3-1001";
    const owner = scenario === "foreign owner" ? "S-1-5-21-1-2-3-1002" : sid;
    const descriptor =
      scenario === "explicit extra"
        ? `D:P(A;;FA;;;${sid})(A;;FR;;;WD)`
        : scenario === "restricted owner"
          ? `D:AI(A;ID;FR;;;${sid})(A;ID;FR;;;WD)`
          : scenario === "deny"
            ? `D:AI(D;ID;FW;;;WD)(A;ID;FA;;;${sid})`
            : `D:AI(A;ID;FA;;;${sid})(A;ID;FR;;;WD)`;
    const file = join(dir, "file");
    writeFileSync(file, "private data");
    const writes: string[] = [];
    try {
      const guard = privateFileGuard({
        sid,
        owner: () => owner,
        read: () => descriptor,
        protect: (_path, next) => {
          writes.push(next);
        },
      });
      let refusal = "";
      try {
        guard.file(file);
      } catch (error) {
        refusal = String(error);
      }
      expect(refusal).toContain("Private ACL");
      expect(writes).toEqual([]);
      if (scenario === "explicit extra")
        expect(refusal).toContain("Repair in PowerShell:");
      else expect(refusal).not.toContain("Repair in PowerShell:");
      if (scenario === "foreign owner") {
        expect(refusal).toContain(owner);
        expect(refusal).toMatch(/owner.*administrator/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);
}

test("store writes through a POSIX symlink parent verify its canonical directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-acl-alias-"));
  const target = mkdtempSync(join(root, "target-"));
  const alias = join(root, "alias");
  try {
    symlinkSync(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await storeWrites(alias);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
