import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

type Step = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  id?: string;
  uses?: string;
  with?: { ref?: string };
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  strategy?: { matrix: { include?: unknown[]; os?: string[] } };
  steps: Step[];
};
const ci = new URL("../../.github/workflows/ci.yml", import.meta.url);
const workflow = parse(readFileSync(ci, "utf8"), { maxAliasCount: 200 }) as {
  on: Record<string, { types?: string[] } | null>;
  env: Record<string, string>;
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const gate = jobs["ci-gate"]!;
const gateStep = gate.steps[0]!;
const quickTier = "needs.changes.outputs.tier == 'quick'";
const outsideQuick = "needs.changes.outputs.tier != 'quick'";
const fullScope = "needs.changes.outputs.scope == 'full'";
const outsideSchedule = "github.event_name != 'schedule'";

test("CI requests checks on merge group commits and keeps the PR triggers", () => {
  assert.deepEqual(workflow.on.merge_group, { types: ["checks_requested"] });
  assert.deepEqual(workflow.on.pull_request?.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
  ]);
}, 1_000);

test("Changes selects the tier from the event and draft flag", () => {
  assert.equal(
    jobs.changes?.outputs?.tier,
    "${{ (github.event_name == 'pull_request' || github.event_name == 'merge_group') && (github.event.pull_request.draft && 'quick' || 'merge') || 'full' }}",
  );
  assert.equal(gateStep.env?.EVENT, "${{ github.event_name }}");
  assert.equal(gateStep.env?.DRAFT, "${{ github.event.pull_request.draft }}");
  assert.equal(gateStep.env?.TIER, "${{ needs.changes.outputs.tier }}");
}, 1_000);

test("Changes preserves the diff, outputs and setup steps", () => {
  const changes = jobs.changes!;
  assert.deepEqual(changes.outputs, {
    scope: "${{ steps.diff.outputs.scope }}",
    comment_guard: "${{ steps.diff.outputs.comment_guard }}",
    started: "${{ steps.start.outputs.at }}",
    tier: "${{ (github.event_name == 'pull_request' || github.event_name == 'merge_group') && (github.event.pull_request.draft && 'quick' || 'merge') || 'full' }}",
  });
  assert.deepEqual(
    changes.steps.map((step) => step.id ?? step.uses?.split("@")[0]),
    ["start", "actions/checkout", "oven-sh/setup-bun", "diff"],
  );
  assert.deepEqual(changes.steps[1]?.with, { "fetch-depth": 0 });
  assert.equal(
    changes.steps[3]?.run?.trim(),
    'bun tools/ci/change-scope.ts | tee -a "$GITHUB_OUTPUT"',
  );
}, 1_000);

test("Structure checks merges from main on pull requests after the Quick checks", () => {
  const steps = jobs.structure!.steps;
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.deepEqual(checkout?.with, {
    ref: "${{ env.CI_HEAD }}",
    "fetch-depth": 0,
  });
  const quick = steps.findIndex(
    (step) => step.name === "Quick lint, format and typecheck",
  );
  assert.ok(quick >= 0, "Quick checks must precede the merge check");
  const mergeCheck = steps[quick + 1];
  assert.deepEqual(
    mergeCheck,
    {
      name: "Check merges from main",
      if: "${{ !cancelled() && github.event_name == 'pull_request' }}",
      env: {
        BASE_SHA: "${{ github.event.pull_request.base.sha }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
        BASE_REF: "${{ github.base_ref }}",
      },
      run: [
        "set -euo pipefail",
        'base_commit=$(git show-ref --verify --hash "refs/remotes/origin/$BASE_REF")',
        'base_tree="$RUNNER_TEMP/merge-check-base"',
        'git worktree add --detach "$base_tree" "$base_commit"',
        'checker="$base_tree/tools/ci/merge-from-main.ts"',
        'test -f "$checker"',
        'echo "Running base merge checker at $base_commit: $checker"',
        'bun "$checker"',
        "",
      ].join("\n"),
    },
    "Missing pull-request merge check after Quick",
  );
  assert.ok(mergeCheck?.run);
  assert.match(mergeCheck.run, /"refs\/remotes\/origin\/\$BASE_REF"/);
  assert.doesNotMatch(
    mergeCheck.run,
    /^\s*bun\s+(?:\.\/)?tools\/ci\/merge-from-main\.ts(?:\s|$)/m,
  );
  assert.equal(steps[quick + 2]?.if, "always()");
}, 1_000);

