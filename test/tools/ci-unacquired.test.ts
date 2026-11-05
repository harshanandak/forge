import { expect, setDefaultTimeout, test } from "bun:test";
import {
  decideRerun,
  type CiJob,
  type CiRun,
  type CurrentRun,
} from "../../tools/ci-unacquired.ts";

setDefaultTimeout(1000);

// Selected API fields from run 41675649854, attempt 2; steps retain API objects.
const unacquired: CiJob = {
  name: "Verify (macos-latest, Node 26, pack)",
  conclusion: "cancelled",
  runner_name: "",
  steps: [],
};
const gate: CiJob = {
  name: "CI Gate",
  conclusion: "failure",
  runner_name: "GitHub Actions 1000127470",
  steps: [
    { name: "Set up job", conclusion: "success" },
    { name: 'Run if [ -n "$STARTED" ]; then', conclusion: "failure" },
    { name: "Complete job", conclusion: "success" },
  ],
};
const success: CiJob = {
  name: "PR title",
  conclusion: "success",
  runner_name: "GitHub Actions 1000127344",
  steps: [
    { name: "Set up job", conclusion: "success" },
    { name: "Check title", conclusion: "success" },
    { name: "Complete job", conclusion: "success" },
  ],
};
const realFailure: CiJob = {
  ...unacquired,
  conclusion: "failure",
  runner_name: "GitHub Actions runner",
  steps: [{ name: "Unit tests", conclusion: "failure" }],
};
const run: CiRun = {
  conclusion: "failure",
  run_attempt: 2,
  jobs: [success, unacquired, gate],
};
const current: CurrentRun = {
  run_attempt: 2,
  status: "completed",
  conclusion: "failure",
};
const queued = {
  ...unacquired,
  status: "queued",
  conclusion: null,
};
const queuedNullRunner = { ...queued, runner_name: null };

test("reruns a queued never-acquired job with a null runner name", () => {
  for (const run_attempt of [1, 2]) {
    expect(
      decideRerun(
        { ...run, run_attempt, jobs: [success, queuedNullRunner, gate] },
        { ...current, run_attempt },
      ).rerun,
    ).toBe(true);
  }
});

test("reruns a queued never-acquired job and failed gate on a completed run", () => {
  for (const run_attempt of [1, 2]) {
    expect(
      decideRerun(
        { ...run, run_attempt, jobs: [success, queued, gate] },
        { ...current, run_attempt },
      ).rerun,
    ).toBe(true);
  }
});

for (const [name, input] of [
  ["real test failure", { ...run, jobs: [queued, realFailure, gate] }],
  [
    "null runner name and real test failure",
    { ...run, jobs: [queuedNullRunner, realFailure, gate] },
  ],
  [
    "assigned runner",
    { ...run, jobs: [{ ...queued, runner_name: "assigned runner" }, gate] },
  ],
  [
    "recorded steps",
    { ...run, jobs: [{ ...queued, steps: realFailure.steps }, gate] },
  ],
  ["third attempt", { ...run, run_attempt: 3, jobs: [queued, gate] }],
] satisfies [string, CiRun][]) {
  test(`does not rerun a queued job with ${name}`, () => {
    expect(
      decideRerun(input, { ...current, run_attempt: input.run_attempt }).rerun,
    ).toBe(false);
  });
}

test("reruns a never-acquired macOS job and failed gate on attempts 1 and 2", () => {
  for (const run_attempt of [1, 2]) {
    const decision = decideRerun(
      { ...run, run_attempt },
      { ...current, run_attempt },
    );
    expect(decision.rerun).toBe(true);
    expect(decision.reason).toContain("never-acquired");
  }
});

const skipped: CiJob = {
  name: "PR title",
  conclusion: "skipped",
  runner_name: "",
  steps: [],
};
for (const [name, jobs] of [
  [
    "push to main with PR title skipped",
    [
      skipped,
      { ...success, name: "Changes" },
      { ...success, name: "Structure guards" },
      { ...success, name: "Pack artifact" },
      unacquired,
      gate,
    ],
  ],
  [
    "docs-only PR with pack and verify skipped",
    [
      success,
      { ...success, name: "Changes" },
      { ...success, name: "Structure guards" },
      { ...skipped, name: "Pack artifact" },
      { ...skipped, name: unacquired.name },
      { ...unacquired, name: "Lint and format" },
      gate,
    ],
  ],
] satisfies [string, CiJob[]][]) {
  test(`reruns a never-acquired job: ${name}`, () => {
    expect(decideRerun({ ...run, jobs }, current).rerun).toBe(true);
  });

  test(`does not rerun a real failure: ${name}`, () => {
    expect(
      decideRerun(
        { ...run, jobs: [...jobs, { ...realFailure, name: "Unit tests" }] },
        current,
      ).rerun,
    ).toBe(false);
  });
}

for (const [name, input] of [
  ["real test failure", { ...run, jobs: [success, realFailure, gate] }],
  [
    "cancellation after starting, even without a recorded runner",
    { ...run, jobs: [{ ...unacquired, steps: realFailure.steps }, gate] },
  ],
  [
    "assigned runner even with zero steps",
    { ...run, jobs: [{ ...unacquired, runner_name: "assigned runner" }, gate] },
  ],
  [
    "mixed allocation and real failures",
    { ...run, jobs: [...run.jobs, realFailure] },
  ],
  ["third attempt", { ...run, run_attempt: 3 }],
  ["later attempt", { ...run, run_attempt: 4 }],
  ["cancelled run", { ...run, conclusion: "cancelled" }],
  ["successful run", { ...run, conclusion: "success" }],
  ["gate failure alone", { ...run, jobs: [success, gate] }],
  ["no jobs", { ...run, jobs: [] }],
  [
    "only skipped non-success jobs without a never-acquired job",
    {
      ...run,
      jobs: [success, skipped, { ...skipped, name: "Pack artifact" }],
    },
  ],
  [
    "timed-out job alongside allocation failure",
    {
      ...run,
      jobs: [...run.jobs, { ...realFailure, conclusion: "timed_out" }],
    },
  ],
  [
    "failure with no runner or steps",
    { ...run, jobs: [{ ...unacquired, conclusion: "failure" }, gate] },
  ],
  ["unfinished conclusion", { ...run, conclusion: null }],
] satisfies [string, CiRun][]) {
  test(`does not rerun: ${name}`, () => {
    const decision = decideRerun(input, {
      ...current,
      run_attempt: input.run_attempt,
    });
    expect(decision.rerun).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
}

for (const [name, latest] of [
  [
    "stale eligible attempt does not rerun a newer real failure",
    { ...current, run_attempt: 2 },
  ],
  [
    "stale eligible attempt does not rerun current attempt 3",
    { ...current, run_attempt: 3 },
  ],
  [
    "current in-progress attempt does not rerun",
    { ...current, run_attempt: 1, status: "in_progress", conclusion: null },
  ],
  [
    "current cancelled attempt does not rerun",
    { ...current, run_attempt: 1, conclusion: "cancelled" },
  ],
] satisfies [string, CurrentRun][]) {
  test(name, () => {
    const decision = decideRerun({ ...run, run_attempt: 1 }, latest);
    expect(decision.rerun).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
}
