// [integration] CLI output and copyable native ACL repair on a disposable device store.
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { windowsPrivateFiles } from "../../src/adapters/process/windows-acl.ts";
import {
  createAssembly,
  localCall,
  type Assembly,
} from "../../src/assembly/index.ts";
import { LocalState, StateUnavailable } from "../../src/assembly/state.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { runCommand } from "../../src/surface/command.ts";

setDefaultTimeout(30_000);

async function configShow(assembly: Assembly) {
  const output = new PassThrough();
  let stdout = "";
  output.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const exitCode = await runCommand(["config", "show"], {
    catalog: assembly.catalog,
    version: "0.0.0",
    call: localCall(assembly),
    output,
  });
  output.end();
  return { exitCode, envelope: JSON.parse(stdout) as ResultEnvelope };
}

test("an ACL refusal keeps the repair command as the final message line", () => {
  const reason =
    "Error: Private ACL verification failed for store. Stop Forge connections, then repair and retry. Repair in PowerShell:\n$acl = repair";
  const unavailable = {
    kind: "unavailable" as const,
    reason,
    remedy: "Use a supported runtime and a readable local store path",
  };
  const error = new StateUnavailable(unavailable);
  expect(error.error.message).toBe(reason);
  expect(error.unavailable).toBe(unavailable);
});

test("other unavailable state errors retain their remedy", () => {
  const error = new StateUnavailable({
    kind: "unavailable",
    reason: "SQLite runtime is unavailable",
    remedy: "Use a supported runtime and a readable local store path",
  });
  expect(error.error.message).toBe(
    "SQLite runtime is unavailable; Use a supported runtime and a readable local store path",
  );
});

test("an ACL refusal without an executable repair retains its own guidance", () => {
  const reason =
    "Error: Private ACL refused for store; ask the owner to grant the current user access";
  const error = new StateUnavailable({
    kind: "unavailable",
    reason,
    remedy: "Use a supported runtime and a readable local store path",
  });
  expect(error.error.message).toBe(reason);
});

test.skipIf(process.platform !== "win32")(
  "CLI ACL refusal ends its message with a directly executable PowerShell repair",
  async () => {
    const work = mkdtempSync(join(tmpdir(), "forge-state-acl-cli-"));
    let assembly: Assembly | undefined;
    try {
      const root = join(work, "project");
      const deviceRoot = join(work, "device");
      mkdirSync(root);
      mkdirSync(deviceRoot);
      mkdirSync(join(root, ".forge"));
      writeFileSync(join(root, ".forge/config.yaml"), "blocks: {}\n");
      const native = windowsPrivateFiles();
      native.protect(deviceRoot, `D:P(A;OICI;FA;;;${native.sid})`);
      const path = join(deviceRoot, "trust.sqlite");
      const state = new LocalState(path);
      try {
        await state.open(true);
      } finally {
        await state.close();
      }
      // An explicit broad grant must be refused even when legacy inherited ACLs are repaired.
      native.protect(path, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
      const broad = native.read(path);
      assembly = await createAssembly({ root, deviceRoot });
      const failed = await configShow(assembly);
      expect(failed.exitCode).toBe(1);
      expect(failed.envelope).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      if (failed.envelope.ok) throw new Error("Expected an ACL refusal");
      expect(native.read(path)).toBe(broad);
      const marker = "Repair in PowerShell:\n";
      const message = failed.envelope.error.message;
      expect(message).toContain(marker);
      expect(message).not.toContain("Use a supported runtime");
      const command = message.split(marker)[1];
      expect(command).toMatch(/^\$acl = [^\r\n]+$/);
      if (command === undefined) throw new Error("Missing repair command");
      await assembly.close();
      assembly = undefined;
      const repaired = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      );
      expect(repaired.status, repaired.stderr).toBe(0);
      assembly = await createAssembly({ root, deviceRoot });
      const retried = await configShow(assembly);
      expect(retried.exitCode, JSON.stringify(retried.envelope)).toBe(0);
      expect(retried.envelope.ok).toBe(true);
    } finally {
      await assembly?.close();
      rmSync(work, { recursive: true, force: true });
    }
  },
);
