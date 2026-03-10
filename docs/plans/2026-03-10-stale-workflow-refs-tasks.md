# Tasks: Clean up stale workflow refs in agent commands

**Beads**: forge-ctc
**Branch**: feat/stale-workflow-refs
**Design**: docs/plans/2026-03-10-stale-workflow-refs-design.md

---

## Task 1: Fix status.md — remove openspec, PROGRESS.md, /research

**File(s)**: `.claude/commands/status.md`

**What to implement**:
- Line 21: Replace `cat docs/planning/PROGRESS.md` with `bd stats` and `bd list --status completed --limit 5`
- Lines 33-34: Remove `openspec list --active` block entirely
- Lines 44-46: Remove `openspec list --archived --limit 3` block entirely
- Line 69: Change `Next: /research <feature-name>` → `Next: /plan <feature-name>`
- Line 74: Change `Run /research <feature-name>` → `Run /plan <feature-name>`
- Update example output to reflect Beads-only tracking (no OpenSpec)
- Update "Next Steps" section to reference `/plan` not `/research`

**TDD steps**:
1. Run: `grep -c 'openspec\|PROGRESS\.md\|/research' .claude/commands/status.md` → expect 5+ matches
2. Make edits
3. Run: `grep -c 'openspec\|PROGRESS\.md\|/research' .claude/commands/status.md` → expect 0 matches
4. Verify workflow flow (if present) matches 7-stage
5. Commit: `docs: fix stale refs in status.md — remove openspec, PROGRESS.md, /research`

**Expected output**: status.md references only Beads (`bd`) for tracking, `/plan` for next steps

---

## Task 2: Fix rollback.md — update workflow flow diagrams

**File(s)**: `.claude/commands/rollback.md`

**What to implement**:
- Line 309: Change `/status → /research → /plan → /dev → /validate → /ship → /review → /premerge → /verify` → `/status → /plan → /dev → /validate → /ship → /review → /premerge → /verify`
- Line 314: Same fix for the recovery workflow line if it has /research
- Line 334: Change `/research payment-integration` → `/plan payment-integration`
- Check for any other stale refs in the file

**TDD steps**:
1. Run: `grep -c '/research' .claude/commands/rollback.md` → expect 2+ matches
2. Make edits
3. Run: `grep -c '/research' .claude/commands/rollback.md` → expect 0 matches
4. Verify all workflow flows show correct 7-stage
5. Commit: `docs: fix stale workflow refs in rollback.md — remove /research stage`

**Expected output**: All workflow diagrams in rollback.md show 7-stage pipeline

---

## Task 3: Fix premerge.md — replace PROGRESS.md with CHANGELOG.md step

**File(s)**: `.claude/commands/premerge.md`

**What to implement**:
- Line 49: Replace `docs/planning/PROGRESS.md` section with CHANGELOG.md update step:
  - Add entry under correct version heading using Keep a Changelog format
  - Categories: Added, Changed, Fixed, Removed (match existing CHANGELOG.md style)
  - Include: feature name, PR number, Beads ID
- Line 135: Update example output to show CHANGELOG.md instead of PROGRESS.md
- Keep the note about `docs/planning/` being gitignored if PROGRESS.md section is fully replaced

**TDD steps**:
1. Run: `grep -c 'PROGRESS\.md' .claude/commands/premerge.md` → expect 2 matches
2. Make edits
3. Run: `grep -c 'PROGRESS\.md' .claude/commands/premerge.md` → expect 0 matches
4. Run: `grep -c 'CHANGELOG' .claude/commands/premerge.md` → expect 1+ matches
5. Commit: `docs: replace PROGRESS.md with CHANGELOG.md step in premerge`

**Expected output**: premerge.md instructs agents to update CHANGELOG.md before merge handoff

---

## Task 4: Final verification — grep for all stale terms across touched files

**File(s)**: All 3 files

**What to implement**:
- Run grep for `openspec`, `PROGRESS.md`, `/research` across all `.claude/commands/` (excluding `research.md` legacy alias)
- Verify 0 matches
- Run grep for consistent workflow flow in all touched files

**TDD steps**:
1. Run: `grep -l 'openspec\|PROGRESS\.md' .claude/commands/status.md .claude/commands/rollback.md .claude/commands/premerge.md` → expect 0 matches
2. Run: `grep '/research' .claude/commands/status.md .claude/commands/rollback.md .claude/commands/premerge.md` → expect 0 matches
3. Verify each file's workflow diagram (if present) matches the canonical 7-stage flow
4. No commit needed — verification only
