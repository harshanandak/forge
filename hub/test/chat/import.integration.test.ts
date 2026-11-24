import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const timeout = 30_000;
const probe = fileURLToPath(new URL("./import-probe.ts", import.meta.url));

function runProbe(effect?: string) {
  const args = effect === undefined ? [probe] : [probe, effect];
  const result = spawnSync(
    process.execPath,
    ["run", "--no-env-file", "--no-install", ...args],
    { encoding: "utf8", env: {}, timeout: 10_000, windowsHide: true },
  );
  if (result.error) throw result.error;
  return result;
}

test(
  "C9 a fresh import creates no listener, timer, API call or Slack env read",
  () => {
    const result = runProbe();
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout, "chat import checked");
  },
  timeout,
);

for (const [effect, evidence] of [
  ["env", "Slack environment reads"],
  ["process listener", "process listener"],
  ["timer", "timer"],
  ["scheduler wait", "scheduler wait"],
  ["scheduler yield", "scheduler yield"],
  ["server listener", "server listener"],
] as const) {
  test(
    `C9 rejects import-time ${effect} even if the module continues`,
    () => {
      const result = runProbe(effect);
      strictEqual(result.status, 1, result.stderr);
      strictEqual(result.stdout, "");
      ok(
        result.stderr.includes("AssertionError") &&
          result.stderr.includes(evidence),
        result.stderr,
      );
    },
    timeout,
  );
}
