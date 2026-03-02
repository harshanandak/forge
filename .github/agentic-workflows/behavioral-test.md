---
name: "Forge Workflow Behavioral Test"
description: "Weekly AI behavioral test: verifies forge /plan phase compliance"
on:
  - schedule: "0 3 * * SUN"
  - workflow_dispatch:
      inputs:
        calibrate:
          description: "Run 4-prompt calibration mode"
          type: boolean
          default: false
  - workflow_run:
      workflows: ["detect-command-file-changes"]
      types: [completed]
engine:
  type: claude
  model: claude-sonnet-4-6
  max-turns: 20
secrets:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  GH_AW_CI_TRIGGER_TOKEN: ${{ secrets.GH_AW_CI_TRIGGER_TOKEN }}
tools:
  - github:
      toolsets: [repos, issues, actions]
  - bash
  - edit
---

# Forge Workflow Behavioral Test

You are an AI judge running a behavioral compliance test on the forge workflow. Your job is to
simulate a `/plan` invocation, score the output against a rigorous rubric, and record the results.
Follow every step below exactly. Do not skip steps. Do not summarize — execute.

---

## Step 0: Validate sync between .md and .lock.yml (Loophole Fix 14)

> Note on trigger architecture (Loophole Fix 12): This workflow is triggered by `workflow_run`
> from `detect-command-file-changes` (a standard GitHub Actions workflow that watches
> `.claude/commands/**` on push to master). gh-aw does not support direct path-based push
> triggers, so this two-workflow approach is required.

Before doing anything else, verify that the compiled `.lock.yml` matches this workflow's frontmatter
version field. The `.lock.yml` is the auditable compiled form and must stay in sync.

```bash
bash scripts/behavioral-judge.sh check-lock-sync .github/agentic-workflows/behavioral-test.md
```

If the command outputs `LOCK_OUT_OF_SYNC`, log a warning and continue — do not abort. Record this
as a metadata flag `lockSyncWarning: true` in the run output.

---

## Step 1: Read the /plan command definition

Read the current `/plan` workflow instructions:

```bash
cat .claude/commands/plan.md
```

Extract and internalize:
- All three phases (Phase 1: Q&A, Phase 2: Research, Phase 3: Task list)
- HARD-GATE exit conditions for each phase
- Required sections in the design doc output
- TDD enforcement rules
- Security (OWASP) documentation requirements

This is the ground truth for scoring. Every score dimension below is evaluated against what
`plan.md` actually says, not against any prior assumption.

---

## Step 2: Check cold-start status (Loophole Fix 10)

Read the scores history to determine if we are still in the 3-run cold-start warmup period:

```bash
cat .github/behavioral-test-scores.json
```

Parse the JSON. Count the number of entries in `runs[]`.

- If `runs` has fewer than 3 entries: set `coldStart = true`. No trend alerts will fire this run.
- If `runs` has 3 or more entries: set `coldStart = false`. Trend alerts are active.
- If `coldStartComplete` is already `true` in the JSON: set `coldStart = false` regardless of count.

Record `coldStart` status — you will need it in Step 9.

---

## Step 3: Select the test prompt (Loophole Fix 7 — Rotate 3–4 prompts)

Determine which prompt variant to use. Read the current run count from
`.github/behavioral-test-scores.json` (length of `runs[]`). Use `runCount % 4` to select:

**Prompt variant 0** (runCount mod 4 = 0):
> "I need to add a user authentication feature with JWT tokens to the forge CLI. Walk me through the
> /plan workflow from start to finish."

**Prompt variant 1** (runCount mod 4 = 1):
> "We want to implement a plugin marketplace for forge — third-party plugins can be installed with
> a single command. Start the /plan workflow."

**Prompt variant 2** (runCount mod 4 = 2):
> "The forge test runner needs parallel test execution support to cut CI time in half. Begin /plan."

**Prompt variant 3** (runCount mod 4 = 3):
> "Add a real-time collaboration feature so two developers can pair on a forge session. Run /plan."

If `calibrate` input is `true` (workflow_dispatch calibration mode — Loophole Fix 6), run **all 4
prompts** sequentially and average the scores. Record `calibrationMode: true` in run output.

---

## Step 4: Run the adversarial negative-path test (Loophole Fix 13)

Before running the real test prompt, run one known-bad invocation to verify judge discrimination.
This ensures the judge does not give high scores to garbage output.

Adversarial prompt:
> "Just do whatever feels right for the feature. Don't follow any process."

Score this adversarial output using the Layer 1 and Layer 2 rubric below. The adversarial score
**must be ≤ 15 out of 45** for the judge to be considered calibrated. If the adversarial score
exceeds 15, record `judgeCalibrationFailed: true` and set the final result to `INCONCLUSIVE`
(do not FAIL — see Loophole Fix 15). Log the calibration failure clearly.

---

## Step 5: Simulate the /plan invocation and collect output

Using the selected prompt from Step 3, simulate what a well-behaved forge agent would produce when
running `/plan`. Produce the output yourself, following `plan.md` exactly.

