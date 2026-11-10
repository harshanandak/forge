import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ciUnacquired from "../../tools/ci-unacquired.ts";
import {
  decideRerun,
  decisionOutput,
  neededJobNames,
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
const realFailure = {
  ...unacquired,
  conclusion: "failure",
  runner_name: "GitHub Actions runner",
  steps: [{ name: "Unit tests", conclusion: "failure" }],
} satisfies CiJob;
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

test("reruns a queued never-acquired job without a steps field", () => {
  const queuedWithoutSteps = JSON.parse(
    '{"name":"Verify","status":"queued","conclusion":null,"runner_name":null}',
  ) as CiJob;
  for (const run_attempt of [1, 2]) {
    expect(
      decideRerun(
        { ...run, run_attempt, jobs: [success, queuedWithoutSteps, gate] },
        { ...current, run_attempt },
      ).rerun,
    ).toBe(true);
  }
});

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

// Jobs GitHub never created: absent from the attempt's job list, not skipped.
// The CI Gate reports them as 'abandoned'. Names mirror ci.yml's `needs`.
const needed = [
  "Changes",
  "PR title",
  "Structure guards",
  "Lint and format",
  "Pack artifact",
  "Speed (${{ matrix.os }}, Node 24)",
  "Verify (${{ matrix.os }}, Node ${{ matrix.node }})",
];
const named = (name: string): CiJob => ({ ...success, name });
const created = [
  named("Changes"),
  named("PR title"),
  named("Structure guards"),
  named("Lint and format"),
];
const decide = (
  jobs: CiJob[],
  run_attempt = 1,
  conclusion: string | null = "failure",
) =>
  decideRerun(
    { conclusion, run_attempt, jobs },
    { ...current, run_attempt },
    needed,
  );

test("reruns everything when needed jobs were never created", () => {
  for (const run_attempt of [1, 2]) {
    const decision = decide([...created, gate], run_attempt);
    expect(decision.rerun).toBe(true);
    expect(decision.scope).toBe("all");
    expect(decision.reason).toContain("never created");
  }
}, 1000);

test("reruns everything when a docs-only run lost its verify job", () => {
  const jobs = [
    ...created,
    { ...skipped, name: "Pack artifact" },
    { ...skipped, name: "Speed (${{ matrix.os }}, Node 24)" },
    gate,
  ];
  const decision = decide(jobs);
  expect(decision.rerun).toBe(true);
  expect(decision.scope).toBe("all");
}, 1000);

test("does not rerun a real failure alongside missing jobs", () => {
  const jobs = [...created, { ...realFailure, name: "Unit tests" }, gate];
  expect(decide(jobs).rerun).toBe(false);
}, 1000);

test("does not rerun missing jobs on the third attempt or later", () => {
  for (const run_attempt of [3, 4]) {
    expect(decide([...created, gate], run_attempt).rerun).toBe(false);
  }
}, 1000);

test("does not rerun missing jobs when the CI Gate job is absent", () => {
  expect(decide(created).rerun).toBe(false);
}, 1000);

test("does not rerun missing jobs when the run did not fail", () => {
  for (const conclusion of ["success", "cancelled", null]) {
    expect(decide([...created, gate], 1, conclusion).rerun).toBe(false);
  }
}, 1000);

test("does not treat missing jobs as a problem without a needed list", () => {
  const decision = decideRerun(
    { ...run, run_attempt: 1, jobs: [...created, gate] },
    { ...current, run_attempt: 1 },
  );
  expect(decision.rerun).toBe(false);
}, 1000);

const complete = [
  ...created,
  named("Pack artifact"),
  named("Speed (ubuntu-latest, Node 24)"),
  named("Speed (windows-latest, Node 24)"),
  ...[
    "ubuntu-latest, Node 24, shard 1/2",
    "ubuntu-latest, Node 24, tests, shard 2/2",
    "ubuntu-latest, Node 26, shard 1/2",
    "ubuntu-latest, Node 26, tests, shard 2/2",
    "macos-latest, Node 24, shard 1/2",
    "macos-latest, Node 24, tests, shard 2/2",
    "macos-latest, Node 26, pack",
    "windows-latest, Node 24, tests, shard 1/3",
    "windows-latest, Node 24, tests, shard 2/3",
    "windows-latest, Node 24, tests, shard 3/3",
    "windows-latest, Node 24, pack",
    "windows-latest, Node 26, tests, shard 1/3",
    "windows-latest, Node 26, tests, shard 2/3",
    "windows-latest, Node 26, tests, shard 3/3",
    "windows-latest, Node 26, pack",
  ].map((leg) => named(`Verify (${leg})`)),
];

test("does not rerun when every needed job exists and only the gate failed", () => {
  expect(decide([...complete, gate]).rerun).toBe(false);
}, 1000);

test("keeps rerun-failed-jobs for a never-acquired job when no job is missing", () => {
  const rest = complete.filter((job) => job.name !== "Pack artifact");
  const jobs = [...rest, { ...unacquired, name: "Pack artifact" }, gate];
  const decision = decide(jobs);
  expect(decision.rerun).toBe(true);
  expect(decision.scope).toBe("failed");
}, 1000);

test("reruns everything when a never-acquired job and a missing job mix", () => {
  const jobs = [...created, { ...unacquired, name: "Pack artifact" }, gate];
  const decision = decide(jobs);
  expect(decision.rerun).toBe(true);
  expect(decision.scope).toBe("all");
}, 1000);

// Drift guard: the needed jobs come from ci.yml's CI Gate, never a second list.
const ciWorkflow = readFileSync(
  join(import.meta.dir, "../../.github/workflows/ci.yml"),
  "utf8",
);

test("reads the needed jobs from the CI Gate in ci.yml", () => {
  const detected = neededJobNames(ciWorkflow);
  const gateNeeds = (
    Bun.YAML.parse(ciWorkflow) as {
      jobs: Record<string, { needs: string[] }>;
    }
  ).jobs["ci-gate"]?.needs;
  expect(detected).toHaveLength(gateNeeds?.length ?? -1);
  const jobs = [...complete, gate];
  expect(
    decideRerun(
      { ...run, run_attempt: 1, jobs },
      { ...current, run_attempt: 1 },
      detected,
    ).rerun,
  ).toBe(false);
  for (const prefix of [
    "Changes",
    "PR title",
    "Structure guards",
    "Lint and format",
    "Pack artifact",
    "Speed (",
    "Verify (",
  ]) {
    const withoutJob = jobs.filter((job) => !job.name.startsWith(prefix));
    const decision = decideRerun(
      { ...run, run_attempt: 1, jobs: withoutJob },
      { ...current, run_attempt: 1 },
      detected,
    );
    expect(decision.scope).toBe("all");
    expect(decision.rerun).toBe(true);
  }
}, 1000);

test("derives needed job names from a workflow's gate", () => {
  const workflow = [
    "jobs:",
    "  alpha:",
    "    name: Alpha job",
    "  beta:",
    "    name: Beta (${{ matrix.os }})",
    "  gamma: {}",
    "  ci-gate:",
    "    needs: [alpha, beta, gamma]",
  ].join("\n");
  expect(neededJobNames(workflow)).toEqual([
    "Alpha job",
    "Beta (${{ matrix.os }})",
    "gamma",
  ]);
  expect(() => neededJobNames("jobs:\n  alpha: {}\n")).toThrow();
}, 1000);

// The entry point's output is what the workflow greps, built from the real ci.yml.
// Every Verify leg is dropped: one leg missing while its siblings exist is forge-1085.
const noVerify = complete.filter((job) => !job.name.startsWith("Verify ("));
const output = (jobs: CiJob[], run_attempt = 1) =>
  decisionOutput(
    [{ jobs: jobs.slice(0, 3) }, { jobs: jobs.slice(3) }],
    { ...current, run_attempt },
    { RUN_CONCLUSION: "failure", RUN_ATTEMPT: String(run_attempt) },
    ciWorkflow,
  ).split("\n");

test("outputs rerun=true and scope=all for a job missing from the real ci.yml", () => {
  const lines = output([...noVerify, gate]);
  expect(lines).toContain("rerun=true");
  expect(lines).toContain("scope=all");
}, 1000);

test("outputs scope=failed for a never-acquired job with no missing job", () => {
  const rest = complete.filter((job) => job.name !== "Pack artifact");
  const lines = output([
    ...rest,
    { ...unacquired, name: "Pack artifact" },
    gate,
  ]);
  expect(lines).toContain("rerun=true");
  expect(lines).toContain("scope=failed");
}, 1000);

test("outputs rerun=false for a real failure alongside a missing job", () => {
  const lines = output([
    ...noVerify,
    { ...realFailure, name: "Unit tests" },
    gate,
  ]);
  expect(lines).toContain("rerun=false");
  expect(lines.some((line) => line.startsWith("reason="))).toBe(true);
}, 1000);

const headSha = "e37b923981fa24a17b0cd8f4661950ace48d6b72";
const headRun = { ...current, run_attempt: 1, head_sha: headSha };
const headEnv = {
  GH_REPO: "harshanandak/forge",
  RUN_CONCLUSION: "failure",
  RUN_ATTEMPT: "1",
};
const workflowAtHead = (nodes: string) => `jobs:
  verify:
    name: Verify (\${{ matrix.os }}, Node \${{ matrix.node }})
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [${nodes}]
  ci-gate:
    name: CI Gate
    needs: [verify]
`;
const matrixLegs = [
  named("Verify (ubuntu-latest, Node 24)"),
  named("Verify (windows-latest, Node 24)"),
  named("Verify (ubuntu-latest, Node 26)"),
  named("Verify (windows-latest, Node 26)"),
];
const judgeMatrix = (jobs: CiJob[]) =>
  decisionOutput([{ jobs }], headRun, headEnv, workflowAtHead("24, 26")).split(
    "\n",
  );
type HeadDecision = (
  pages: readonly { jobs: readonly CiJob[] }[],
  latest: typeof headRun,
  env: typeof headEnv,
  read: (endpoint: string) => Promise<string>,
) => Promise<string>;
const judgeHead = async (
  jobs: CiJob[],
  read: (endpoint: string) => Promise<string>,
) => {
  // Keep the tests-only commit typecheckable before the entry point is added.
  expect(ciUnacquired).toHaveProperty("decisionAtHead");
  const { decisionAtHead } = ciUnacquired as unknown as {
    decisionAtHead: HeadDecision;
  };
  return (
    await decisionAtHead(
      [{ jobs: jobs.slice(0, 2) }, { jobs: jobs.slice(2) }],
      headRun,
      headEnv,
      read,
    )
  ).split("\n");
};

test("recovers two never-created legs out of four needed matrix legs", () => {
  const lines = judgeMatrix([...matrixLegs.slice(0, 2), gate]);
  expect(lines).toContain("rerun=true");
  expect(lines).toContain("scope=all");
}, 1000);

test("keeps a real failure red when all four matrix legs were created", () => {
  const jobs = [
    ...matrixLegs.slice(0, 3),
    { ...realFailure, name: matrixLegs[3]!.name },
    gate,
  ];
  const lines = judgeMatrix(jobs);
  expect(lines).toContain("rerun=false");
}, 1000);

test("keeps a real failure red alongside never-created matrix legs", () => {
  const lines = judgeMatrix([
    matrixLegs[0]!,
    { ...realFailure, name: matrixLegs[1]!.name },
    gate,
  ]);
  expect(lines).toContain("rerun=false");
}, 1000);

test("judges the matrix read through the API at the run head SHA", async () => {
  for (const [nodes, expected] of [
    ["24", "rerun=false"],
    ["24, 26", "rerun=true"],
  ] as const) {
    const endpoints: string[] = [];
    const lines = await judgeHead(
      [...matrixLegs.slice(0, 2), gate],
      (endpoint) => {
        endpoints.push(endpoint);
        return Promise.resolve(workflowAtHead(nodes));
      },
    );
    expect(endpoints).toEqual([
      `repos/harshanandak/forge/contents/.github/workflows/ci.yml?ref=${headSha}`,
    ]);
    expect(lines).toContain(expected);
  }
}, 1000);

test("fails closed with a clear reason when head workflow cannot be read", async () => {
  const lines = await judgeHead([unacquired, gate], () =>
    Promise.reject(new Error("HTTP 404")),
  );
  expect(lines).toContain("rerun=false");
  expect(lines.some((line) => /^reason=.*head.*workflow/i.test(line))).toBe(
    true,
  );
}, 1000);

test("reads fork workflow YAML as data without executing its steps", async () => {
  const workflow = `${workflowAtHead("24, 26")}    steps:
      - run: throw new Error('workflow data must not execute')
`;
  const lines = await judgeHead([...matrixLegs.slice(0, 2), gate], () =>
    Promise.resolve(workflow),
  );
  expect(lines).toContain("rerun=true");
}, 1000);
