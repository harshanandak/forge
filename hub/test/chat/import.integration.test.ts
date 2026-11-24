import { strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const timeout = 30_000;
const probe = fileURLToPath(new URL("./import-probe.ts", import.meta.url));

test(
  "C9 a fresh import creates no listener, timer, API call or Slack env read",
  () => {
    const result = spawnSync(
      process.execPath,
      ["run", "--no-env-file", "--no-install", probe],
      { encoding: "utf8", env: {}, timeout: 10_000, windowsHide: true },
    );
    if (result.error) throw result.error;
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout, "chat import checked");
  },
  timeout,
);