test("CI_HEAD uses the queued commit and Speed compares its base", () => {
  assert.equal(
    workflow.env.CI_HEAD,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  const base = jobs.speed?.steps.find(
    (step) => step.id === "speed-base-checkout",
  );
  assert.equal(
    base?.with?.ref,
    "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}",
  );
}, 1_000);

test("packed CI builds and tests share the event commit", () => {
  assert.equal(workflow.env.CI_BUILD_SHA, "${{ github.sha }}");
  assert.equal(
    workflow.env.CI_HEAD,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  const checkout = (id: string) =>
    jobs[id]!.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout("pack")?.with?.ref, "${{ env.CI_BUILD_SHA }}");
  for (const id of ["verify", "verify-main", "verify-node26"]) {
    const step = checkout(id);
    assert.ok(step, `${id} checkout must exist`);
    assert.equal(step.with?.ref ?? "${{ github.sha }}", "${{ github.sha }}");
  }
}, 1_000);

test("Quick runs structure, lint, format and typecheck", () => {
  const structure = jobs.structure!;
  assert.equal(structure.needs, "changes");
  assert.equal(structure.if, outsideSchedule);
  assert.equal(
    structure.name,
    `\${{ ${quickTier} && 'Quick' || 'Structure guards' }}`,
  );
  const quick = structure.steps.find(
    (step) => step.name === "Quick lint, format and typecheck",
  );
  assert.equal(quick?.if, quickTier);
  assert.deepEqual(quick?.run?.trim().split("\n"), [
    "bun run lint",
    "bun run fmt --check",
    "bun run check",
  ]);
}, 1_000);

test("Heavy jobs wait for Changes and skip Quick", () => {
  const scoped = `${outsideSchedule} && ${fullScope}`;
  const guard = `${outsideSchedule} && (github.event_name != 'pull_request' || needs.changes.outputs.comment_guard == 'true')`;
  for (const [id, predicate] of Object.entries({
    "pr-title": "github.event_name == 'pull_request'",
    static: outsideSchedule,
    pack: fullScope,
    speed: scoped,
    "comment-guard": guard,
    verify: scoped,
  })) {
    assert.deepEqual(
      jobs[id]?.needs,
      id === "verify" ? ["changes", "pack"] : "changes",
      id,
    );
    assert.equal(jobs[id]?.if, `${predicate} && ${outsideQuick}`, id);
  }
  const otherJobs = Object.keys(jobs).filter((id) => id !== "ci-gate");
  assert.equal(gate.if, "always()");
  assert.deepEqual([...(gate.needs ?? [])].sort(), otherJobs.sort());
}, 1_000);

test("CI pins the exact verification matrices and their event policy", () => {
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.deepEqual(
    jobs.verify?.strategy?.matrix,
    {
      include: [
        { os: "ubuntu-latest", node: "24", suite: "all", shard: "1/2" },
        { os: "ubuntu-latest", node: "24", suite: "tests", shard: "2/2" },
        { os: "windows-latest", node: "24", suite: "tests", shard: "1/3" },
        { os: "windows-latest", node: "24", suite: "tests", shard: "2/3" },
        { os: "windows-latest", node: "24", suite: "tests", shard: "3/3" },
      ],
    },
    "Verify on a ready PR must contain only Ubuntu and Windows Node 24 shards",
  );
  assert.deepEqual(jobs["verify-main"]?.strategy?.matrix, {
    include: [
      { os: "ubuntu-latest", node: "26", suite: "all", shard: "1/2" },
      { os: "ubuntu-latest", node: "26", suite: "tests", shard: "2/2" },
      { os: "macos-latest", node: "24", suite: "all", shard: "1/2" },
      { os: "macos-latest", node: "24", suite: "tests", shard: "2/2" },
      { os: "windows-latest", node: "24", suite: "pack" },
    ],
  });
  assert.deepEqual(jobs["verify-node26"]?.strategy?.matrix, {
    include: [
      { os: "windows-latest", node: "26", suite: "tests", shard: "1/3" },
      { os: "windows-latest", node: "26", suite: "tests", shard: "2/3" },
      { os: "windows-latest", node: "26", suite: "tests", shard: "3/3" },
      { os: "windows-latest", node: "26", suite: "pack" },
      { os: "macos-latest", node: "26", suite: "pack" },
    ],
  });
  assert.deepEqual(jobs.speed?.strategy?.matrix, { os: ["ubuntu-latest"] });
  assert.deepEqual(jobs["speed-windows"]?.strategy?.matrix, {
    os: ["windows-latest"],
  });
  assert.equal(
    jobs["verify-node26"]?.if,
    "github.event_name == 'push' || github.event_name == 'schedule'",
  );
  const pushOnly = "github.event_name == 'push'";
  for (const [id, needs, predicate] of [
    [
      "verify-main",
      ["changes", "pack"],
      `${pushOnly} || (github.event_name == 'pull_request' && ${fullScope} && ${outsideQuick})`,
    ],
    ["speed-windows", "changes", pushOnly],
  ] as const) {
    assert.equal(jobs[id]?.if, predicate, id);
    assert.deepEqual(jobs[id]?.needs, needs, id);
    const key = id.toUpperCase().replace("-", "_");
    assert.equal(gateStep.env?.[key], `\${{ needs.${id}.result }}`);
  }
}, 1_000);

const draftMessage =
  "Draft PR: the quick tier ran. Mark the PR ready for review to run the merge tier.";
const resultKeys =
  "CHANGES PR_TITLE STRUCTURE STATIC PACK SPEED SPEED_WINDOWS VERIFY VERIFY_MAIN VERIFY_NODE26 COMMENT_GUARD";
const fixture = {
  EVENT: "pull_request",
  DRAFT: "false",
  TIER: "merge",
  SCOPE: "full",
  GUARD_CHANGED: "true",
  STARTED: "",
};
const readyFull =
  "CHANGES PR_TITLE STRUCTURE STATIC PACK SPEED VERIFY VERIFY_MAIN";
const readyDocs = "CHANGES PR_TITLE STRUCTURE STATIC";
const ready = `${readyFull} COMMENT_GUARD`;
const draft = { DRAFT: "true", TIER: "quick" };
const full = { DRAFT: "", TIER: "full" };
const push =
  "CHANGES STRUCTURE STATIC PACK SPEED SPEED_WINDOWS VERIFY VERIFY_MAIN VERIFY_NODE26 COMMENT_GUARD";
const schedule = "CHANGES PACK VERIFY_NODE26";
const mergeGroup = { EVENT: "merge_group", DRAFT: "", GUARD_CHANGED: "false" };
const mergeGroupFull =
  "CHANGES STRUCTURE STATIC PACK SPEED VERIFY COMMENT_GUARD";

function evaluateGate(passedJobs: string, overrides: Record<string, string>) {
  const passed = passedJobs.split(" ");
  const results: Record<string, string> = {};
  for (const job of resultKeys.split(" "))
    results[job] = passed.includes(job) ? "success" : "skipped";
  const dir = mkdtempSync(join(tmpdir(), "forge-ci-tier-"));
  const summary = join(dir, "summary");
  try {
    writeFileSync(summary, "");
    assert.ok(gateStep.run, "CI Gate must have an inline Bash step");
    const result = Bun.spawnSync(
      ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", gateStep.run],
      {
        env: {
          PATH: process.env.PATH,
          ...fixture,
          ...results,
          ...overrides,
          GITHUB_STEP_SUMMARY: summary,
        },
        timeout: 5_000,
      },
    );
    return {
      exit: result.exitCode,
      log: result.stdout.toString() + result.stderr.toString(),
      summary: readFileSync(summary, "utf8").trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("merge group CI Gate passes when all required jobs succeed", () => {
  const result = evaluateGate(mergeGroupFull, mergeGroup);
  assert.equal(result.exit, 0, result.log);
}, 10_000);

for (const scope of ["docs", "full"]) {
  test(`draft ${scope} CI Gate gives the ready message`, () => {
    const env = { ...draft, SCOPE: scope };
    const result = evaluateGate("CHANGES STRUCTURE", env);
    assert.equal(result.log.trim(), `::error::${draftMessage}`);
    assert.equal(result.summary, draftMessage);
    assert.equal(result.exit, 1, result.log);
  }, 10_000);

  for (const guard of ["true", "false"]) {
    test(`ready ${scope} CI Gate passes with guard=${guard}`, () => {
      const required = scope === "docs" ? readyDocs : readyFull;
      const passed = guard === "true" ? `${required} COMMENT_GUARD` : required;
      const env = { SCOPE: scope, GUARD_CHANGED: guard };
      const result = evaluateGate(passed, env);
      assert.equal(result.exit, 0, result.log);
    }, 10_000);
  }
}

for (const [event, passed] of Object.entries({
  push,
  schedule,
})) {
  test(`${event} CI Gate passes with its existing jobs`, () => {
    const result = evaluateGate(passed, { ...full, EVENT: event });
    assert.equal(result.exit, 0, result.log);
  }, 10_000);
}

const expectedJobs: [string, string, Record<string, string>][] = [
  ["draft push", "CHANGES STRUCTURE", draft],
  ["ready code PR", ready, {}],
  ["docs-only PR", readyDocs, { SCOPE: "docs", GUARD_CHANGED: "false" }],
  ["push to main", push, { ...full, EVENT: "push" }],
  ["schedule", schedule, { ...full, EVENT: "schedule" }],
  ["merge group code", mergeGroupFull, mergeGroup],
];
for (const [event, passed, env] of expectedJobs) {
  for (const key of passed.split(" ")) {
    const name = key.toLowerCase().replace("_", "-");
    test(`${event} CI Gate rejects skipped or missing ${name}`, () => {
      for (const outcome of env.EVENT === "merge_group"
        ? ["skipped", "", "failure", "cancelled"]
        : ["skipped", ""]) {
        const result = evaluateGate(passed, { ...env, [key]: outcome });
        const diagnostic = `${name} finished as '${outcome}', expected 'success'`;
        assert.ok(result.log.includes(diagnostic), diagnostic);
        assert.equal(result.exit, 1, result.log);
      }
    }, 10_000);
  }
  if (event === "push to main") continue;
  const skipped =
    env.EVENT === "merge_group"
      ? ["PR_TITLE", "SPEED_WINDOWS", "VERIFY_MAIN", "VERIFY_NODE26"]
      : event === "ready code PR"
        ? ["SPEED_WINDOWS"]
        : ["SPEED_WINDOWS", "VERIFY_MAIN"];
  for (const key of skipped) {
    const name = key.toLowerCase().replace("_", "-");
    test(`${event} CI Gate refuses unexpected success from ${name}`, () => {
      const result = evaluateGate(passed, { ...env, [key]: "success" });
      const diagnostic = `${name} finished as 'success', expected 'skipped'`;
      assert.ok(result.log.includes(diagnostic), diagnostic);
      assert.equal(result.exit, 1, result.log);
    }, 10_000);
  }
}

const tierError = "unexpected CI tier";
const failures: [string, Record<string, string>, string][] = [
  ["draft with merge jobs", draft, draftMessage],
  ["blank tier", { TIER: "" }, tierError],
  ["unknown tier", { TIER: "other" }, tierError],
  ["ready payload selecting Quick", { TIER: "quick" }, tierError],
  ["unknown event", { ...full, EVENT: "workflow_dispatch" }, tierError],
  ["merge group with full tier", { ...mergeGroup, TIER: "full" }, tierError],
  [
    "merge group with false draft flag",
    { ...mergeGroup, DRAFT: "false" },
    tierError,
  ],
  [
    "merge group with docs scope",
    { ...mergeGroup, SCOPE: "docs" },
    "unexpected scope",
  ],
  ["unknown scope", { SCOPE: "other" }, "unexpected scope"],
  ["push docs", { ...full, EVENT: "push", SCOPE: "docs" }, "unexpected scope"],
  [
    "malformed guard selection",
    { GUARD_CHANGED: "False" },
    "unexpected comment guard selection",
  ],
  [
    "skipped Changes",
    { CHANGES: "skipped" },
    "changes finished as 'skipped', expected 'success'",
  ],
];
test("CI Gate fails if Quick skips", () => {
  const result = evaluateGate("CHANGES", draft);
  assert.match(result.log, /structure finished as 'skipped'/);
  assert.equal(result.exit, 1, result.log);
}, 10_000);
for (const job of ["PACK", "SPEED", "VERIFY", "STRUCTURE", "STATIC"]) {
  for (const outcome of ["skipped", "failure", "cancelled"]) {
    const name = job.toLowerCase();
    failures.push([
      `${name} returned ${outcome}`,
      { [job]: outcome },
      `${name} finished as '${outcome}', expected 'success'`,
    ]);
  }
}
for (const [name, overrides, diagnostic] of failures) {
  test(`CI Gate fails for ${name}`, () => {
    const passed = overrides.EVENT === "merge_group" ? mergeGroupFull : ready;
    const result = evaluateGate(passed, overrides);
    assert.ok(result.log.includes(diagnostic), result.log || diagnostic);
    assert.equal(result.exit, 1, result.log);
  }, 10_000);
}
