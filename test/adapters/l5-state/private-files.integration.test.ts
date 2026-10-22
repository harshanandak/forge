// [integration] Windows native descriptors and inherited permissions on disposable stores.
import { expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      const file = join(dir, "file");
      writeFileSync(file, "private");
      guard.file(file);
      const privateAcl = native.read(file);
      expect(privateAcl).not.toContain(";;;WD)");
      native.protect(file, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
      expect(() => guard.file(file)).toThrow(file);
      expect(() => guard.file(file)).toThrow("fix its owner-only permissions");
      // Repairing the directory never silently blesses a file's explicit broad entry.
      guard.directory(dir);
      expect(() => guard.file(file)).toThrow(file);
      native.protect(file, `D:P(A;;FA;;;${native.sid})`);
      guard.file(file);
      expect(native.read(file)).not.toContain(";;;WD)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
