# Task List: Command Creator & Eval

- **Feature**: command-creator-and-eval
- **Date**: 2026-03-10
- **Beads**: forge-jfw (PR-A), forge-agp (PR-B), forge-1jx (PR-C)
- **Branch**: feat/command-creator-and-eval
- **Worktree**: .worktrees/command-creator-and-eval
- **Design doc**: docs/plans/2026-03-10-command-creator-and-eval-design.md
- **Baseline**: 1160 pass, 5 fail (pre-existing chalk errors in skills package), 31 skip

---

## PR-A: Static Command Validator + Sync Infrastructure (forge-jfw)

Ship order: **FIRST** (no dependencies, highest ROI)

---

### Task 1: Dead reference detection tests (RED)

**File(s)**: `test/structural/command-files.test.js`

**What to implement**: Add a new `describe` block "dead reference checks" that reads every `.claude/commands/*.md` file and checks for known stale references:
- `openspec` (removed tool)
- `/merge` (renamed to `/premerge`)
- `/check` when used as a stage name (renamed to `/validate`)
- `docs/planning/PROGRESS.md` (removed file)
- `9-stage` or `nine stage` (now 7 stages)

**TDD steps**:
1. Write test: `test/structural/command-files.test.js` — new describe block with 5 regex patterns, assert none match
2. Run test: confirm it FAILS (known: `/status` has `openspec list`, `/rollback` has 9-stage ref)
3. Note: do NOT fix the commands here — that's forge-ctc's job. Tests document the problem.
4. Mark failing tests with `.todo()` so CI stays green until forge-ctc lands
5. Commit: `test: add dead reference detection for command files`

**Expected output**: 5 new `.todo()` tests that will pass once forge-ctc lands.

---

### Task 2: Cross-command contract tests (RED → GREEN)

**File(s)**: `test/structural/command-contracts.test.js` (new file)

**What to implement**: Verify that commands reference each other correctly:
- `/plan` output mentions `docs/plans/YYYY-MM-DD-<slug>-tasks.md` → `/dev` input expects this pattern
- `/plan` mentions `docs/plans/YYYY-MM-DD-<slug>-design.md` → `/ship` references design doc
- `/dev` mentions `bun test` or `TEST_COMMAND` → `/validate` runs tests
- `/ship` mentions `gh pr create` → `/review` mentions PR
- All 7 workflow commands reference the correct stage numbers (plan=1, dev=2, validate=3, ship=4, review=5, premerge=6, verify=7)

**TDD steps**:
1. Write test: new file `test/structural/command-contracts.test.js` — 5 contract assertions
2. Run test: confirm passes (these contracts should already hold)
3. If any fail: document which contract is broken, mark as `.todo()`
4. Commit: `test: add cross-command contract tests`

**Expected output**: 5+ passing contract tests.

---

### Task 3: Sync script — frontmatter parser utility

**File(s)**: `scripts/sync-commands.js`

**What to implement**: A utility module that:
- Reads a `.claude/commands/*.md` file
- Extracts YAML frontmatter (between `---` markers)
- Returns `{ frontmatter: object, body: string }`
- Can reconstruct a file with different frontmatter: `buildFile(newFrontmatter, body)`

