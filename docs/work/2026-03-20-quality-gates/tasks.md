# Task List: Quality Gate Honesty + CI Path Filter Gaps

**Issue**: forge-twiw (covers forge-mr0l + forge-ypeh)
**Branch**: feat/quality-gates
**Design**: docs/plans/2026-03-20-quality-gates-design.md
**Baseline**: 1544 pass, 12 fail (pre-existing), 9 errors (pre-existing)

## Parallel Wave Structure

```
Wave 1 (independent — all in parallel):
  Task 1: validate.sh typecheck honesty
  Task 2: test.yml add packages/** path
  Task 3: eslint.yml path filters + remove schedule
  Task 4: codeql.yml path filters on push/PR
  Task 5: size-check.yml path filters
  Task 6: dependency-review.yml path filter
  Task 7: yaml-lint.yml bump setup-bun v2

Wave 2 (depends on all Wave 1):
  Task 8: YAML validity check + test baseline
```

---

## Task 1: validate.sh — honest typecheck skip

**File(s)**: `scripts/validate.sh`
**What to implement**: Replace step 1 `bun run typecheck` call with a `print_warning` that says "Type Check — SKIPPED (no TypeScript in project)". Keep the 4-step numbering.

**TDD steps**:
1. Write test: Not applicable (shell script — validated manually)
2. Implement: Change lines 52-59 to use `print_warning` instead of calling `bun run typecheck`
3. Verify: Run `bash scripts/validate.sh` — step 1 should print yellow warning, not green pass
4. Commit: `fix: validate.sh typecheck step honestly reports skip`

**Expected output**: Step 1 prints "Step 1/4: Type Check" header then yellow "SKIPPED (no TypeScript in project)"

---

## Task 2: test.yml — add packages/** path filter

**File(s)**: `.github/workflows/test.yml`
**What to implement**: Add `- 'packages/**'` to both the `push.paths` and `pull_request.paths` arrays.

**TDD steps**:
1. Write test: YAML parse validation (Task 8)
2. Implement: Add `- 'packages/**'` after `- 'test-env/**'` in both path arrays (lines ~11 and ~20)
3. Verify: YAML parses correctly
4. Commit: `fix: test.yml add packages/** to path filters`

**Expected output**: PRs touching workspace packages now trigger the test suite

---

## Task 3: eslint.yml — add path filters, remove schedule

**File(s)**: `.github/workflows/eslint.yml`
**What to implement**:
- Add `paths` filter to both `push` and `pull_request` triggers: `bin/**`, `lib/**`, `scripts/**`, `test/**`, `packages/**`, `package.json`, `.github/workflows/**`, `*.js`, `.claude/**/*.js`
- Remove the `schedule` section (lines 18-19)

**TDD steps**:
1. Write test: YAML parse validation (Task 8)
2. Implement: Add path arrays, remove schedule cron
3. Verify: YAML parses correctly, no schedule trigger present
4. Commit: `fix: eslint.yml add path filters and remove redundant schedule`

**Expected output**: ESLint CI only runs when code files change, not on docs-only PRs

---

## Task 4: codeql.yml — add path filters on push/PR

**File(s)**: `.github/workflows/codeql.yml`
**What to implement**:
- Add `paths` filter to `push` trigger: `bin/**`, `lib/**`, `scripts/**`, `packages/**`, `.github/workflows/**`
- Add `paths` filter to `pull_request` trigger: same paths
- Keep the weekly `schedule` trigger unchanged

**TDD steps**:
1. Write test: YAML parse validation (Task 8)
2. Implement: Add path arrays to push and pull_request sections
3. Verify: YAML parses correctly, schedule section still present
4. Commit: `fix: codeql.yml add code-only path filters, keep weekly schedule`

**Expected output**: CodeQL push/PR runs scoped to code changes; weekly full scan preserved

---

## Task 5: size-check.yml — add path filters

**File(s)**: `.github/workflows/size-check.yml`
**What to implement**:
- Add `paths` filter to both `push` and `pull_request` triggers: `package.json`, `bin/**`, `lib/**`, `packages/**`

**TDD steps**:
1. Write test: YAML parse validation (Task 8)
2. Implement: Add path arrays to both trigger sections
3. Verify: YAML parses correctly
4. Commit: `fix: size-check.yml add package-relevant path filters`

**Expected output**: Size check only runs when package-impacting files change

---

## Task 6: dependency-review.yml — scope to package.json

**File(s)**: `.github/workflows/dependency-review.yml`
**What to implement**:
- Add `paths` filter to `pull_request` trigger: `package.json`

**TDD steps**:
1. Write test: YAML parse validation (Task 8)
2. Implement: Add paths array to pull_request section
3. Verify: YAML parses correctly
4. Commit: `fix: dependency-review.yml scope to package.json changes`

**Expected output**: Dependency review only runs when package.json changes

---

## Task 7: yaml-lint.yml — bump setup-bun version

**File(s)**: `.github/workflows/yaml-lint.yml`
**What to implement**:
- Change `uses: oven-sh/setup-bun@v1` to `uses: oven-sh/setup-bun@v2`

**TDD steps**:
1. Write test: YAML parse validation (Task 8)
2. Implement: Change v1 to v2 on line 28
3. Verify: YAML parses correctly
4. Commit: `fix: yaml-lint.yml bump setup-bun v1 to v2`

**Expected output**: Consistent setup-bun version across all workflows

---

## Task 8: YAML validity + test baseline (Wave 2)

**File(s)**: All modified workflow files
**What to implement**: Validate all modified YAML files parse correctly. Run test suite to confirm no regressions.

**TDD steps**:
1. Run: `bun x js-yaml .github/workflows/test.yml`
2. Run: `bun x js-yaml .github/workflows/eslint.yml`
3. Run: `bun x js-yaml .github/workflows/codeql.yml`
4. Run: `bun x js-yaml .github/workflows/size-check.yml`
5. Run: `bun x js-yaml .github/workflows/dependency-review.yml`
6. Run: `bun x js-yaml .github/workflows/yaml-lint.yml`
7. Run: `bun test` — confirm same baseline (1544 pass, 12 pre-existing fail)
8. Commit: final commit if any fixes needed

**Expected output**: All YAML files parse without error, test count unchanged
