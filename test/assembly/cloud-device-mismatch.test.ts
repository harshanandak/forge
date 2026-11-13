import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("a bound project refuses another machine's device before it loads any cloud client module", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("test/assembly/fixtures/device-mismatch.ts")],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({
    refused: true,
    code: "AUTH_DEVICE_MISMATCH",
    message: "This session is not on this machine.",
  });
}, 45_000);
