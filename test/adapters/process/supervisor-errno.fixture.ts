import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../src/adapters/process/run.ts";

const work = realpathSync.native(
  mkdtempSync(join(tmpdir(), "forge-spawn-errno-")),
);
const platform =
  process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
async function failure(file: string): Promise<unknown> {
  try {
    await runProcess(
      file,
      [],
      {
        cwd: work,
        env: {},
        timeoutMs: 15000,
        maxOutputBytes: 0,
      },
      platform,
      {
        supervision: {
          cleanupTimeoutMs: 5000,
          pollIntervalMs: 25,
          drainTimeoutMs: 250,
          maxConcurrent: 1,
        },
      },
    );
    throw Error("Expected command spawn to fail");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const cause = error.cause;
    return {
      code: "code" in error ? error.code : undefined,
      message: error.message,
      causeCode:
        cause !== null && typeof cause === "object" && "code" in cause
          ? cause.code
          : undefined,
    };
  }
}
try {
  const missing = await failure(join(work, "not-installed"));
  let denied: unknown;
  if (process.platform !== "win32") {
    const file = join(work, "not-executable");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o600);
    denied = await failure(file);
  }
  process.stdout.write(JSON.stringify({ missing, denied }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
