import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import {
  runsPackedJourney,
  stepCommands,
  type Matrix,
} from "./lib/packed-journey.ts";

const setupAction = "./.github/actions/journey-setup";
const workflowRunDefaults = { shell: "bash" };

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
  shell?: string;
  "working-directory"?: string;
};
type Defaults = { run?: Record<string, unknown> };
type Job = {
  env?: Record<string, unknown>;
  defaults?: Defaults;
  strategy?: { matrix?: Matrix };
  steps?: Step[];
};
type Workflow = {
  env?: Record<string, unknown>;
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

function workflow(name: string): Workflow {
  const path = new URL(`../../.github/workflows/${name}`, import.meta.url);
  return parse(readFileSync(path, "utf8"), { maxAliasCount: 200 }) as Workflow;
}

function verifySetup(
  name: string,
  source: Workflow,
  inputs?: Record<string, string>,
): string[] {
  const found: string[] = [];
  for (const [id, job] of Object.entries(source.jobs)) {
    const steps = job.steps ?? [];
    const commands = steps.map((step) =>
      stepCommands(step.run ?? "", job.strategy?.matrix),
    );
    const journeyIndexes = commands.flatMap((variants, index) =>
      variants.some((run) => runsPackedJourney(run)) ? [index] : [],
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
    assert.deepEqual(
      source.defaults?.run,
      workflowRunDefaults,
      `${location}: workflow defaults.run must be Bash in the workspace`,
    );
    assert.equal(
      job.defaults?.run,
      undefined,
      `${location}: unexpected journey job defaults.run`,
    );
    assert.equal(
      job.env,
      undefined,
      `${location}: journey job env belongs in the shared setup`,
    );
    for (const index of journeyIndexes)
      for (const key of ["env", "shell", "working-directory"] as const)
        assert.equal(
          steps[index]![key],
          undefined,
          `${location}: unexpected journey step ${key}`,
        );
    for (const run of commands.flat())
      assert.doesNotMatch(
        run,
        /\bGITHUB_(?:ENV|PATH)\b|tools[\\/]ci[\\/]preserve-lint-runtime\.ts\b/i,
        `${location}: journey environment and PATH writes belong in the shared setup`,
      );
  }
  assert.ok(found.length, `${name}: no packed journey entry point found`);
  return found.sort();
}

describe("Accidental packed journey environment drift between CI and Release. Code owners review workflow changes. Hostile workflow edits are out of scope.", () => {
  test("CI and Release use the shared packed journey setup", () => {
    const release = workflow("release.yml");
    assert.deepEqual(
      verifySetup("release.yml", release, {
        mode: "release",
        version: "${{ needs.verify.outputs.version }}",
        "release-run-id": "${{ inputs.run_id }}",
        "device-root": "${{ runner.temp }}/release-forge",
        "ecosystem-tools": "${{ runner.temp }}/fixture-tools",
        "python-packages": "${{ runner.temp }}/fixture-python",
      }),
      ["readback"],
    );
    const ci = workflow("ci.yml");
    const ciJobs = verifySetup("ci.yml", ci, {
      mode: "ci",
      node: "${{ matrix.node }}",
      shard: "${{ matrix.shard || matrix.suite }}",
      artifact:
        "${{ matrix.suite != 'tests' && format('{0}/packed/forge-workflow.tgz', runner.temp) || '' }}",
      sha256: "${{ needs.pack.outputs.sha256 }}",
      version: "${{ needs.pack.outputs.version }}",
    });
    assert.deepEqual(ciJobs, ["verify", "verify-main", "verify-node26"]);
    assert.deepEqual(Object.keys(release.env ?? {}).sort(), [
      "NPM_CONFIG_REGISTRY",
      "TARBALL",
    ]);
    assert.deepEqual(Object.keys(ci.env ?? {}).sort(), [
      "BUN_VERSION",
      "CI_BUILD_SHA",
      "CI_HEAD",
      "COMMENT_GUARD_PATHS",
    ]);
    const bunStep = (job: Job): Step | undefined =>
      job.steps?.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    const releaseBun = bunStep(release.jobs.readback!);
    assert.match(releaseBun?.uses ?? "", /@[a-f0-9]{40}$/);
    assert.equal(releaseBun?.with?.["bun-version"], ci.env?.BUN_VERSION);
    for (const id of ciJobs) {
      const ciBun = bunStep(ci.jobs[id]!);
      assert.equal(ciBun?.uses, releaseBun?.uses);
      assert.equal(ciBun?.with?.["bun-version"], "${{ env.BUN_VERSION }}");
    }
  }, 1000);

  const setup: Step = { uses: setupAction };
  const pack: Step = { run: "bun run test:pack" };
  const directPack = parse("run: node tools/pack-smoke/run.ts") as Step;
  const setupMissing = `must use ${setupAction} before running packed journeys`;
  const writeOutside =
    "journey environment and PATH writes belong in the shared setup";

  const cases: {
    name: string;
    steps: Step[];
    message: string;
    job?: Omit<Job, "steps">;
    defaults?: Defaults;
  }[] = [
    { name: "missing setup", steps: [pack], message: setupMissing },
    { name: "late setup", steps: [pack, setup], message: setupMissing },
    {
      name: "a second direct pack invocation before setup",
      steps: [directPack, setup, pack],
      message: setupMissing,
    },
    {
      name: "a launcher after another command",
      steps: [{ run: "echo starting && bun run test:pack" }, setup, pack],
      message: setupMissing,
    },
    {
      name: "an installed journey launcher on a later script line",
      steps: [
        { run: "echo starting\nbun ./tools/release/journeys.mjs" },
        setup,
        pack,
      ],
      message: setupMissing,
    },
    {
      name: "a package script which calls the pack script",
      steps: [{ run: "bun run test" }, setup, pack],
      message: setupMissing,
    },
    {
      name: "an included matrix command before setup",
      steps: [{ run: "${{ matrix.command }}" }, setup, pack],
      job: { strategy: { matrix: { include: [{ command: directPack.run }] } } },
      message: setupMissing,
    },
    {
      name: "a package script from a matrix axis",
      steps: [{ run: "bun run ${{ matrix['script'] }}" }, setup, pack],
      job: { strategy: { matrix: { script: ["test:pack"] } } },
      message: setupMissing,
    },
    {
      name: "conditional setup",
      steps: [{ ...setup, if: false }, pack],
      message: "unexpected setup if",
    },
    {
      name: "ignored setup failure",
      steps: [{ ...setup, "continue-on-error": true }, pack],
      message: "unexpected setup continue-on-error",
    },
    {
      name: "setup env",
      steps: [{ ...setup, env: { PROOF: "setup" } }, pack],
      message: "unexpected setup env",
    },
    {
      name: "job env",
      steps: [setup, pack],
      job: { env: { PROOF: "job" } },
      message: "journey job env belongs in the shared setup",
    },
    {
      name: "journey step env",
      steps: [setup, { ...pack, env: { PROOF: "journey" } }],
      message: "unexpected journey step env",
    },
    {
      name: "a different shell on a second journey step",
      steps: [setup, pack, { ...directPack, shell: "pwsh" }],
      message: "unexpected journey step shell",
    },
    {
      name: "a journey step working directory",
      steps: [setup, { ...pack, "working-directory": "cloud" }],
      message: "unexpected journey step working-directory",
    },
    {
      name: "job run defaults",
      steps: [setup, pack],
      job: { defaults: { run: { shell: "pwsh" } } },
      message: "unexpected journey job defaults.run",
    },
    {
      name: "workflow shell defaults",
      steps: [setup, pack],
      defaults: { run: { shell: "pwsh" } },
      message: "workflow defaults.run must be Bash in the workspace",
    },
    {
      name: "workflow working directory defaults",
      steps: [setup, pack],
      defaults: {
        run: { ...workflowRunDefaults, "working-directory": "cloud" },
      },
      message: "workflow defaults.run must be Bash in the workspace",
    },
    {
      name: "a legacy exporter",
      steps: [{ run: "tools/ci/preserve-lint-runtime.ts" }, setup, pack],
      message: writeOutside,
    },
    ...[
      ["Bash GITHUB_ENV", 'echo "PROOF=x" >> "$GITHUB_ENV"'],
      ["PowerShell GITHUB_ENV", '"PROOF=x" >> $env:GITHUB_ENV'],
      ["Bash GITHUB_PATH", 'echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"'],
      ["PowerShell GITHUB_PATH", '"$env:RUNNER_TEMP/bin" >> $env:GITHUB_PATH'],
    ].map(([name, run]) => ({
      name: `a ${name} write after the journey`,
      steps: [setup, pack, { run: run! }],
      message: writeOutside,
    })),
  ];

  for (const { name, steps, message, job, defaults } of cases) {
    test(`packed journey setup rejects ${name}`, () => {
      const fixture = stringify({
        defaults: defaults ?? { run: workflowRunDefaults },
        jobs: { packed: { ...job, steps } },
      });
      const expected =
        message === setupMissing
          ? `fixture.yml:packed ${message}`
          : `fixture.yml:packed: ${message}`;
      expect(() =>
        verifySetup("fixture.yml", parse(fixture) as Workflow),
      ).toThrow(expected);
    }, 1000);
  }
});