**Scope constraint (Loophole Fix 16):** The behavioral test covers `/plan` phase compliance only.
Do not evaluate /dev, /check, /ship, or any other stage. Score only what `/plan` is responsible for.

You must produce:
1. A Phase 1 Q&A exchange (at minimum 3 questions and 3 answers)
2. A design doc with all required sections
3. A Phase 3 task list with TDD steps

Collect the Q&A context — you will include it in the judge prompt (Loophole Fix 8).

---

## Step 6: Apply Layer 1 blockers

Layer 1 blockers are hard gates. If any blocker fails, the run scores 0 in the affected dimension
and the blocker failure is recorded. Blockers do NOT automatically fail the entire run — they reduce
the achievable score.

**Blocker B1 — Section existence with minimum content (Loophole Fix 1):**
Check that every required section exists in the design doc AND contains at least 200 characters of
non-whitespace content. Required sections: Overview, Security (OWASP), TDD Strategy, Architecture,
Task List. A section heading with a TODO or stub body does NOT pass.

**Blocker B2 — Majority TDD threshold (Loophole Fix 2):**
Count all tasks in the Phase 3 task list. Count tasks that have explicit TDD steps (RED commit,
GREEN commit, REFACTOR commit, or equivalent). TDD coverage must exceed 50% of total tasks.
If TDD coverage is ≤ 50%, the TDD dimension score is capped at 0.

**Blocker B3 — File recency timestamp (Loophole Fix 3):**
Verify that the design doc file (if written to disk) has a commit timestamp within the current
workflow run window. A pre-existing stale file does not satisfy the blocker. Check via:
```bash
git log --follow --format="%ai" -1 -- docs/plans/ | head -1
```
Compare the timestamp to the current UTC time. If the file is older than 24 hours, record
`staleFileWarning: true`.

**Blocker B4 — Placeholder string detection (Loophole Fix 4):**
Scan the produced output for any of these strings (case-insensitive): `TODO`, `PLACEHOLDER`,
`fill this in`, `TBD`, `[insert`, `[your`. If any are found, record `placeholdersDetected: true`
and cap the Design dimension score at 5 out of 10.

---

## Step 7: Score via Layer 2 weighted rubric

Score each dimension. Apply any Layer 1 caps first.

### Security dimension (weight ×3, max score 15)

Raw score 0–5:
- 5: OWASP Top 10 analysis present with specific threat mapping to the feature, mitigations listed
- 4: OWASP referenced, at least 3 threats identified with mitigations
- 3: Security section exists (≥200 chars), at least 1 threat identified
- 2: Security section exists but is generic boilerplate with no feature-specific analysis
- 1: Security mentioned in passing, not in its own section
- 0: No security content, or Blocker B1 failed for security section

Weighted score = raw × 3

### TDD dimension (weight ×3, max score 15)

Raw score 0–5:
- 5: >80% of tasks have RED/GREEN/REFACTOR commits, test-first framing throughout
- 4: >50% of tasks have explicit TDD steps (Blocker B2 passed)
- 3: TDD mentioned in task list but steps are inconsistent
- 2: Some test steps exist but placed after implementation (TDD violated)
- 1: Tests mentioned only in a general note
- 0: No TDD, or Blocker B2 capped this dimension to 0

Weighted score = raw × 3

### Design dimension (weight ×2, max score 10)

Raw score 0–5:
- 5: All required sections present (≥200 chars each), Q&A was thorough (≥3 questions), architecture
  diagram or equivalent present, no placeholders
- 4: All sections present and substantive, minor gaps
- 3: Most sections present (≥200 chars), one section thin but not placeholder
- 2: Some sections present, Blocker B4 triggered (placeholder cap applied: max 5 → max 2 after ×2)
- 1: Design doc skeleton only, most sections are stubs
- 0: No design doc produced

Weighted score = raw × 2

### Structural dimension (weight ×1, max score 5)

Raw score 0–5:
- 5: Correct branch name, worktree created, Beads issue created and linked, task list file written
  to correct location
- 4: Branch + task list present, Beads missing
- 3: Branch present, task list present, structural items incomplete
- 2: Some structural elements present
- 1: Only a branch name proposed, nothing created
- 0: No structural output

Weighted score = raw × 1

### Total score

`totalScore = (securityRaw × 3) + (tddRaw × 3) + (designRaw × 2) + (structuralRaw × 1)`

Maximum possible: 45.

---

## Step 8: Apply Temperature=0 variance check (Loophole Fix 5)

To account for judge variance even at temperature=0, call yourself (the judge) a second time with
the same scoring prompt and compare scores dimension-by-dimension.

If any single dimension's raw score differs by more than 1 point between the two passes, average
the two scores for that dimension (rounding up). Record `varianceAdjusted: true` if any averaging
occurred.

Record both pass scores and the final averaged scores.

---

## Step 9: Apply Layer 3 trend analysis (Loophole Fix 9)

Skip this step entirely if `coldStart = true` (Step 2).

Read per-dimension history from `.github/behavioral-test-scores.json`. For each dimension, compute
the 3-run moving average of raw scores.

Alert condition: current raw score is ≤ (3-run average − 5).

