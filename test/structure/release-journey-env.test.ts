import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const setupAction = "./.github/actions/journey-setup";

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
};
type Job = { env?: Record<string, unknown>; steps?: Step[] };
type Workflow = { env?: Record<string, unknown>; jobs: Record<string, Job> };
type Selector = (run: string) => boolean;

function workflow(name: string): Workflow {
  const path = new URL(`../../.github/workflows/${name}`, import.meta.url);
  return parse(readFileSync(path, "utf8"), { maxAliasCount: 200 }) as Workflow;
}

function verifySetup(
  name: string,
  source: Workflow,
  selectsJourney: Selector,
  inputs?: Record<string, string>,
): string[] {
  const found: string[] = [];
  for (const [id, job] of Object.entries(source.jobs)) {
    const steps = job.steps ?? [];
    const journeyIndexes = steps.flatMap((step, index) =>
      selectsJourney(step.run ?? "") ? [index] : [],
    );
    if (journeyIndexes.length === 0) continue;
    found.push(id);
    const location = `${name}:${id}`;
    const setupIndexes = steps.flatMap((step, index) =>
      step.uses === setupAction ? [index] : [],
    );
    assert.ok(
      setupIndexes.length === 1 && setupIndexes[0]! < journeyIndexes[0]!,
      `${location} must use ${setupAction} before running packed journeys`,
    );
    const setup = steps[setupIndexes[0]!]!;
    if (inputs)
      assert.deepEqual(setup.with, inputs, `${location}: shared setup inputs`);
    for (const key of ["if", "continue-on-error", "env"] as const)
      assert.equal(
        setup[key],
        undefined,
        `${location}: unexpected setup ${key}`,
      );
    assert.equal(
      job.env,
      undefined,
      `${location}: journey job env belongs in the shared setup`,
    );
    for (const index of journeyIndexes)
      assert.equal(
        steps[index]!.env,
        undefined,
        `${location}: journey step env belongs in the shared setup`,
      );
    for (const step of steps.slice(0, journeyIndexes.at(-1))) {
      assert.doesNotMatch(
        step.run ?? "",
        /\bGITHUB_ENV\b|tools\/ci\/preserve-lint-runtime\.ts\b/,
        `${location}: journey environment writes belong in the shared setup`,
      );
    }
  }
  assert.ok(found.length, `${name}: no packed journey entry point found`);
  return found.sort();
}

test("CI and Release use the shared packed journey setup", () => {
  const release = workflow("release.yml");
  assert.deepEqual(
    verifySetup(
      "release.yml",
      release,
      (run) => /(?:^|\s)tools\/release\/journeys\.mjs(?:\s|$)/.test(run),
      {
        mode: "release",
        version: "${{ needs.verify.outputs.version }}",
        "release-run-id": "${{ inputs.run_id }}",
        "device-root": "${{ runner.temp }}/release-forge",
        "ecosystem-tools": "${{ runner.temp }}/fixture-tools",
        "python-packages": "${{ runner.temp }}/fixture-python",
      },
    ),
    ["readback"],
  );
  const ci = workflow("ci.yml");
  assert.deepEqual(
    verifySetup(
      "ci.yml",
      ci,
      (run) => /^\s*bun run test:pack(?:\s|$)/.test(run),
      {
        mode: "ci",
        node: "${{ matrix.node }}",
        shard: "${{ matrix.shard || matrix.suite }}",
        artifact:
          "${{ matrix.suite != 'tests' && format('{0}/packed/forge-workflow.tgz', runner.temp) || '' }}",
        sha256: "${{ needs.pack.outputs.sha256 }}",
        version: "${{ needs.pack.outputs.version }}",
      },
    ),
    ["verify", "verify-nightly"],
  );
  assert.deepEqual(Object.keys(release.env ?? {}).sort(), [
    "NPM_CONFIG_REGISTRY",
    "TARBALL",
  ]);
  assert.deepEqual(Object.keys(ci.env ?? {}).sort(), [
    "BUN_VERSION",
    "CI_HEAD",
  ]);
  const bunStep = (job: Job): Step | undefined =>
    job.steps?.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  const releaseBun = bunStep(release.jobs.readback!);
  assert.match(releaseBun?.uses ?? "", /@[a-f0-9]{40}$/);
  assert.equal(releaseBun?.with?.["bun-version"], ci.env?.BUN_VERSION);
  for (const id of ["verify", "verify-nightly"]) {
    const ciBun = bunStep(ci.jobs[id]!);
    assert.equal(ciBun?.uses, releaseBun?.uses);
    assert.equal(ciBun?.with?.["bun-version"], "${{ env.BUN_VERSION }}");
  }
}, 1000);

for (const change of [
  "missing",
  "late",
  "conditional",
  "ignored failure",
  "setup env",
  "job env",
  "journey env",
  "bash write",
  "PowerShell write",
  "legacy exporter",
]) {
  test(`packed journey setup rejects ${change}`, () => {
    const setup: Step = { uses: setupAction };
    const journey: Step = { run: "journey" };
    const job: Job = { steps: [setup, journey] };
    if (change === "missing") job.steps = [journey];
    if (change === "late") job.steps = [journey, setup];
    if (change === "conditional") setup.if = false;
    if (change === "ignored failure") setup["continue-on-error"] = true;
    if (change === "setup env") setup.env = { PROOF: "setup" };
    if (change === "job env") job.env = { PROOF: "job" };
    if (change === "journey env") journey.env = { PROOF: "journey" };
    if (change === "bash write")
      job.steps!.unshift({ run: 'echo "PROOF=x" >> "$GITHUB_ENV"' });
    if (change === "PowerShell write")
      job.steps!.unshift({ run: '"PROOF=x" >> $env:GITHUB_ENV' });
    if (change === "legacy exporter")
      job.steps!.unshift({
        run: "tools/ci/preserve-lint-runtime.ts",
      });
    expect(() =>
      verifySetup(
        "release.yml",
        { jobs: { readback: job } },
        (run) => run === "journey",
      ),
    ).toThrow("release.yml:readback");
  }, 1000);
}
