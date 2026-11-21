import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import assert from "node:assert/strict";

const journeySetup = "./.github/actions/journey-setup";
const publishCondition = "inputs.readback_only != true";
const recoveryCondition = "inputs.readback_only == true";
const recoverySummary = "recovery: publish skipped after byte check";

interface Job {
  if?: unknown;
  "continue-on-error"?: unknown;
  "timeout-minutes"?: number;
  defaults?: { run: Record<string, string> };
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string[];
  outputs?: Record<string, string>;
  steps: {
    if?: unknown;
    "continue-on-error"?: unknown;
    name?: string;
    id?: string;
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
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
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
  const verify = w.jobs.verify!;
  assert.equal(
    verify.outputs?.source_sha,
    "${{ steps.source.outputs.source_sha }}",
  );
  const check = verify.steps.find((step) => step.id === "check");
  assert.equal(check?.env?.READBACK_ONLY, "${{ inputs.readback_only }}");
  noLoaders(w);
  for (const [name, job] of Object.entries(w.jobs)) {
    assert.equal(job["timeout-minutes"], 10, `${name} job timeout`);
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
      let condition: string | undefined;
      if (name === "publish" && step.run?.includes("npm publish"))
        condition = publishCondition;
      if (name === "publish" && step.run?.includes(recoverySummary))
        condition = recoveryCondition;
      assert.equal(step.if, condition, `${name} step condition`);
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
  assert.match(runs, /attempt < 12; attempt\+\+/);
  assert.match(runs, /attempt === 11/);
  assert.match(runs, /AbortSignal\.timeout\(10000\)/);
  assert.match(runs, /setTimeout\(resolve, 5000\)/);
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
  expect(w.on.workflow_dispatch.inputs.readback_only).toEqual({
    description:
      "Recover a published release. next must already equal the version. The promote approval still follows.",
    default: false,
    type: "boolean",
  });
  for (const name of ["publish", "promote"]) {
    expect(w.jobs[name]?.environment).toBe("release");
    expect(w.jobs[name]?.permissions?.["id-token"]).toBe("write");
  }
  expect(w.jobs.publish?.needs).toEqual(["verify"]);
  expect(w.jobs.readback?.needs).toEqual(["verify", "publish"]);
  expect(w.jobs.promote?.needs).toEqual(["verify", "readback"]);
  const steps = w.jobs.publish!.steps;
  const publish = steps.filter((step) => step.run?.includes("npm publish"));
  const hash = steps.find((s) => s.run?.includes("process.env.EXPECTED"));
  expect(hash?.env?.EXPECTED).toBe("${{ needs.verify.outputs.sha256 }}");
  expect(hash?.run).toContain(
    'hash("sha256",readFileSync(packInput(process.env.TARBALL)))!==process.env.EXPECTED',
  );
  expect(steps.indexOf(hash!)).toBeLessThan(steps.indexOf(publish[0]!));
  expect(publish).toHaveLength(1);
  expect(publish[0]?.if).toBe(publishCondition);
  const summary = steps.find((step) => step.run?.includes(recoverySummary));
  expect(summary?.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
  expect(summary?.if).toBe(recoveryCondition);
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
    EXPECTED_COMMIT: "${{ needs.verify.outputs.source_sha }}",
    npm_config_cache: "${{ runner.temp }}/release-npm-cache",
    BUN_INSTALL_CACHE_DIR: "${{ runner.temp }}/release-bun-cache",
  });
  const setup = job?.steps.find((step) => step.uses === journeySetup);
  expect(setup?.with?.["device-root"]).toBe("${{ runner.temp }}/release-forge");
}, 1000);

test("promotion derives the channel and verifies tags around the write", () => {
  const promote = workflow().jobs.promote?.steps.find((step) =>
    step.run?.includes("npm dist-tag add"),
  );
  const run = promote?.run ?? "";
  expect(run).toMatch(
    /if \[\[ "\$VERSION" == \*-\* \]\]; then\s+TAG=beta\s+else\s+TAG=latest\s+fi/,
  );
  expect(run).toContain('npm dist-tag add "forge-workflow@$VERSION" "$TAG"');
  assert.match(run, /dist-tags\?nocache=\$\{crypto\.randomUUID\(\)\}/);
  assert.match(run, /'Cache-Control': 'no-cache'/);
  expect(run).toContain("Bun.semver.order(current, version) > 0)");
  assert.match(run, /read_tag before\n[^]*npm dist-tag add.*\nread_tag after/);
  assert.match(run, /mode === 'after' && current !== version/);
  expect(run).not.toMatch(/npm view/);
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
  const journeys = new URL("../../tools/release/journeys.mjs", import.meta.url);
  expect(readFileSync(journeys, "utf8")).toMatch(/\b480_000\b/);
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
  "conditional readback",
  "unconditional publish",
  "dispatch source",
  "changed request bound",
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
    if (change === "conditional readback") w.jobs.readback!.if = false;
    if (change === "unconditional publish") {
      const publication = w.jobs.publish!.steps.find((s) =>
        s.run?.includes("npm publish"),
      )!;
      delete publication.if;
    }
    if (change === "dispatch source")
      w.jobs.verify!.outputs!.source_sha = "${{ github.sha }}";
    if (change === "changed request bound") {
      const registry = w.jobs.readback!.steps.find((s) =>
        s.run?.includes("AbortSignal.timeout"),
      )!;
      registry.run = registry.run!.replace("10000", "10001");
    }
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
