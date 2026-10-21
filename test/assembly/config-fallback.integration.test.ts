import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("config apply exposes formatting fallback as a call-local envelope warning under Node", () => {
  const result = spawnSync(
    "node",
    [
      fileURLToPath(
        new URL("../node-fixtures/config/fallback.mjs", import.meta.url),
      ),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("PASS config fallback");
}, 90_000);
