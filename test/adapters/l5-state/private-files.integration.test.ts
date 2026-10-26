// [integration] Windows native descriptors and inherited permissions on disposable stores.
import { expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { windowsPrivateFiles } from "../../../src/adapters/process/windows-acl.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";

setDefaultTimeout(30000);

test.skipIf(process.platform !== "win32")(
  "native private directory inheritance, cache invalidation and fail-closed file verification",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-native-acl-"));
    try {
      const native = windowsPrivateFiles();
      const guard = privateFileGuard(native);
      guard.directory(dir);
      const file = join(dir, "file'; throw 'must stay literal");
      writeFileSync(file, "private");
      guard.file(file);
      const privateAcl = native.read(file);
      expect(privateAcl).not.toContain(";;;WD)");
      native.protect(file, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
      expect(() => guard.file(file)).toThrow(file);
      let refusal = "";
      try {
        guard.file(file);
      } catch (error) {
        refusal = String(error);
      }
      expect(refusal).toContain("Repair in PowerShell:");
      // Repairing the directory never silently blesses a file's explicit broad entry.
      guard.directory(dir);
      expect(() => guard.file(file)).toThrow(file);
      const command = refusal.split("Repair in PowerShell: ")[1];
      expect(command).toBeDefined();
      const repair = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command!],
        { encoding: "utf8" },
      );
      expect(repair.status, repair.stderr).toBe(0);
      guard.file(file);
      expect(native.read(file)).not.toContain(";;;WD)");
      expect(readFileSync(file, "utf8")).toBe("private");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