**TDD steps**:
1. Write test: `test/scripts/sync-commands.test.js` — parse frontmatter from sample command, rebuild with different frontmatter
2. Run test: confirm fails (module doesn't exist)
3. Implement: `scripts/sync-commands.js` with `parseFrontmatter()` and `buildFile()` functions
4. Run test: confirm passes
5. Commit: `feat: add frontmatter parser for command sync`

**Expected output**: `parseFrontmatter('---\ndescription: X\n---\nbody')` → `{ frontmatter: { description: 'X' }, body: 'body' }`

---

### Task 4: Sync script — adapter transforms per agent

**File(s)**: `scripts/sync-commands.js`

**What to implement**: Add an `AGENT_ADAPTERS` config object that maps each agent to its:
- Target directory
- File extension
- Frontmatter transform function (strip, keep, add fields)

Read agent capabilities from `lib/agents/*.plugin.json` to determine which agents to sync.

Agents (9 total):
- Claude Code: no-op (canonical)
- OpenCode: keep `description`
- Cursor: strip all frontmatter
- Cline: strip all frontmatter
- Windsurf: keep `description`
- Kilo Code: keep `description`, add `mode: code`
- Roo Code: keep `description`, add `mode: code`
- Continue: add `name`, `description`, `invokable: true`; change ext to `.prompt`
- GitHub Copilot: add `name`, `description`; change ext to `.prompt.md`
- Codex: special case (combined SKILL.md file)

**TDD steps**:
1. Write test: `test/scripts/sync-commands.test.js` — for each agent, assert transform produces correct frontmatter and extension
2. Run test: confirm fails
3. Implement: adapter transforms in `scripts/sync-commands.js`
4. Run test: confirm passes
5. Commit: `feat: add agent adapter transforms for command sync`

**Expected output**: `adaptForAgent('cursor', { description: 'X' }, 'body')` → `{ content: 'body', filename: 'plan.md', dir: '.cursor/commands/' }`

---

### Task 5: Sync script — CLI entry point (`sync-commands` command)

**File(s)**: `scripts/sync-commands.js`

**What to implement**: Add CLI entry point that:
- Reads all `.claude/commands/*.md` files
- For each agent with `commands: true` in plugin.json: generates adapted files
- Writes to agent-specific directories
- `--dry-run` flag: prints what would be written without writing
- `--check` flag: compares existing files, exits non-zero if out of sync
- Warns before overwriting files that have been manually modified (content hash check)

**TDD steps**:
1. Write test: `test/scripts/sync-commands.test.js` — test `--check` mode against a mock filesystem with one in-sync and one out-of-sync agent
2. Run test: confirm fails
3. Implement: CLI entry point with `--dry-run` and `--check` flags
4. Run test: confirm passes
5. Commit: `feat: add sync-commands CLI with --dry-run and --check flags`

**Expected output**: `node scripts/sync-commands.js --dry-run` prints list of files to generate. `--check` exits 0 when in sync.

---

### Task 6: Sync drift test integration

**File(s)**: `test/structural/command-sync.test.js` (new file)

**What to implement**: A test that runs the sync script in `--check` mode and asserts it passes. This catches sync drift in CI.

**TDD steps**:
1. Write test: `test/structural/command-sync.test.js` — spawns `node scripts/sync-commands.js --check`, asserts exit code 0
2. Run test: confirm fails (no agent dirs exist yet)
3. Run `node scripts/sync-commands.js` to generate all agent dirs
4. Run test: confirm passes
5. Commit: `test: add sync drift detection test`

**Expected output**: Test passes when all agent command files match canonical source.

---

### Task 7: agnix evaluation + integration

**File(s)**: `package.json` (devDependency), `test/structural/agnix-lint.test.js` (new)

**What to implement**: Evaluate agnix (`npx agnix .`) against the repo. If it provides value beyond our custom tests:
- Add as devDependency
- Create test that runs `npx agnix . --format json` and asserts 0 errors
- Document which agnix rules overlap with our custom tests (to avoid duplication)

If agnix is not useful (too many false positives, doesn't cover Forge-specific checks): skip and document why.

**TDD steps**:
1. Run `npx agnix . --format json` manually, review output
2. If useful: write test, add devDep, implement
3. If not useful: document findings in design doc, skip
4. Commit: `feat: integrate agnix multi-agent linter` or `docs: skip agnix — findings documented`

**Expected output**: Decision documented. If integrated, `bun test` includes agnix validation.

---
### Task 8: Add blast-radius search to /plan command (prevention)**File(s)**: `.claude/commands/plan.md`**What to implement**: Add a "Blast-radius search" subsection after the existing DRY check in Phase 2. Fires when a feature involves removing, renaming, or replacing something. Directly prevents the gap that caused PR #54 incomplete Antigravity removal.Add after DRY check section:- Title: `### Blast-radius search (mandatory for remove/rename/replace features)`- Steps: grep the entire codebase for the thing being removed, add cleanup tasks for every match- Flag matches in unexpected packages explicitlyAlso add condition 4 to Phase 2 exit HARD-GATE:- `4. If feature involves removal/rename: blast-radius search completed, all references in task list`**TDD steps**:1. Write test: extend `test/structural/command-files.test.js` — assert plan.md contains "blast-radius"2. Run test: confirm fails3. Implement: edit `.claude/commands/plan.md`4. Run test: confirm passes5. Commit: `feat: add blast-radius search to /plan Phase 2`**Expected output**: /plan now requires blast-radius grep for removal/rename features.---

## PR-B: Command Behavioral Eval + Improvement Loop (forge-agp)

Ship order: **SECOND** (depends on PR-A)

---

### Task 9: Grader agent for command evaluation

**File(s)**: `.claude/agents/command-grader.md` (new)

**What to implement**: Adapt skill-creator's `agents/grader.md` for command evaluation. The grader receives:
- Command name (e.g., `/status`)
- Execution transcript (stream-json output)
- List of assertions (e.g., "lists beads issues", "shows current branch")

Returns: `grading.json` with `{ text, passed, evidence }` per assertion.

Key differences from skill-creator grader:
- Evaluates multi-turn transcripts (not single-skill invocations)
- HARD-GATE assertion type: "agent stopped when gate condition unmet"
- Contract assertion type: "output contains file X that next command expects"

**TDD steps**:
1. Write test: `test/eval/command-grader.test.js` — mock transcript + assertions, verify grading output format
2. Run test: confirm fails
3. Implement: `.claude/agents/command-grader.md` with assertion evaluation instructions
4. Run test: confirm passes (format validation only — actual grading requires claude CLI)
5. Commit: `feat: add command-grader agent for behavioral eval`

**Expected output**: Agent file exists with grading instructions. Format test passes.

---

### Task 10: Eval set definitions for /status and /validate

**File(s)**: `eval/commands/status.eval.json`, `eval/commands/validate.eval.json` (new)

**What to implement**: Define eval sets for the two simplest commands:

`status.eval.json`:
```json
[
  {
    "scenario": "clean_repo_with_beads",
    "prompt": "/status",
    "assertions": ["shows current branch", "lists beads issues or says no issues", "shows recent commits"],
    "max_turns": 5
  }
]
```

`validate.eval.json`:
```json
[
  {
    "scenario": "all_passing",
    "prompt": "/validate",
    "assertions": ["runs tests", "reports test results", "checks lint"],
    "max_turns": 10
  },
  {
    "scenario": "failing_tests",
    "setup": "break a test file",
    "prompt": "/validate",
    "assertions": ["reports test failures", "does NOT declare all checks passed"],
    "max_turns": 10
  }
]
```

**TDD steps**:
1. Write test: `test/eval/eval-schema.test.js` — validate eval JSON files match expected schema
2. Run test: confirm fails (files don't exist)
3. Create eval JSON files
4. Run test: confirm passes
5. Commit: `feat: add eval definitions for /status and /validate commands`

**Expected output**: Valid eval JSON files with 3+ scenarios total.

---

### Task 11: Eval runner script

**File(s)**: `scripts/run-command-eval.js` (new)

**What to implement**: Script that:
1. Reads an eval JSON file
2. For each scenario: creates a disposable worktree (or uses `claude --worktree`)
3. Runs `claude -p "<prompt>" --output-format stream-json --no-session-persistence --max-turns N`
4. Strips `CLAUDECODE` env var for nested invocation
5. Captures full transcript
6. Passes transcript + assertions to command-grader agent
7. Collects grading results
8. Prints summary: X/Y assertions passed
9. Uses threading-based reader (not `select.select()`) for Windows compatibility
10. Cleans up worktrees on completion

**TDD steps**:
1. Write test: `test/eval/run-command-eval.test.js` — test transcript parsing logic (mock subprocess, don't actually run claude)
2. Run test: confirm fails
3. Implement: `scripts/run-command-eval.js`
4. Run test: confirm passes
5. Manual test: `node scripts/run-command-eval.js eval/commands/status.eval.json` (requires claude CLI)
6. Commit: `feat: add command eval runner with Windows-compatible streaming`

**Expected output**: Script runs, captures transcript, grades assertions, prints results.

---

### Task 12: Command improvement script (Scope C)

**File(s)**: `scripts/improve-command.js` (new)

**What to implement**: Adapted from skill-creator's `improve_description.py`:
1. Takes a command name and eval results (with failures)
2. Reads the canonical command file
3. Calls Claude API with extended thinking to analyze failures and propose a rewrite
4. Shows diff between current and proposed command
5. **User approval gate**: prints diff, asks for confirmation before writing
6. If approved: writes updated command, re-runs eval, shows before/after comparison
7. Logs full transcript to `.forge/eval-logs/` (gitignored)

**TDD steps**:
1. Write test: `test/eval/improve-command.test.js` — test diff generation and approval gate logic (mock API calls)
2. Run test: confirm fails
3. Implement: `scripts/improve-command.js`
4. Run test: confirm passes
5. Commit: `feat: add command improvement script with user approval gate`

**Expected output**: Script proposes command rewrite, shows diff, waits for approval.

---

## PR-C: Skill Optimization via Eval Loop (forge-1jx)

Ship order: **PARALLEL with PR-A** (no dependencies)

---

### Task 13: Skill eval set definitions

**File(s)**: `eval/skills/*.eval.json` (6 new files, one per skill)

**What to implement**: For each skill in `skills/`, create an eval JSON with:
- 3 should-trigger queries (realistic user prompts that should activate the skill)
- 2 should-not-trigger queries (prompts that are superficially similar but shouldn't trigger)

Skills: `parallel-web-search`, `parallel-deep-research`, `parallel-web-extract`, `parallel-data-enrichment`, `citation-standards`, `sonarcloud-analysis`

**TDD steps**:
1. Write test: `test/eval/skill-eval-schema.test.js` — validate all eval JSONs have correct format with both trigger types
2. Run test: confirm fails (files don't exist)
3. Create eval JSON files for all 6 skills
4. Run test: confirm passes
5. Commit: `feat: add eval definitions for all 6 skills`

**Expected output**: 6 eval JSON files, 30 total queries (5 per skill).

---

### Task 14: Skill eval runner (adapt skill-creator pattern)

**File(s)**: `scripts/run-skill-eval.js` (new)

**What to implement**: Adapted from skill-creator's `run_eval.py` but in JS for consistency:
1. Reads a skill eval JSON
2. For each query: runs `claude -p "<query>" --output-format stream-json --verbose --include-partial-messages --no-session-persistence --max-turns 1`
3. Detects if the Skill tool was invoked with the correct skill name
4. Early termination: if any non-Skill/Read tool called first → not triggered
5. Runs each query 3 times for reliability (threshold: ≥2/3 = triggered)
6. Reports trigger accuracy: true positives, false positives, true negatives, false negatives
7. Windows compatible (threading reader)

**TDD steps**:
1. Write test: `test/eval/run-skill-eval.test.js` — test trigger detection logic with mock stream-json events
2. Run test: confirm fails
3. Implement: `scripts/run-skill-eval.js`
4. Run test: confirm passes
5. Manual test: `node scripts/run-skill-eval.js eval/skills/parallel-web-search.eval.json`
6. Commit: `feat: add skill eval runner with trigger detection`

**Expected output**: Script reports trigger accuracy per skill.

---

### Task 15: Skill improvement loop with train/test split

**File(s)**: `scripts/improve-skill.js` (new)

**What to implement**: Adapted from skill-creator's `run_loop.py`:
1. Splits eval set 60/40 train/test (stratified by should_trigger)
2. Runs eval on full set
3. If train score < 100%: calls Claude API with extended thinking to propose new description
4. Re-runs eval with new description
5. Selects best by **test** score (not train) to prevent overfitting
6. Max 5 iterations
7. Before/after benchmark comparison
8. User approval gate before writing new description

**TDD steps**:
1. Write test: `test/eval/improve-skill.test.js` — test train/test split logic, best-selection logic (mock API)
2. Run test: confirm fails
3. Implement: `scripts/improve-skill.js`
4. Run test: confirm passes
5. Commit: `feat: add skill improvement loop with train/test split`

**Expected output**: Script iterates, selects best description, shows before/after comparison.

---

## Task Ordering

**Foundational first:**
1. Task 1 (dead refs) — extends existing test file
2. Task 2 (contracts) — new test file, no implementation
3. Task 3 (frontmatter parser) — utility for sync script
4. Task 4 (adapter transforms) — builds on Task 3

**Feature logic:**
5. Task 5 (sync CLI) — builds on Tasks 3-4
6. Task 6 (sync drift test) — integrates Task 5 into CI
7. Task 7 (agnix eval) — independent evaluation

**PR-A (continued):**
8. Task 8 (blast-radius /plan update)

**PR-B (after PR-A ships):**
9. Task 9 (grader agent)
10. Task 10 (eval definitions)
11. Task 11 (eval runner)
12. Task 12 (improvement script)

**PR-C (parallel):**
13. Task 13 (skill eval defs)
14. Task 14 (skill eval runner)
15. Task 15 (skill improvement loop)

---

## Notes

- Tasks 1-8 = PR-A (forge-jfw) — ship first
- Tasks 9-12 = PR-B (forge-agp) — ship after PR-A
- Tasks 13-15 = PR-C (forge-1jx) — ship in parallel with PR-A
- Baseline failures (5 chalk errors in skills package) are pre-existing and unrelated
- Task 7 (agnix) is exploratory — may be skipped if not useful
