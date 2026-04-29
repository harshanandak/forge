# Dependabot Setup — Task List

**Design doc**: `docs/plans/2026-03-26-dependabot-design.md`
**Issue**: forge-bkgg

---

## Wave 1: Dependabot Configuration

### Task 1: Create dependabot.yml

**File(s)**: `.github/dependabot.yml`

**What**: Create Dependabot configuration with:
- npm ecosystem: weekly Monday 7am UTC, group production deps, group dev deps separately, labels `["dependencies"]`, open-pull-requests-limit 10
- github-actions ecosystem: weekly Monday 7am UTC, group all, labels `["github-actions", "dependencies"]`

**TDD**:
1. Write test: `test/dependabot-config.test.js` — assert `.github/dependabot.yml` exists, is valid YAML, has npm + github-actions ecosystems, has weekly schedule, has groups defined
2. Run test: expect fail (file doesn't exist)
3. Implement: Create `.github/dependabot.yml`
4. Run test: expect pass
5. Commit: `feat: add Dependabot configuration for npm and GitHub Actions`

### Task 2: Verify yamllint compatibility

**File(s)**: `.github/dependabot.yml`

**What**: Ensure the new YAML file passes the existing yaml-lint workflow. Run yamllint locally if available, or verify structure matches yamllint expectations.

**TDD**:
1. Write test: `test/dependabot-yaml-lint.test.js` — assert dependabot.yml passes yaml parsing without errors
2. Run test: expect fail (no file yet — or pass if Task 1 done)
3. Verify: Check against existing `.yamllint` config if present
4. Run test: expect pass
5. Commit: (amend Task 1 commit if needed, or no separate commit)

---

## Wave 2: Documentation

### Task 3: Document bd minimum version in TOOLCHAIN.md

**File(s)**: `docs/TOOLCHAIN.md`

**What**: Add a "CLI Tools" or "Global Dependencies" section documenting: bd (beads) minimum version, how to check version (`bd --version`), where to install. Don't pin — just document the minimum compatible version.

**TDD**:
1. Write test: `test/toolchain-bd-version.test.js` — assert TOOLCHAIN.md contains "bd" or "beads" version reference
2. Run test: expect fail
3. Implement: Add section to TOOLCHAIN.md
4. Run test: expect pass
5. Commit: `docs: document minimum bd version in TOOLCHAIN.md`

---

## Dependency Graph

```
Wave 1: Task 1 → Task 2 (sequential — Task 2 validates Task 1 output)
Wave 2: Task 3 (independent — can run parallel with Wave 1)
```
