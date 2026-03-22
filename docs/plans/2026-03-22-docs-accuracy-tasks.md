# Task List: docs-accuracy

**Epic**: forge-e3qj
**Design**: docs/plans/2026-03-22-docs-accuracy-design.md
**Branch**: feat/docs-accuracy
**Worktree**: .worktrees/docs-accuracy

## Parallel Waves

```
Wave 1 (parallel): Tasks 1-6 (all independent README edits)
Wave 2 (parallel): Tasks 7-11 (CHANGELOG, test, QUICKSTART, ROADMAP, GREPTILE — all independent)
```

## Dependency Graph

```
Task 1 ──┐
Task 2 ──┤
Task 3 ──┤
Task 4 ──┼──▶ Wave 1 complete ──▶ Task 7 (CHANGELOG)
Task 5 ──┤                   ├──▶ Task 8 (test + catalog fix)
Task 6 ──┘                   ├──▶ Task 9 (QUICKSTART /research fix)
                              ├──▶ Task 10 (ROADMAP stale dates)
                              └──▶ Task 11 (GREPTILE hardcoded PR)
```

---

## Task 1: Remove version tags and reframe feature headers (forge-zl6y)

**File(s)**: README.md (lines 166, 180, 194)
**What to implement**: Remove "(v1.5.0)", "(v1.7.0)", "(v1.6.0)" from feature section headers. Reframe each header to lead with developer value, not version number. Examples:
- "Built-in TDD Enforcement (v1.5.0)" → "Built-in TDD Enforcement"
- "Smart Tool Recommendations (v1.7.0)" → "Smart Tool Recommendations"
- "Enhanced Onboarding (v1.6.0)" → "Enhanced Onboarding"
Also remove the "New" emoji from line 194 since there's no version context for it.

**TDD steps**:
1. This is a doc-only change — no test needed
2. Verify: grep for "v1\.[567]" in README returns no matches after edit

**Expected output**: No version tags in README feature headers

---

## Task 2: Soften OWASP claim (forge-64x0)

**File(s)**: README.md (line 48)
**What to implement**: Change "OWASP Top 10 analysis built-in" to "OWASP Top 10 analysis in every /plan". This is accurate — OWASP is a manual checklist in /plan Phase 2, documented in design docs, not an automated gate.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: grep for "OWASP.*built-in" in README returns no matches

**Expected output**: README accurately describes OWASP as part of /plan workflow

---

## Task 3: Reframe tool catalog around categories (forge-g491)

**File(s)**: README.md (line 181)
**What to implement**: Replace "Intelligent plugin catalog with 30+ curated tools:" with framing around category breadth. The catalog has 15 tools across 7 categories (research, dev, validate, ship, review, premerge, plan). Suggested wording: "Curated plugin catalog across 7 workflow stages:" — emphasizes breadth and integration with the 7-stage workflow rather than raw count.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: grep for "30+" in README returns no matches

**Expected output**: README frames catalog value around workflow coverage, not tool count

---

## Task 4: Replace "CLI-first" with portability-first wording (forge-qk9d)

**File(s)**: README.md (line 184)
**What to implement**: Replace "CLI-first: Prefers CLI tools over MCPs for portability" with "Portability-first: MCPs included only when they add clear value over CLI alternatives". This matches the actual mcpJustified filtering logic in plugin-recommender.js:117-124.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: grep for "CLI-first" in README returns no matches

**Expected output**: README accurately describes MCP filtering strategy

---

## Task 5: Fix Plugin docs link (forge-sl2f)

**File(s)**: README.md (line 192)
**What to implement**: Change `[Plugin docs](lib/agents/README.md)` to `[Plugin docs](docs/TOOLCHAIN.md)`. Users clicking "Plugin docs" want setup/usage info, not agent architecture source code.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: grep for "lib/agents/README.md" in README returns no matches

**Expected output**: Plugin docs link points to user-facing toolchain guide

---

## Task 6: Fix profile stage counts in README (forge-6fm1)

