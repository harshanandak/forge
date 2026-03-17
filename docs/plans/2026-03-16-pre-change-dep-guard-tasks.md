# Task List: pre-change-dep-guard

**Design doc**: docs/plans/2026-03-16-pre-change-dep-guard-design.md
**Beads**: forge-mze
**Branch**: feat/pre-change-dep-guard

---

## Task 1: Create `scripts/dep-guard.sh` scaffold with input sanitization

File(s): `scripts/dep-guard.sh`

What to implement: Create the shell script skeleton following the `beads-context.sh` pattern exactly. Include: `set -euo pipefail`, `usage()`, `die()`, `sanitize()` (copied from beads-context.sh), `bd_update()` wrapper, `bd_show_json()` helper (extracts JSON from `bd show <id> --json` with error checking), and the main case dispatcher routing to `cmd_find_consumers`, `cmd_check_ripple`, `cmd_store_contracts`, `cmd_extract_contracts`. Each `cmd_*` function starts as a stub that prints "Not implemented" and exits 1.

TDD steps:
1. Write test: `test/scripts/dep-guard.test.js` — test that script exists, is executable, prints usage on no args (exit 1), prints error on unknown subcommand (exit 1), and each stub subcommand prints "Not implemented"
2. Run test: confirm it fails (script doesn't exist yet)
3. Implement: create `scripts/dep-guard.sh` with scaffold
4. Run test: confirm it passes
5. Commit: `feat: add dep-guard.sh scaffold with input sanitization`

Expected output: `bash scripts/dep-guard.sh` prints usage; `bash scripts/dep-guard.sh check-ripple` prints "Not implemented"

---

## Task 2: Implement `find-consumers` subcommand

File(s): `scripts/dep-guard.sh`

What to implement: `cmd_find_consumers <function-or-pattern>` — takes a function/contract name as input, greps the codebase (`lib/`, `scripts/`, `.claude/commands/`, `bin/`, `.forge/hooks/`) for all files that reference it. Excludes: `node_modules/`, `.worktrees/`, `test/`, `test-env/`, the dep-guard script itself. Output format: one line per match as `<file>:<line>:<matching-text>`. Exit 0 if matches found, exit 0 with "No consumers found" if none, exit 1 on invalid input.

TDD steps:
1. Write test: in `test/scripts/dep-guard.test.js` — test with a known function name that exists in the codebase (e.g., `sanitize` which exists in beads-context.sh). Assert output contains at least one `scripts/beads-context.sh` line. Test with a nonexistent name, assert "No consumers found". Test with empty input, assert exit 1.
2. Run test: confirm it fails (stub returns "Not implemented")
3. Implement: `cmd_find_consumers` using `grep -rn` with `--include` and `--exclude-dir` flags
4. Run test: confirm it passes
5. Commit: `feat: implement find-consumers subcommand in dep-guard.sh`

Expected output: `bash scripts/dep-guard.sh find-consumers sanitize` returns lines like `scripts/beads-context.sh:40:sanitize() {`

---

## Task 3: Implement `check-ripple` subcommand (v1 — description-based)

File(s): `scripts/dep-guard.sh`

What to implement: `cmd_check_ripple <issue-id>` — the core v1 ripple check. Steps:
1. Validate issue exists via `bd show <id> --json`
2. Extract issue title + description
3. Run `bd list --status=open,in_progress` to get all active issues (exclude the given issue itself)
4. For each active issue: extract title, description, and any `contracts:` metadata from notes
5. Output a structured report: for each potentially overlapping issue, print the issue ID, title, overlap reason (keyword match or contract match), and confidence level
6. If no overlaps found, print "No conflicts detected" and exit 0
7. Keyword matching: tokenize both titles/descriptions, find shared meaningful terms (exclude stop words like "the", "and", "add", "fix", "update", "implement")

TDD steps:
1. Write test: mock `bd show` and `bd list` output (use temp files with known content). Test: (a) no overlaps returns "No conflicts detected", (b) two issues with overlapping keywords returns both in report, (c) nonexistent issue returns exit 1
2. Run test: confirm it fails
3. Implement: `cmd_check_ripple` with keyword tokenization and matching
4. Run test: confirm it passes
5. Commit: `feat: implement check-ripple v1 with keyword matching`

Expected output:
```
📋 Ripple check for forge-mze...

⚠️  Potential overlap with 1 issue:

  forge-9zv (open, P2): "Logic-level dependency detection in /plan Phase 3"
  Overlap: keyword match — "dependency", "plan", "Phase"
  Confidence: LOW (keyword only, no contract data)

  Options:
  (a) Add dependency: bd dep add forge-mze forge-9zv
  (b) Proceed — no real conflict
  (c) Investigate: bd show forge-9zv
```

---

## Task 4: Implement `store-contracts` subcommand

File(s): `scripts/dep-guard.sh`

What to implement: `cmd_store_contracts <issue-id> <contracts-string>` — stores contract metadata on a Beads issue. Format: `contracts: <file>:<function>(<change-type>), ...`. Uses `bd update <id> --append-notes` with the sanitized contracts string. Validates that the contracts string is non-empty and the issue exists. Reads existing notes first to avoid duplicate storage (if `contracts:` line already exists, replace it).

TDD steps:
1. Write test: test with a valid issue ID and contracts string — assert bd update is called correctly and output confirms storage. Test with empty contracts string — assert exit 1. Test with nonexistent issue — assert exit 1.
2. Run test: confirm it fails
3. Implement: `cmd_store_contracts`
4. Run test: confirm it passes
5. Commit: `feat: implement store-contracts subcommand in dep-guard.sh`

Expected output: `bash scripts/dep-guard.sh store-contracts forge-mze "beads-context.sh:parse-progress(modified)"` prints "Contracts stored on forge-mze"

---

## Task 5: Implement `extract-contracts` subcommand

File(s): `scripts/dep-guard.sh`

What to implement: `cmd_extract_contracts <task-file-path>` — parses a task list markdown file and extracts all `File(s):` entries and `What to implement:` descriptions. From the descriptions, extracts function/method names mentioned (pattern: word followed by `()` or word preceded by backtick). Outputs a structured contracts list: `<file>:<function>(modified)` for each unique function-file pair found. Exit 1 if file doesn't exist or has no tasks.

TDD steps:
1. Write test: create a temp task list file with known content (2 tasks, each with File(s) and What to implement containing function names). Assert output contains expected contracts. Test with nonexistent file — assert exit 1. Test with file containing no tasks — assert exit 1.
2. Run test: confirm it fails
3. Implement: `cmd_extract_contracts` using grep/sed to parse task format
4. Run test: confirm it passes
5. Commit: `feat: implement extract-contracts subcommand in dep-guard.sh`

Expected output: `bash scripts/dep-guard.sh extract-contracts docs/plans/2026-03-16-pre-change-dep-guard-tasks.md` prints contracts found in this task file

---

## Task 6: Integrate ripple check into `/plan` Phase 1

File(s): `.claude/commands/plan.md`

What to implement: Add a new step between the Entry HARD-GATE and Phase 1 Q&A. After worktree creation and before asking design questions, run: `bash scripts/dep-guard.sh check-ripple <beads-issue-id>` (if a Beads issue ID is provided or can be inferred from the feature slug). If no issue exists yet (first-time plan), run a lighter check: `bd list --status=open,in_progress` and display issue titles for manual review. The output is advisory — always proceed to Q&A regardless of ripple findings.

TDD steps:
1. Write test: in `test/commands/plan.test.js` — test that the plan command text includes the dep-guard check step. Verify the check-ripple call appears between HARD-GATE and Phase 1 Q&A.
2. Run test: confirm it fails
3. Implement: add the step to plan.md
4. Run test: confirm it passes
5. Commit: `feat: integrate dep-guard ripple check into /plan Phase 1`

Expected output: When running `/plan`, before questions begin, the agent displays any ripple warnings from open issues.

---

## Task 7: Integrate contract storage into `/plan` Phase 3

File(s): `.claude/commands/plan.md`

What to implement: After the task list is saved (Step 5) and before the HARD-GATE exit check, add two new steps:
1. `bash scripts/dep-guard.sh extract-contracts docs/plans/YYYY-MM-DD-<slug>-tasks.md` — extract contracts from the just-created task list
2. `bash scripts/dep-guard.sh store-contracts <issue-id> "<extracted-contracts>"` — store on the Beads issue
3. Re-run `bash scripts/dep-guard.sh check-ripple <issue-id>` — now with precise contract data, check for overlaps again
Add to the Phase 3 HARD-GATE: verify `dep-guard.sh store-contracts` ran successfully (exit code 0).

TDD steps:
1. Write test: verify plan.md includes the extract + store + re-check steps in Phase 3, and the HARD-GATE lists dep-guard as an exit condition
2. Run test: confirm it fails
3. Implement: add the steps to plan.md Phase 3
4. Run test: confirm it passes
5. Commit: `feat: integrate contract extraction and storage into /plan Phase 3`

Expected output: After task list creation, contracts are auto-extracted and stored on the Beads issue.

---

## Task 8: Ripple Analyst agent prompt

File(s): `.claude/commands/plan.md` (inline agent prompt)

What to implement: Define the Ripple Analyst agent prompt that gets invoked when `check-ripple` finds overlapping issues with contract data. The agent receives:
- The current issue's contract changes (from extract-contracts output)
- Consumer code snippets (from find-consumers output)
- The overlapping issue's title, description, and contract data
The agent must: (a) imagine 2-3 concrete break scenarios, (b) rate impact as NONE/LOW/HIGH/CRITICAL, (c) when uncertain default to HIGH, (d) recommend one of: add dependency, coordinate, scope down, or proceed. Output as structured text. Add the prompt as a section in plan.md that the agent reads and uses when spawning the Ripple Analyst subagent.

TDD steps:
1. Write test: verify plan.md contains the Ripple Analyst prompt section with required elements (break scenarios, impact levels, default-to-HIGH instruction, action recommendations)
2. Run test: confirm it fails
3. Implement: add the Ripple Analyst section to plan.md
4. Run test: confirm it passes
5. Commit: `feat: add Ripple Analyst agent prompt to /plan`

Expected output: When contract overlaps are found, the agent spawns a Ripple Analyst that returns a structured impact assessment.

---

## Task 9: Run command sync and verify all agents updated

File(s): (no new files — runs existing sync infrastructure)

What to implement: After all plan.md changes are complete, run `node scripts/sync-commands.js` to propagate the updated plan command to all agent directories. Verify with `node scripts/sync-commands.js --check` that no drift exists. Run the full test suite to confirm nothing broke.

TDD steps:
1. Run: `node scripts/sync-commands.js --dry-run` — verify plan.md changes would propagate
2. Run: `node scripts/sync-commands.js` — apply sync
3. Run: `node scripts/sync-commands.js --check` — verify no drift
4. Run: `bun test` — verify all tests pass
5. Commit: `chore: sync dep-guard plan changes across agents`

Expected output: All agent directories have updated plan.md, zero drift, all tests pass.
