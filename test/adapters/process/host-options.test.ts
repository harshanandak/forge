import { expect, test } from "bun:test";
import { runProcess } from "../../../src/adapters/process/run.ts";

const supervision = {
  cleanupTimeoutMs: 400,
  pollIntervalMs: 10,
  drainTimeoutMs: 100,
  maxConcurrent: 1,
};

test("a malformed strictContainment policy refuses before the POSIX fast path spawns", async () => {
  const run = runProcess(
    "/definitely/not/run",
    [],
    { cwd: ".", env: {}, timeoutMs: 1000, maxOutputBytes: 1024 },
    "linux",
    { supervision, strictContainment: "no" as unknown as boolean },
  );
  await expect(run).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
}, 5_000);

test("strict containment refuses on Linux and macOS, which have no backend", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const run = runProcess(
      "/definitely/not/run",
      [],
      {
        cwd: ".",
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        containment: "strict",
      },
      platform,
      { supervision },
    );
    await expect(run).rejects.toMatchObject({
      code: "CONTAINMENT_UNAVAILABLE",
    });
  }
}, 5_000);
