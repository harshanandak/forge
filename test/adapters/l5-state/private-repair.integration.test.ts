// [integration] Execute the emitted repair in every installed PowerShell edition on temp files.
import { afterAll, expect, test, setDefaultTimeout } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerShellBatch } from "../../child-step.ts";
import { windowsPrivateFiles } from "../../../src/adapters/process/windows-acl.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";

setDefaultTimeout(30000);
const shells = [
  "powershell.exe",
  ...(Bun.which("pwsh") ? [Bun.which("pwsh")!] : []),
];
const quotes = ["'", "\u2018", "\u2019", "\u201a", "\u201b"];
const batch = powerShellBatch();
const started = performance.now();
const roots: string[] = [];
let checked = 0;
afterAll(() => {
  try {
    if (process.platform === "win32") {
      expect(quotes).toHaveLength(5);
      expect(roots).toHaveLength(5 * shells.length);
      expect(checked).toBe(5 * shells.length);
      expect(batch.launches).toBe(shells.length + 1);
      console.log(
        `private-repair: ${Math.round(performance.now() - started)} ms (study 4559.32 ms); PowerShell launches ${batch.launches} (was ${5 * shells.length + 1})`,
      );
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
test.skipIf(process.platform !== "win32")(
  "borrowed folder refusal gives guidance without changing its tree or siblings",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-repair-directory-"));
    try {
      const native = windowsPrivateFiles();
      privateFileGuard(native).directory(root);
      const path = join(root, "borrowed\u2019; Write-Output INJECTED; \u2019");
      mkdirSync(path);
      native.protect(path, `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`);
      const sibling = join(root, "sibling.txt");
      const file = join(path, "file.txt");
      const nested = join(path, "nested");
      const nestedFile = join(nested, "file.txt");
      writeFileSync(sibling, "sibling data");
      writeFileSync(file, "folder data");
      mkdirSync(nested);
      writeFileSync(nestedFile, "nested data");
      const snapshot = () => ({
        directories: [root, path, nested].map((directory) => ({
          acl: native.read(directory),
          entries: readdirSync(directory),
        })),
        files: [sibling, file, nestedFile].map((entry) => ({
          acl: native.read(entry),
          bytes: readFileSync(entry),
        })),
      });
      const before = snapshot();
      const guard = privateFileGuard(native, { protectDirectories: false });
      let message = "";
      try {
        guard.directory(path);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("Private ACL verification failed");
      expect(message).toContain(
        "Move the store into a folder only you can access.",
      );
      expect(message).not.toContain("let Forge create");
      expect(message).not.toContain("Repair in PowerShell:");
      expect(message).not.toMatch(
        /SetAccessControl|SetSecurityDescriptorSddlForm|DirectorySecurity|Set-Acl|icacls/i,
      );
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform !== "win32")(
  "PowerShell timeout names the running command phase",
  async () => {
    await expect(
      batch.run(
        "powershell.exe",
        [
          { name: "completed probe", command: "Write-Output ready" },
          { name: "deadline probe", command: "Start-Sleep -Seconds 60" },
        ],
        5000,
      ),
    ).rejects.toThrow(
      /timeout; phase=command; case=deadline probe;.*spawn.*firstOutput.*commandStart.*exit/,
    );
  },
  10000,
);
for (const shell of shells) {
  async function prepare() {
    const cases = quotes.map((quote) => {
      const root = mkdtempSync(join(tmpdir(), "forge-repair-quotes-"));
      roots.push(root);
      const native = windowsPrivateFiles();
      const guard = privateFileGuard(native);
      guard.directory(root);
      const path = join(root, `file${quote}; Write-Output INJECTED; ${quote}`);
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
      return {
        name: `quote U+${quote.charCodeAt(0).toString(16)}`,
        command: command!,
        path,
        sentinel,
        sentinelAcl,
        guard,
        native,
      };
    });
    expect(cases).toHaveLength(5);
    const runs = await batch.run(shell, cases, 15000);
    expect(runs).toHaveLength(cases.length);
    return cases.map((entry, index) => ({ ...entry, run: runs[index]! }));
  }
  let prepared: ReturnType<typeof prepare> | undefined;
  for (const [index, quote] of quotes.entries()) {
    test.skipIf(process.platform !== "win32")(
      `repair is literal and portable in ${shell} for quote U+${quote.charCodeAt(0).toString(16)}`,
      async () => {
        prepared ??= prepare();
        const { run, path, sentinel, sentinelAcl, guard, native, name } = (
          await prepared
        )[index]!;
        expect(run.name).toBe(name);
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).not.toContain("INJECTED");
        guard.file(path);
        expect(readFileSync(path, "utf8")).toBe("target");
        expect(native.read(sentinel)).toBe(sentinelAcl);
        expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
        checked += 1;
      },
    );
  }
}
