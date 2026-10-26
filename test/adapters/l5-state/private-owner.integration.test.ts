// [integration] Native owner SIDs on disposable Windows files and directories.
import { expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsPrivateFiles } from "../../../src/adapters/process/windows-acl.ts";

setDefaultTimeout(30000);

test.skipIf(process.platform !== "win32")(
  "native owner lookup returns the current user's raw SID and refuses a missing path",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-native-owner-"));
    try {
      const file = join(dir, "disposable-file");
      writeFileSync(file, "private");
      const native = windowsPrivateFiles();
      expect(native.sid).toMatch(/^S-1-/);
      expect(native.owner(dir)).toBe(native.sid);
      expect(native.owner(file)).toBe(native.sid);
      expect(() => native.owner(join(dir, "missing"))).toThrow(
        "Windows security API failed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);

test.skipIf(process.platform !== "win32")(
  "native DACL reads distinguish inherited and explicit file entries",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-native-inheritance-"));
    try {
      const native = windowsPrivateFiles();
      native.protect(dir, `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`);
      const file = join(dir, "inherited-file");
      writeFileSync(file, "private");
      const inherited = native.read(file);
      expect(inherited).toContain(`(A;ID;FA;;;${native.sid})`);
      expect(inherited).toMatch(/\(A;[^;]*ID;FR;;;WD\)/);
      native.protect(file, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
      const explicit = native.read(file);
      expect(explicit).toContain("(A;;FR;;;WD)");
      expect(explicit).not.toMatch(/\(A;[^;]*ID;FR;;;WD\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);

test.skipIf(process.platform !== "win32")(
  "native account aliases identify only the current SID",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-native-alias-"));
    try {
      const file = join(dir, "alias-file");
      writeFileSync(file, "private");
      const native = windowsPrivateFiles();
      expect(native.aliases).toBeArray();
      for (const [alias, sid] of [
        ["SY", "S-1-5-18"],
        ["LS", "S-1-5-19"],
        ["NS", "S-1-5-20"],
      ])
        expect(native.aliases!.includes(alias!)).toBe(native.sid === sid);
      native.protect(file, `D:P(A;;FA;;;${native.sid})`);
      const currentUser = native.read(file);
      for (const alias of native.aliases!) {
        expect(["SY", "LS", "NS", "LA"]).toContain(alias);
        native.protect(file, `D:P(A;;FA;;;${alias})`);
        expect(native.read(file)).toBe(currentUser);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
