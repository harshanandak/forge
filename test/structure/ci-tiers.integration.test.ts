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
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
};
const ci = new URL("../../.github/workflows/ci.yml", import.meta.url);
const workflow = parse(readFileSync(ci, "utf8"), { maxAliasCount: 200 }) as {
  on: { pull_request: { types?: string[] } | null };
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const gate = jobs["ci-gate"]!;
const gateStep = gate.steps[0]!;
const quickTier = "needs.changes.outputs.tier == 'quick'";
const outsideQuick = "needs.changes.outputs.tier != 'quick'";
const fullScope = "needs.changes.outputs.scope == 'full'";
const outsideSchedule = "github.event_name != 'schedule'";

test("CI starts on ready, draft and default PR events", () => {
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
    "${{ github.event_name == 'pull_request' && (github.event.pull_request.draft && 'quick' || 'merge') || 'full' }}",
  );
  assert.equal(gateStep.env?.EVENT, "${{ github.event_name }}");
  assert.equal(gateStep.env?.DRAFT, "${{ github.event.pull_request.draft }}");
  assert.equal(gateStep.env?.TIER, "${{ needs.changes.outputs.tier }}");
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

const draftMessage =
  "Draft PR: the quick tier ran. Mark the PR ready for review to run the merge tier.";
const resultKeys =
  "CHANGES PR_TITLE STRUCTURE STATIC PACK SPEED VERIFY VERIFY_NODE26 COMMENT_GUARD";
const fixture = {
  EVENT: "pull_request",
  DRAFT: "false",
  TIER: "merge",
  SCOPE: "full",
  GUARD_CHANGED: "true",
  STARTED: "",
};
const readyFull = "CHANGES PR_TITLE STRUCTURE STATIC PACK SPEED VERIFY";
const readyDocs = "CHANGES PR_TITLE STRUCTURE STATIC";
const ready = `${readyFull} COMMENT_GUARD`;
const draft = { DRAFT: "true", TIER: "quick" };
const full = { DRAFT: "", TIER: "full" };
const push =
  "CHANGES STRUCTURE STATIC PACK SPEED VERIFY VERIFY_NODE26 COMMENT_GUARD";

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
  schedule: "CHANGES PACK VERIFY_NODE26",
})) {
  test(`${event} CI Gate passes with its existing jobs`, () => {
    const result = evaluateGate(passed, { ...full, EVENT: event });
    assert.equal(result.exit, 0, result.log);
  }, 10_000);
}

const tierError = "unexpected CI tier";
const failures: [string, Record<string, string>, string][] = [
  ["draft with merge jobs", draft, draftMessage],
  ["blank tier", { TIER: "" }, tierError],
  ["unknown tier", { TIER: "other" }, tierError],
  ["ready payload selecting Quick", { TIER: "quick" }, tierError],
  ["unknown event", { ...full, EVENT: "workflow_dispatch" }, tierError],
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
    const result = evaluateGate(ready, overrides);
    assert.ok(result.log.includes(diagnostic), result.log || diagnostic);
    assert.equal(result.exit, 1, result.log);
  }, 10_000);
}
