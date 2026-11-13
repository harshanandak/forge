// CI-only workerd lifecycle and single-line counterfactual in the disposable checkout.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const temp = process.env.RUNNER_TEMP;
assert(temp, "RUNNER_TEMP is required; never run this against a live Worker");
const file = "src/adapters/workers-oauth/index.ts",
  original = readFileSync(file, "utf8");
const check =
  "if (!hash || !(await options.grantRevocation.isActive(hash))) return null;";
assert.equal(
  original.split(check).length,
  2,
  "counterfactual must identify exactly one durable check",
);
let worker: ChildProcess | undefined;
async function stop() {
  if (!worker?.pid) return;
  process.kill(-worker.pid, "SIGTERM");
  worker = undefined;
  for (let n = 0; n < 40; n++) {
    try {
      await fetch("http://127.0.0.1:8788/fixture/ready", {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      return;
    }
    await delay(250);
  }
  throw new Error("OAuth fixture did not stop");
}
async function start(label: string) {
  const log = openSync(join(temp!, `oauth-${label}.log`), "w");
  worker = spawn(
    "bun",
    [
      "x",
      "wrangler",
      "dev",
      "--local",
      "--config",
      "wrangler.oauth-test.jsonc",
      "--persist-to",
      join(temp!, "oauth-storage"),
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  for (let n = 0; n < 60; n++) {
    try {
      if (
        (
          await fetch("http://127.0.0.1:8788/fixture/ready", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {
      /* startup */
    }
    await delay(1000);
  }
  throw new Error("OAuth fixture startup failed");
}
try {
  for (const mode of ["green", "counterfactual", "restored"] as const) {
    writeFileSync(
      file,
      mode === "counterfactual"
        ? original.replace(check, "if (!hash) return null;")
        : original,
    );
    await start(mode);
    const result = spawnSync("bun", ["conformance/oauth.ts"], {
      encoding: "utf8",
      timeout: 90_000,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (mode === "counterfactual") {
      assert.equal(
        result.status,
        1,
        "the same journey must fail with only durable verification removed",
      );
      assert.match(
        result.stderr,
        /FAIL OAuth holder revocation: owner access must reflect durable grant revocation \(expected 401, observed 2\d\d\)/,
      );
      console.log(
        "PASS counterfactual: revoke succeeded but subsequent access was admitted",
      );
    } else {
      assert.equal(
        result.status,
        0,
        "OAuth holder revocation journey must pass",
      );
      await stop();
      await start(`${mode}-restart`);
      const restart = spawnSync("bun", ["conformance/oauth.ts", "restart"], {
        stdio: "inherit",
        timeout: 90_000,
      });
      assert.equal(restart.status, 0, "OAuth restart journey must pass");
    }
    await stop();
  }
} finally {
  writeFileSync(file, original);
  await stop();
}
