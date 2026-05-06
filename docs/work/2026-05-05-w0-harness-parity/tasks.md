# W0 Harness Parity Tasks

Feature: w0-harness-parity
Issue: forge-2si5
Branch: codex/w0-harness-parity

Baseline: `bun test --timeout 15000` was attempted on 2026-05-06 and timed out after 120 seconds in this session. `/dev` should run the targeted parity test first, then decide whether full-suite timeout investigation belongs in this PR or a follow-up.

## Task 1: Add clean-fixture parity generator

File(s): `scripts/spikes/skill-auto-invoke-parity.js`
OWNS: `scripts/spikes/skill-auto-invoke-parity.js`
What to implement: Create a deterministic script that builds a temporary fixture with equivalent Claude, Cursor, and Codex skill/rule surfaces, validates each surface, and reports pass/fail per harness as JSON. The script must not create Codex slash prompt files and must not implement migration dry-run logic.
TDD steps:
1. Write test: in `test/w0-harness-parity.test.js`, assert the script can be imported or executed and returns three harness results for the default fixture.
2. Run test: confirm it fails because `scripts/spikes/skill-auto-invoke-parity.js` is missing or incomplete.
3. Implement: add the fixture generator, validators, JSON reporter, and CLI entry point.
4. Run test: confirm the default fixture passes for Claude, Cursor, and Codex.
5. Commit: `test: add w0 harness parity fixture`
Expected output: `node scripts/spikes/skill-auto-invoke-parity.js --json` prints JSON with `claude`, `cursor`, and `codex` harness results and exits 0.

## Task 2: Add parity validation tests

File(s): `test/w0-harness-parity.test.js`
OWNS: `test/w0-harness-parity.test.js`
What to implement: Add Bun tests for happy path, missing-target failure, explicit skill slash invocation, Cursor Agent Requested `.mdc` frontmatter, and Codex no-slash-prompt behavior.
TDD steps:
1. Write test: assert the default fixture passes, every harness reports `/<skill-name>` explicit invocation, a missing Cursor rule fails Cursor only, and no prompt/slash-command path exists.
2. Run test: confirm failure until the script supports fault injection or fixture inspection.
3. Implement: extend the script only as needed for testable fixture paths and failure simulation.
4. Run test: `bun test test/w0-harness-parity.test.js`.
5. Commit: `test: cover w0 harness parity failures`
Expected output: targeted Bun test passes and exercises at least one failing-harness case.

## Task 3: Document evidence and D38 decision boundary

File(s): `docs/work/2026-05-05-w0-harness-parity/decisions.md`, `docs/work/2026-05-05-w0-harness-parity/design.md`, `docs/work/2026-05-05-w0-harness-parity/tasks.md`
OWNS: `docs/work/2026-05-05-w0-harness-parity/decisions.md`, `docs/work/2026-05-05-w0-harness-parity/design.md`, `docs/work/2026-05-05-w0-harness-parity/tasks.md`
What to implement: Record the source-backed decision that Codex parity uses documented repository Agent Skills at `.agents/skills/<name>/SKILL.md`, not undocumented slash prompt files. If validation proves any harness infeasible, document the known issue and tie it to D38 kill criteria.
TDD steps:
1. Write test: add assertions that the script result includes evidence/source labels for each harness.
2. Run test: confirm failure until evidence labels are present.
3. Implement: add evidence labels to the script result and update docs with final validation output.
4. Run test: `bun test test/w0-harness-parity.test.js` and `node scripts/spikes/skill-auto-invoke-parity.js --json`.
5. Commit: `docs: record w0 harness parity evidence`
Expected output: docs contain final validation commands and any known issue status; script output maps harness results to source labels.

## Validation Plan

1. `bun test test/w0-harness-parity.test.js`
2. `node scripts/spikes/skill-auto-invoke-parity.js --json`
3. `bun test --timeout 15000` if runtime permits; otherwise document timeout separately and keep the W0 targeted validation explicit.

## First /dev Focus

Start with Task 1 and keep the implementation independent of any Beads bootstrap recovery edits already present in the worktree.
