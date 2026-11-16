import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import assert from "node:assert/strict";

interface Job {
  if?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string[];
  steps: {
    if?: unknown;
    "continue-on-error"?: unknown;
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

function requiredReadback(w: ReturnType<typeof workflow>) {
  for (const name of ["publish", "readback", "promote"]) {
    const job = w.jobs[name]!;
    assert.equal(job.if, undefined, `${name} cannot be conditional`);
    assert.equal(job["continue-on-error"], undefined);
    for (const step of job.steps) {
      assert.equal(step.if, undefined, `${name} steps cannot be conditional`);
      assert.equal(step["continue-on-error"], undefined);
    }
  }
  const runs = w.jobs.readback!.steps.map((s) => s.run ?? "").join("\n");
  for (const command of [
    "npm install --ignore-scripts",
    "npm audit signatures",
    "tools/release/readback.mjs",
    "tools/release/journeys.mjs",
  ])
    assert.ok(runs.includes(command), `required readback command: ${command}`);
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
  const publish = w.jobs.publish?.steps.find((step) =>
    step.run?.includes("npm publish"),
  );
  expect(publish?.env?.EXPECTED).toBe("${{ needs.verify.outputs.sha256 }}");
  const run = publish?.run ?? "";
  expect(run.indexOf("process.env.EXPECTED")).toBeGreaterThan(-1);
  expect(run.indexOf("process.env.EXPECTED")).toBeLessThan(
    run.indexOf("npm publish"),
  );
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
    CHECK_ECOSYSTEM_TOOLS: "${{ runner.temp }}/fixture-tools",
    CHECK_PYTHON_PACKAGES: "${{ runner.temp }}/fixture-python",
  });
}, 1000);

test("promotion derives beta for prereleases and latest for stable versions", () => {
  const promote = workflow().jobs.promote?.steps.find((step) =>
    step.run?.includes("npm dist-tag add"),
  );
  const run = promote?.run ?? "";
  expect(run).toMatch(
    /if \[\[ "\$VERSION" == \*-\* \]\]; then\s+TAG=beta\s+else\s+TAG=latest\s+fi/,
  );
  expect(run).toContain('npm dist-tag add "forge-workflow@$VERSION" "$TAG"');
  expect(run).toContain('npm view forge-workflow "dist-tags.$TAG"');
  expect(run).not.toMatch(/npm dist-tag add[^\n]*\blatest\b/);
}, 1000);

test("promotion requires the installed registry journey and exact identity/provenance policy", () => {
  requiredReadback(workflow());
  const job = workflow().jobs.readback!;
  const runs = job.steps.map((step) => step.run ?? "").join("\n");
  expect(runs).toContain("--include-attestations");
  expect(runs).toContain("tools/release/readback.mjs");
  const proof = new URL("../../tools/release/readback.mjs", import.meta.url);
  expect(readFileSync(proof, "utf8")).toContain('"--version", "--json"');
  expect(workflow().jobs.promote?.needs).toContain("readback");
}, 1000);

for (const change of [
  "omitted",
  "if false",
  "ignored step failure",
  "ignored job failure",
  "conditional promotion",
]) {
  test(`release guard refuses ${change}`, () => {
    const w = workflow();
    const cold = w.jobs.readback!.steps.find((s) =>
      s.run?.includes("npx --yes"),
    )!;
    if (change === "omitted")
      cold.run = cold.run!.replaceAll(
        "npm audit signatures",
        "echo signatures omitted",
      );
    if (change === "if false") cold.if = false;
    if (change === "ignored step failure") cold["continue-on-error"] = true;
    if (change === "ignored job failure")
      w.jobs.readback!["continue-on-error"] = true;
    if (change === "conditional promotion") w.jobs.promote!.if = "always()";
    expect(() => requiredReadback(w)).toThrow();
  }, 1000);
}
