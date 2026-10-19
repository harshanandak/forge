import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { runChild } from "../../../tools/child-runner.ts";

// A real child that never exits exercises the platform termination path; event races
// and unresponsive cleanup are covered without wall time in runner.test.ts.
test("a real stuck child produces its label and last output before the runner deadline", async () => {
  await assert.rejects(
    runChild(
      "real stuck runner child",
      process.execPath,
      [
        "-e",
        "console.log('runner child started'); setInterval(() => {}, 1000)",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1000,
        cleanupTimeoutMs: 1000,
        maxOutputBytes: 1024,
        onOutput() {},
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CHILD_TIMEOUT" &&
      error.message.includes("real stuck runner child") &&
      error.message.includes("Last stdout:"),
  );
}, 5000);

test("a normal real child returns the captured output", async () => {
  const result = await runChild(
    "normal runner child",
    process.execPath,
    ["-e", "console.log('runner result')"],
    {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 3000,
      cleanupTimeoutMs: 1000,
      maxOutputBytes: 1024,
      onOutput() {},
    },
  );
  expect(result.stdout.trim()).toBe("runner result");
  expect(result.status).toBe(0);
}, 5000);
