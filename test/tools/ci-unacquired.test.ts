import { expect, setDefaultTimeout, test } from "bun:test";
import {
  decideRerun,
  type CiJob,
  type CiRun,
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

test("reruns a never-acquired macOS job and failed gate on attempts 1 and 2", () => {
  for (const run_attempt of [1, 2]) {
    const decision = decideRerun({ ...run, run_attempt });
    expect(decision.rerun).toBe(true);
    expect(decision.reason).toContain("never-acquired");
  }
});

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
    "skipped job alongside allocation failure",
    { ...run, jobs: [...run.jobs, { ...success, conclusion: "skipped" }] },
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
    const decision = decideRerun(input);
    expect(decision.rerun).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
}