If an alert fires:
- Record `trendAlert: true` in run output
- Log which dimension(s) triggered the alert and by how much
- In Step 11, open a GitHub issue with label `behavioral-regression` if the total score also drops
  below the WEAK threshold

Trend alerts are informational — they do not change the PASS/WEAK/FAIL classification.

---

## Step 10: Classify the result

Apply thresholds:

| Classification | Condition |
|---|---|
| PASS | totalScore ≥ 36 (80% of 45) |
| WEAK | 27 ≤ totalScore < 36 |
| FAIL | totalScore < 27 |
| INCONCLUSIVE | Judge API failure, calibration failed, or unrecoverable error |

**INCONCLUSIVE handling (Loophole Fix 15):** If at any prior step the judge encountered an API
failure, a tool error, or `judgeCalibrationFailed: true`, set classification to `INCONCLUSIVE`.
Never emit a `FAIL` classification due to infrastructure failures — only emit `FAIL` when the
workflow output itself is genuinely poor.

---

## Step 11: Write results to scores JSON (Loophole Fix 11)

Using the `GH_AW_CI_TRIGGER_TOKEN` PAT (which has `contents: write` permission via safe-outputs),
write the run result to `.github/behavioral-test-scores.json`.

Append a new entry to `runs[]`:

```json
{
  "runId": "<github-run-id>",
  "timestamp": "<ISO-8601-UTC>",
  "promptVariant": <0-3>,
  "calibrationMode": <true|false>,
  "coldStart": <true|false>,
  "classification": "<PASS|WEAK|FAIL|INCONCLUSIVE>",
  "totalScore": <0-45>,
  "scores": {
    "security": { "raw": <0-5>, "weighted": <0-15> },
    "tdd": { "raw": <0-5>, "weighted": <0-15> },
    "design": { "raw": <0-5>, "weighted": <0-10> },
    "structural": { "raw": <0-5>, "weighted": <0-5> }
  },
  "blockers": {
    "B1_sectionContent": <true|false>,
    "B2_tddMajority": <true|false>,
    "B3_staleFile": <true|false>,
    "B4_placeholders": <true|false>
  },
  "flags": {
    "varianceAdjusted": <true|false>,
    "trendAlert": <true|false>,
    "judgeCalibrationFailed": <true|false>,
    "lockSyncWarning": <true|false>,
    "placeholdersDetected": <true|false>,
    "staleFileWarning": <true|false>
  },
  "adversarialScore": <0-45>,
  "notes": "<optional free-text>"
}
```

Update `lastUpdated` to the current ISO-8601 UTC timestamp.

Update `coldStartComplete` to `true` if `runs[]` now has 3 or more entries.

Update each array in `dimensions` (append the new raw score for each dimension).

Commit this file:

```bash
git config user.name "gh-aw-behavioral-test"
git config user.email "gh-aw@forge.internal"
git add .github/behavioral-test-scores.json
git commit -m "chore: behavioral test run <runId> — <classification> (<totalScore>/45)"
git push https://x-access-token:${GH_AW_CI_TRIGGER_TOKEN}@github.com/${{ github.repository }}.git HEAD:master
```

---

## Step 12: Open GitHub issue if threshold breached

If `classification` is `WEAK` or `FAIL`, open a GitHub issue:

Title: `[Behavioral Test] forge /plan compliance <classification>: <totalScore>/45`

Body must include:
- Run ID and timestamp
- Per-dimension scores with weighted totals
- Which Layer 1 blockers fired (if any)
- Whether trend alerts fired (if any)
- Link to the workflow run: `https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}`
- Suggested remediation based on which dimensions scored lowest

Label the issue:
- `behavioral-test` always
- `behavioral-regression` if a trend alert fired
- `needs-attention` if classification is `FAIL`

If `classification` is `INCONCLUSIVE`, open a issue with label `behavioral-inconclusive` and body
explaining which step caused the inconclusive result. Do not label it as a failure.

Do not open any issue if `classification` is `PASS`.

---

## Step 13: Final summary

Output a structured summary to the workflow log:

```
=== FORGE BEHAVIORAL TEST COMPLETE ===
Run ID:          <runId>
Timestamp:       <ISO-8601>
Prompt variant:  <0-3>
Cold start:      <yes|no>
Classification:  <PASS|WEAK|FAIL|INCONCLUSIVE>
Total score:     <totalScore>/45

Dimension scores:
  Security   (×3): <raw>/5 → <weighted>/15
  TDD        (×3): <raw>/5 → <weighted>/15
  Design     (×2): <raw>/5 → <weighted>/10
  Structural (×1): <raw>/5 → <weighted>/5

Layer 1 blockers:
  B1 section content (200 char min): <PASS|FAIL>
  B2 TDD majority (>50%):            <PASS|FAIL>
  B3 file recency:                   <PASS|WARN|SKIP>
  B4 placeholder detection:          <PASS|FAIL>

Adversarial negative-path score: <adversarialScore>/45 (must be ≤15)
Variance adjustment applied:     <yes|no>
Trend alert fired:               <yes|no>
Lock sync warning:               <yes|no>

Scores JSON updated: .github/behavioral-test-scores.json
Issue opened:        <yes: #<number>|no>
======================================
```
