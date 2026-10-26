// [integration] Execute the emitted repair in every installed PowerShell edition on temp files.
import { expect, test, setDefaultTimeout } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { windowsPrivateFiles } from "../../../src/adapters/process/windows-acl.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";

setDefaultTimeout(30000);
const shells = [
  "powershell.exe",
  ...(Bun.which("pwsh") ? [Bun.which("pwsh")!] : []),
];
for (const shell of shells) {
  test.skipIf(process.platform !== "win32")(
    `directory repair is portable in ${shell}`,
    () => {
      const root = mkdtempSync(join(tmpdir(), "forge-repair-directory-"));
      try {
        const native = windowsPrivateFiles();
        privateFileGuard(native).directory(root);
        const path = join(
          root,
          "borrowed\u2019; Write-Output INJECTED; \u2019",
        );
        mkdirSync(path);
        native.protect(path, `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`);
        const guard = privateFileGuard(native, { protectDirectories: false });
        let message = "";
        try {
          guard.directory(path);
        } catch (error) {
          message = String(error);
        }
        const command = message.split(/Repair in PowerShell:\s*/)[1];
        expect(command).toBeDefined();
        const run = spawnSync(
          shell,
          ["-NoProfile", "-NonInteractive", "-Command", command!],
          {
            encoding: "utf8",
            timeout: 15000,
          },
        );
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).not.toContain("INJECTED");
        guard.directory(path);
        expect(native.read(path)).not.toContain(";;;WD)");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  for (const quote of ["'", "\u2018", "\u2019", "\u201a", "\u201b"]) {
    test.skipIf(process.platform !== "win32")(
      `repair is literal and portable in ${shell} for quote U+${quote.charCodeAt(0).toString(16)}`,
      () => {
        const root = mkdtempSync(join(tmpdir(), "forge-repair-quotes-"));
        try {
          const native = windowsPrivateFiles();
          const guard = privateFileGuard(native);
          guard.directory(root);
          const path = join(
            root,
            `file${quote}; Write-Output INJECTED; ${quote}`,
          );
          const sentinel = join(root, "sentinel");
          writeFileSync(path, "target");
          writeFileSync(sentinel, "sentinel");
          const sentinelAcl = native.read(sentinel);
          native.protect(path, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
          let message = "";
          try {
            guard.file(path);
          } catch (error) {
            message = String(error);
          }
          const command = message.split(/Repair in PowerShell:\s*/)[1];
          expect(command).toBeDefined();
          const run = spawnSync(
            shell,
            ["-NoProfile", "-NonInteractive", "-Command", command!],
            {
              encoding: "utf8",
              timeout: 15000,
            },
          );
          expect(run.status, run.stderr).toBe(0);
          expect(run.stdout).not.toContain("INJECTED");
          guard.file(path);
          expect(readFileSync(path, "utf8")).toBe("target");
          expect(native.read(sentinel)).toBe(sentinelAcl);
          expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}