**File(s)**: README.md (lines 213-218)
**What to implement**: The workflow profiles section currently lists specific profiles with stage counts. The actual code (lib/workflow-profiles.js) has 6 profiles ranging from 3 to 8 stages:
- critical: 8, standard: 7, refactor: 5, simple: 4, hotfix: 3, docs: 3

Update the profiles list in README to match actual code. The profile names and stage counts in the README (feature=7, fix=5, refactor=5, chore=3) don't match the code names (critical=8, standard=7, simple=4, hotfix=3, docs=3, refactor=5). Fix to use actual profile names and counts.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: README profile names match lib/workflow-profiles.js exactly

**Expected output**: README profiles match code reality

---

## Task 7: Add CHANGELOG rename note (forge-4oxc)

**File(s)**: CHANGELOG.md (top of file)
**What to implement**: Add a note at the top of CHANGELOG (after the title/header) clarifying:
"Note: `/check` was renamed to `/validate` and `/merge` was renamed to `/premerge` in v0.0.3. Historical entries below may use the old names."

Do NOT rewrite historical entries — this preserves the record while preventing confusion.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: note exists at top of CHANGELOG

**Expected output**: CHANGELOG has clarifying note about stage renames

---

## Task 8: Add paid-alternatives enforcement test + fix catalog (forge-b1ai)

**File(s)**:
- test/lib/plugin-catalog.test.js (new test)
- lib/plugin-catalog.js (fix parallel-deep-research entry)

**What to implement**:
1. Add test that iterates all CATALOG entries, finds those with `tier: 'paid'`, and asserts each has a non-empty `alternatives` array where each alternative has `tool` and `tier` fields.
2. Add `alternatives` array to `parallel-deep-research` entry (line 78) with at least one free alternative (e.g., WebSearch as the free alternative, since it's already referenced in other code as the fallback).

**TDD steps**:
1. Write test: `test/lib/plugin-catalog.test.js` — assert all paid entries have alternatives with tool+tier
2. Run test: confirm it FAILS (parallel-deep-research has no alternatives)
3. Implement: add `alternatives: [{ tool: 'WebSearch', tier: 'free', note: 'Built-in web search — no API key needed' }]` to parallel-deep-research
4. Run test: confirm it PASSES
5. Commit: `test: add paid-alternatives enforcement for plugin catalog` then `fix: add free alternative to parallel-deep-research`

**Expected output**: Test passes, all paid catalog entries have free alternatives defined

---

## Task 9: Fix QUICKSTART.md /research stage reference

**File(s)**: QUICKSTART.md (lines 95-113)
**What to implement**: QUICKSTART references `/research` as a separate stage/command, but research is Phase 2 of `/plan` — not its own command. Fix the section to show research as part of `/plan` output, not a separate step. Ensure the walkthrough matches the actual 7-stage workflow (/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify).

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: grep for "/research" in QUICKSTART.md returns no matches as a stage name

**Expected output**: QUICKSTART walkthrough matches actual workflow stages

---

## Task 10: Update ROADMAP.md stale status info

**File(s)**: docs/ROADMAP.md
**What to implement**: ROADMAP has stale status information — Feb 2026 plans and PR merge dates that are inconsistent with current date (March 2026). Update status of completed items, remove outdated timeline references, and ensure the roadmap reflects current project state.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: no obviously stale dates or incorrect PR statuses remain

**Expected output**: ROADMAP reflects current project state accurately

---

## Task 11: Fix GREPTILE_SETUP.md hardcoded PR reference

**File(s)**: docs/GREPTILE_SETUP.md (line 375)
**What to implement**: Replace hardcoded "Your PR #13" reference with a generic example or a note to use your own PR number. Hardcoded PR references become stale as the repo evolves.

**TDD steps**:
1. Doc-only change — no test needed
2. Verify: no hardcoded PR numbers remain as "examples" in the guide

**Expected output**: GREPTILE_SETUP uses generic/dynamic PR references
