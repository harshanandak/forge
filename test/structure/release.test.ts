import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import assert from "node:assert/strict";

const journeySetup = "./.github/actions/journey-setup";

interface Job {
  if?: unknown;
  "continue-on-error"?: unknown;
  defaults?: { run: Record<string, string> };
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string[];
  steps: {
    if?: unknown;
    "continue-on-error"?: unknown;
    name?: string;
    shell?: string;
    "working-directory"?: string;
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
  ) as {
    on: Record<string, unknown>;
    jobs: Record<string, Job>;
    defaults: { run: Record<string, string> };
    env: Record<string, string>;
  };
}

function noLoaders(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "env" && child && typeof child === "object")
      for (const name of Object.keys(child))
        assert.doesNotMatch(
          name,
          /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_PRELOAD|NPM_CONFIG_NODE_OPTIONS|NPM_CONFIG_SCRIPT_SHELL|BASH_ENV|BASH_FUNC_.+|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|LD_.+|DYLD_.+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB)$/i,
        );
    noLoaders(child);
  }
}

function requiredReadback(w: ReturnType<typeof workflow>) {
  assert.deepEqual(w.defaults, { run: { shell: "bash" } });
  assert.deepEqual(w.env, {
    TARBALL: "${{ github.workspace }}/packed/forge-workflow.tgz",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
  });
  const version = { VERSION: "${{ needs.verify.outputs.version }}" };
  noLoaders(w);
  for (const [name, job] of Object.entries(w.jobs)) {
    assert.equal(
      job.defaults,
      undefined,
      "jobs inherit only the pinned Bash defaults",
    );
    assert.deepEqual(job.env, name === "promote" ? version : undefined);
    for (const step of job.steps) {
      assert.equal(step.shell, undefined);
      assert.equal(step["working-directory"], undefined);
    }
  }

  for (const name of ["publish", "readback", "promote"]) {
    const job = w.jobs[name]!;
    assert.equal(job.if, undefined, `${name} cannot be conditional`);
    assert.equal(job["continue-on-error"], undefined);
    for (const step of job.steps) {
      assert.equal(step.if, undefined, `${name} steps cannot be conditional`);
      assert.equal(step["continue-on-error"], undefined);
    }
  }
  const steps = w.jobs.readback!.steps;
  assert.deepEqual(
    steps.find((step) => step.uses === journeySetup),
    {
      uses: journeySetup,
      with: {
        mode: "release",
        version: version.VERSION,
        "release-run-id": "${{ inputs.run_id }}",
        "device-root": "${{ runner.temp }}/release-forge",
        "ecosystem-tools": "${{ runner.temp }}/fixture-tools",
        "python-packages": "${{ runner.temp }}/fixture-python",
      },
    },
  );
  const journey = steps.find(
    (step) => step.name === "Required registry journeys",
  );
  assert.deepEqual(journey, {
    name: "Required registry journeys",
    run: 'node tools/release/journeys.mjs "$GITHUB_WORKSPACE" "$RUNNER_TEMP/npm-smoke" "$TARBALL"',
  });
  const runs = w.jobs.readback!.steps.map((s) => s.run ?? "").join("\n");
  for (const command of [
    "npm install --ignore-scripts",
    "npm audit signatures",
    "tools/release/readback.mjs",
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
  for (const [name, job] of Object.entries(w.jobs)) {
    for (const step of job.steps) {
      if (name === "readback" && step.uses === journeySetup) continue;
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
  }
  const action = parse(
    readFileSync(
      new URL(
        "../../.github/actions/journey-setup/action.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    runs: { using: string; steps: Job["steps"] };
  };
  noLoaders(action);
  expect(action.runs.using).toBe("composite");
  expect(JSON.stringify(action)).not.toMatch(/NODE_AUTH_TOKEN|secrets\.NPM/);
  for (const step of action.runs.steps)
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
}, 1000);

test("cold installs use runner-scoped caches and the shared setup supplies the isolated store", () => {
  const job = workflow().jobs.readback;
  expect(job?.env).toBeUndefined();
  const cold = job?.steps.find((step) => step.run?.includes("npx --yes"));
  expect(cold?.env).toEqual({
    CI_RUN: "${{ inputs.run_id }}",
    npm_config_cache: "${{ runner.temp }}/release-npm-cache",
    BUN_INSTALL_CACHE_DIR: "${{ runner.temp }}/release-bun-cache",
  });
  const setup = job?.steps.find((step) => step.uses === journeySetup);
  expect(setup?.with?.["device-root"]).toBe("${{ runner.temp }}/release-forge");
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
  "commented journey",
  "swallowed journey",
  "if false",
  "ignored step failure",
  "ignored job failure",
  "conditional promotion",
  "unverified setup version",
  "unverified setup run ID",
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
    const journey = w.jobs.readback!.steps.find(
      (s) => s.name === "Required registry journeys",
    )!;
    if (change === "commented journey")
      journey.run = journey.run!.replace(
        "node tools/release/journeys.mjs",
        "# node tools/release/journeys.mjs",
      );
    if (change === "swallowed journey") journey.run += " || true";
    if (change === "if false") cold.if = false;
    if (change === "ignored step failure") cold["continue-on-error"] = true;
    if (change === "ignored job failure")
      w.jobs.readback!["continue-on-error"] = true;
    if (change === "conditional promotion") w.jobs.promote!.if = "always()";
    const setup = w.jobs.readback!.steps.find((s) => s.uses === journeySetup)!;
    if (change === "unverified setup version")
      setup.with!.version = "unverified";
    if (change === "unverified setup run ID")
      setup.with!["release-run-id"] = "0";
    expect(() => requiredReadback(w)).toThrow();
  }, 1000);
}

for (const change of [
  "step shell",
  "step directory",
  "job shell",
  "workflow shell",
  "step NODE_OPTIONS",
  "job NODE_OPTIONS",
  "workflow NODE_OPTIONS",
  "step extra env",
  "job extra env",
  "workflow extra env",
  "extra step key",
  "loader on another step",
]) {
  test(`release execution settings refuse ${change}`, () => {
    const w = workflow(),
      job = w.jobs.readback!;
    const step = job.steps.find(
      (s) => s.name === "Required registry journeys",
    )!;
    if (change === "step shell") step.shell = 'bash -c "exit 0" {0}';
    if (change === "step directory") step["working-directory"] = "foreign";
    if (change === "job shell")
      job.defaults = { run: { shell: 'bash -c "exit 0" {0}' } };
    if (change === "workflow shell")
      w.defaults.run.shell = 'bash -c "exit 0" {0}';
    const options = {
      NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)",
    };
    if (change === "step NODE_OPTIONS") step.env = options;
    if (change === "job NODE_OPTIONS") job.env = options;
    if (change === "workflow NODE_OPTIONS") Object.assign(w.env, options);
    if (change === "step extra env") step.env = { UNREVIEWED: "yes" };
    if (change === "job extra env") job.env = { UNREVIEWED: "yes" };
    if (change === "workflow extra env") w.env.UNREVIEWED = "yes";
    if (change === "extra step key")
      Object.assign(step, { uses: "foreign/action@main" });
    if (change === "loader on another step")
      job.steps[0]!.env = { BASH_ENV: "exit-zero.sh" };
    expect(() => requiredReadback(w)).toThrow();
  }, 1000);
}
