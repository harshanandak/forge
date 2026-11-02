import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

interface Job {
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string[];
  steps: {
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  }[];
}
function workflow() {
  return parse(
    readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  ) as { on: Record<string, unknown>; jobs: Record<string, Job> };
}
test("release approvals, dependency chain and OIDC cannot be bypassed", () => {
  const w = workflow();
  expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
  for (const name of ["publish", "promote"]) {
    expect(w.jobs[name]?.environment).toBe("release");
    expect(w.jobs[name]?.permissions?.["id-token"]).toBe("write");
  }
  expect(w.jobs.publish?.needs).toEqual(["verify"]);
  expect(w.jobs.readback?.needs).toEqual(["verify", "publish"]);
  expect(w.jobs.promote?.needs).toEqual(["verify", "readback"]);
}, 1000);
test("release actions are immutable and no npm token is configured", () => {
  const w = workflow();
  expect(JSON.stringify(w)).not.toMatch(/NODE_AUTH_TOKEN|secrets\.NPM/);
  for (const job of Object.values(w.jobs)) {
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
  }
}, 1000);

test("cold installs use runner-scoped caches and an isolated Forge store in step context", () => {
  const job = workflow().jobs.readback;
  expect(JSON.stringify(job?.env)).not.toContain("${{ runner.");
  const cold = job?.steps.find((step) => step.run?.includes("npx --yes"));
  expect(cold?.env).toEqual({
    npm_config_cache: "${{ runner.temp }}/release-npm-cache",
    BUN_INSTALL_CACHE_DIR: "${{ runner.temp }}/release-bun-cache",
    FORGE_DEVICE_ROOT: "${{ runner.temp }}/release-forge",
  });
}, 1000);
