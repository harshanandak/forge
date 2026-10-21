// [integration] Real Windows ACL changes on disposable files, through the real process adapter.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import { hardenPrivatePaths } from "../../../src/adapters/store-sqlite/private-acl.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";

setDefaultTimeout(60000);

const real = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
const results: ProcessResult[] = [];
const recording: ProcessPort = {
  ...real,
  async run(executable, args, options) {
    const result = await real.run(executable, args, options);
    results.push(result);
    return result;
  },
};
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined) env[name] = value;
}

test.skipIf(process.platform !== "win32")(
  "integration: a Windows ACL failure names its cause, and success writes nothing to stderr",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-private-acl-"));
    try {
      const file = join(dir, "store");
      writeFileSync(file, "store");
      // An explicit entry that /grant:r alone would keep.
      const icacls = real.resolve(
        join(env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe"),
        env,
      );
      if (icacls.kind !== "resolved") throw new Error(icacls.reason);
      const granted = await real.run(icacls, [file, "/grant", "*S-1-1-0:R"], {
        cwd: dir,
        env,
        timeoutMs: 30000,
        maxOutputBytes: 4096,
      });
      expect(granted.exitCode).toBe(0);
      results.length = 0;
      await hardenPrivatePaths([file, dir], recording, env);
      // Progress records went to the bounded stderr before, crowding out any real error.
      expect(results.map((result) => result.stderr).join("")).toBe("");
      expect(results.length).toBeGreaterThan(0);
      await expect(
        hardenPrivatePaths([join(dir, "missing")], recording, env),
      ).rejects.toThrow(
        /Private ACL application or verification failed.*missing/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
