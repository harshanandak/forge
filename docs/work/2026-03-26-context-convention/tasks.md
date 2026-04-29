# Context Convention — Task List

**Feature**: context-convention
**Date**: 2026-03-26
**Issue**: forge-8scl
**Design doc**: docs/plans/2026-03-26-context-convention-design.md

---

## Wave 1: Template Enhancement (no dependencies)

### Task 1: Extend stage-transition comment format

**File(s)**: `scripts/beads-context.sh`

**What**: Modify the `cmd_stage_transition` function to accept and include optional flags: `--summary` (what was accomplished), `--decisions` (key choices made), `--artifacts` (file paths, PR URLs, commit SHAs), `--next` (priorities for next stage). All optional but logged when provided. Current format `"Stage: X complete -> ready for Y"` becomes the header; new fields append as structured lines below it. Existing calls without flags continue to work unchanged.

**TDD**:
1. Write test: `test/beads-context-transition.test.js` -- assert stage-transition with all four flags produces a structured comment containing `Summary:`, `Decisions:`, `Artifacts:`, `Next:` sections below the header line
2. Run test: expect fail (flags not parsed yet)
3. Implement: Extend `cmd_stage_transition` in `beads-context.sh` to parse `--summary`, `--decisions`, `--artifacts`, `--next` flags after the three positional args, build multi-line comment, pass to `bd_comment`
4. Run test: expect pass
5. Commit: `feat: extend stage-transition with structured context fields`

---

### Task 2: Add validate subcommand

**File(s)**: `scripts/beads-context.sh`

**What**: Add `beads-context.sh validate <id>` subcommand that checks: (1) issue has a description (via `bd show`), (2) at least one stage transition comment exists (grep beads comments for "Stage:" pattern), (3) most recent transition has a summary field, (4) design metadata is set (if issue is past plan stage, i.e., has a "plan complete" transition). Output: list of warnings. Exit 0 always (advisory). Print "All context fields present" when everything checks out, or "Missing: <field1>, <field2>" with details for each gap.

**TDD**:
1. Write test: `test/beads-context-validate.test.js` -- assert validate on well-documented issue exits 0 with no warnings; assert validate on sparse issue exits 0 with warning lines listing missing fields; assert validate on nonexistent ID exits non-zero; assert validate before any transitions warns "no transitions recorded"
2. Run test: expect fail (validate subcommand doesn't exist)
3. Implement: Add `cmd_validate` function and `validate)` case to the dispatcher in `beads-context.sh`
4. Run test: expect pass
5. Commit: `feat: add beads-context validate subcommand`

---

## Wave 2: Convention Documentation (depends on Wave 1)

### Task 3: Add convention section to AGENTS.md

**File(s)**: `AGENTS.md`

**What**: Add a `## Descriptive Context Convention` section documenting: (1) purpose -- why structured context matters for cross-session continuity, (2) required fields at each stage exit (`--summary` always required, others stage-dependent), (3) the validation command (`bash scripts/beads-context.sh validate <id>`), (4) field definitions with examples of good vs sparse transitions, (5) enforcement level (advisory warnings, not hard blocks). Place after the existing "Documentation Index" section and before the Beads Integration section.

**TDD**:
1. Write test: `test/agents-md-convention.test.js` -- assert AGENTS.md contains "Descriptive Context Convention" heading, contains "beads-context.sh validate" reference, contains field definition subsections (Summary, Decisions, Artifacts, Next)
2. Run test: expect fail (section doesn't exist)
3. Implement: Add the section to AGENTS.md
4. Run test: expect pass
5. Commit: `docs: add descriptive context convention to AGENTS.md`

---

### Task 4: Update command files to reference convention

**File(s)**: `.claude/commands/plan.md`, `.claude/commands/dev.md`, `.claude/commands/validate.md`, `.claude/commands/ship.md`, `.claude/commands/review.md`, `.claude/commands/premerge.md`

**What**: At each stage's exit HARD-GATE section, add instruction: "Run `bash scripts/beads-context.sh validate <id>` and address any warnings before proceeding." Also update existing `stage-transition` call examples to include `--summary` and `--decisions` flags showing the expected pattern. Do not modify `/status` or `/verify` (utility stages without transitions).

**TDD**:
1. Write test: `test/commands-convention-ref.test.js` -- assert each of the 6 command files contains `beads-context.sh validate` reference and at least one `--summary` flag in a stage-transition example
2. Run test: expect fail (references not added yet)
3. Implement: Edit each command file to add validate call and update stage-transition examples
4. Run test: expect pass
5. Commit: `docs: reference context convention in all workflow commands`

---

### Task 5: Sync commands to agent directories

**File(s)**: (run sync script)

**What**: After editing `.claude/commands/*.md` in Task 4, run `node scripts/sync-commands.js` to propagate changes to all 7 agent directories. Verify with `--check` flag.

**TDD**:
1. Write test: `test/command-sync-check.test.js` -- assert `node scripts/sync-commands.js --check` exits 0 (no drift between source and agent copies)
2. Run test: expect fail (commands just changed in Task 4, not yet synced)
3. Implement: Run `node scripts/sync-commands.js`
4. Run test: expect pass
5. Commit: `chore: sync commands to agent directories`
