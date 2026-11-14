// CI-only workerd lifecycle and single-line counterfactual in the disposable checkout.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { duplicateCanary } from "./refresh-canary.ts";

const temp = process.env.RUNNER_TEMP;
assert(temp, "RUNNER_TEMP is required; never run this against a live Worker");
const file = "src/adapters/workers-oauth/index.ts",
  original = readFileSync(file, "utf8");
const grantFile = "src/adapters/workers-oauth/grant-state.ts",
  grantSource = readFileSync(grantFile, "utf8"),
  claim = "await this.#claim(input)";
assert.equal(
  grantSource.split(claim).length,
  2,
  "claim counterfactual must edit exactly once",
);
const check =
  "if (!hash || !(await options.grantRevocation.isActive(hash))) return null;";
assert.equal(
  original.split(check).length,
  2,
  "counterfactual must identify exactly one durable check",
);
let worker: ChildProcess | undefined;
const logs: string[] = [];
const ready = () =>
  fetch("http://127.0.0.1:8788/fixture/ready", {
    signal: AbortSignal.timeout(1000),
  });
async function stop() {
  if (!worker?.pid) return;
  process.kill(-worker.pid, "SIGTERM");
  worker = undefined;
  for (let n = 0; n < 40; n++) {
    try {
      await ready();
    } catch {
      return;
    }
    await delay(250);
  }
  throw new Error("OAuth fixture did not stop");
}
async function start(label: string) {
  process.env.OAUTH_CONFORMANCE_MODE = label;
  console.log(`OAuth runner mode: ${label}`);
  const path = join(temp!, `oauth-${label}.log`);
  logs.push(path);
  const log = openSync(path, "w");
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
      if ((await ready()).ok) return;
    } catch {
      /* startup */
    }
    await delay(1000);
  }
  throw new Error("OAuth fixture startup failed");
}
try {
  for (const mode of [
    "green",
    "counterfactual",
    "claim-removed",
    "restored",
  ] as const) {
    writeFileSync(
      grantFile,
      mode === "claim-removed"
        ? grantSource.replace(claim, "200")
        : grantSource,
    );
    writeFileSync(
      file,
      mode === "counterfactual"
        ? original.replace(check, "if (!hash) return null;")
        : original,
    );
    await start(mode);
    if (mode === "claim-removed") {
      const race = spawnSync("bun", ["conformance/refresh-race.ts"], {
        encoding: "utf8",
        timeout: 90_000,
      });
      process.stdout.write(race.stdout);
      process.stderr.write(race.stderr);
      assert.equal(
        race.status,
        1,
        "race must fail with only refresh admission removed",
      );
      assert.match(
        race.stderr,
        /one provider entry required \(observed 2; statuses 200,200\)/,
      );
      console.log(
        "PASS claim-removal counterfactual: two real provider entries and two responses",
      );
      await stop();
      continue;
    }
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
      const refreshed = spawnSync("bun", ["conformance/refresh.ts"], {
        stdio: "inherit",
        timeout: 90_000,
      });
      assert.equal(
        refreshed.status,
        0,
        "OAuth guarded refresh journey must pass",
      );
      assert.equal(
        spawnSync("bun", ["conformance/refresh-race.ts"], {
          stdio: "inherit",
          timeout: 90_000,
        }).status,
        0,
        "real-DO refresh overlap must pass",
      );
      await stop();
      await start(`${mode}-restart`);
      const restart = spawnSync("bun", ["conformance/oauth.ts", "restart"], {
        stdio: "inherit",
        timeout: 90_000,
      });
      assert.equal(restart.status, 0, "OAuth restart journey must pass");
      assert.equal(
        spawnSync("bun", ["conformance/refresh-race.ts", "restart"], {
          stdio: "inherit",
          timeout: 90_000,
        }).status,
        0,
        "spent-refresh restart must pass",
      );
    }
    await stop();
  }
} finally {
  writeFileSync(file, original);
  writeFileSync(grantFile, grantSource);
  await stop();
  for (const path of logs)
    assert(
      !readFileSync(path, "utf8").includes(duplicateCanary),
      "duplicate canary must not reach Worker logs",
    );
}
