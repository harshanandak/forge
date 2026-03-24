# P1 Bugfixes — Task List

**Design**: [2026-03-24-p1-bugfixes-design.md](2026-03-24-p1-bugfixes-design.md)
**Beads**: forge-eji

## Parallel Wave Structure

```
Wave 1 (parallel — no dependencies between tasks):
  Task 1: Fix plan file path contract (forge-ddk3)
  Task 2: Rewrite ENHANCED_ONBOARDING.md (forge-3tnu)
  Task 3: Fix smart-status.sh jq error (new)

Wave 2 (after Wave 1):
  Task 4: Validate all changes together
```

---

## Task 1: Fix plan file path contract (forge-ddk3)

**File(s)**:
- `bin/forge-cmd.js` (line ~226)
- `lib/agents-config.js` (lines ~946, ~1274)
- `docs/VALIDATION.md` (line ~127)
- `docs/ROADMAP.md` (lines ~311, ~350)
- `test/commands/status.test.js` (multiple lines)

**What to implement**: Replace all `.claude/plans` references with `docs/plans` in source code, docs, and tests.

**TDD steps**:
1. Update `test/commands/status.test.js` — change all `.claude/plans/feature.md` to `docs/plans/feature.md`
2. Run tests — confirm status tests fail (they expect `.claude/plans` but code will now look in `docs/plans`)
3. Update `bin/forge-cmd.js:226` — change `fs.existsSync('.claude/plans')` to `fs.existsSync('docs/plans')`
4. Update `lib/agents-config.js:946,1274` — change path strings
5. Update `docs/VALIDATION.md:127` and `docs/ROADMAP.md:311,350` — change documented paths
6. Run tests — confirm they pass
7. Commit: `fix: unify plan file path on docs/plans/ (forge-ddk3)`

**Expected output**: Status command finds plans in `docs/plans/`, all tests pass.

---

## Task 2: Rewrite ENHANCED_ONBOARDING.md (forge-3tnu)

**File(s)**:
- `docs/ENHANCED_ONBOARDING.md`

**What to implement**: Rewrite to match actual product:
- Change "9-stage" to "7-stage" everywhere
- Remove `/research` from workflow chains (it's folded into `/plan`)
- Replace `--type=feature/fix/chore/refactor` with valid values: `critical|standard|simple|hotfix|docs|refactor`
- Update workflow stage listings to match AGENTS.md
- Fix the workflow mapping table
- Update version references

**TDD steps**:
1. No unit tests for docs — but grep-verify after:
   - `grep -c "9-stage" docs/ENHANCED_ONBOARDING.md` should return 0
   - `grep -c "/research" docs/ENHANCED_ONBOARDING.md` should return 0 (as a stage)
   - `grep -c "\-\-type=feature" docs/ENHANCED_ONBOARDING.md` should return 0
   - `grep -c "\-\-type=fix" docs/ENHANCED_ONBOARDING.md` should return 0
   - `grep -c "\-\-type=chore" docs/ENHANCED_ONBOARDING.md` should return 0
2. Rewrite the document
3. Verify with grep checks above
4. Commit: `fix: rewrite ENHANCED_ONBOARDING.md to match 7-stage workflow (forge-3tnu)`

**Expected output**: Document accurately describes 7-stage workflow with valid --type values.

---

## Task 3: Fix smart-status.sh jq error

**File(s)**:
- `scripts/smart-status.sh` (jq expressions at lines ~160-166, ~174-178, ~737)

**What to implement**: Update jq to handle beads 0.62.0 field type changes:
- Priority: normalize number (0-4) to string ("P0"-"P4") before comparison, or compare against both
- Type: handle null type (default to "task" or use null-safe comparison)
- String concatenation: use `tostring` on priority/type before concatenating in output lines

**TDD steps**:
1. Run `smart-status.sh` — confirm it crashes with jq error (baseline)
2. Fix jq priority comparison (lines ~160-166): check for both `== "P0"` and `== 0`
3. Fix jq type comparison (lines ~174-178): add null handling
4. Fix jq output concatenation (line ~737): use `(tostring)` for priority, `// "unknown"` for type
5. Run `smart-status.sh` — confirm it completes without error
6. Commit: `fix: smart-status.sh handle numeric priorities and null types from beads 0.62`

**Expected output**: `smart-status.sh` runs cleanly with beads 0.62.0 JSON output.

---

## Task 4: Validate all changes

**What to do**:
1. Run full test suite: `bun test`
2. Run `smart-status.sh` end-to-end
3. Verify no remaining `.claude/plans` references in source (excluding .beads/, .forge/pr-body.md, CHANGELOG.md)
4. Verify no "9-stage" or invalid --type in ENHANCED_ONBOARDING.md
