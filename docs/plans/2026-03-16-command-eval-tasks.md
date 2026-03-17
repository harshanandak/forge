# Task List: Command Behavioral Eval + Improvement Loop

- **Design**: docs/plans/2026-03-16-command-eval-design.md
- **Branch**: feat/command-eval
- **Beads**: forge-agp

---

## Task 1: Eval set schema + loader

**File(s)**: `scripts/lib/eval-schema.js`, `test/eval/eval-schema.test.js`

**What to implement**: Define the eval set JSON schema and a loader/validator function. Schema supports three assertion types (standard, hard-gate, contract). Loader reads a `.eval.json` file, validates required fields, returns typed structure or throws with clear error message.

**Schema**:
```json
{
  "command": "/status",
  "description": "string",
  "queries": [
    {
      "name": "string (unique ID)",
      "prompt": "string",
      "setup": "string | null (bash commands to run before eval)",
      "teardown": "string | null (bash commands to run after eval)",
      "assertions": [
        { "type": "standard", "check": "string" },
        { "type": "hard-gate", "precondition": "string", "check": "string" },
        { "type": "contract", "producer": "string", "consumer": "string", "check": "string" }
      ]
    }
  ]
}
```

**TDD steps**:
1. Write test: `eval-schema.test.js` — valid eval set loads without error
2. Write test: missing `command` field → throws with "missing required field: command"
3. Write test: assertion with unknown `type` → throws with "unknown assertion type"
4. Write test: query with no `assertions` array → throws
5. Write test: duplicate query `name` within eval set → throws
6. Run tests: confirm all fail (RED)
7. Implement: `loadEvalSet(filePath)` → parsed and validated object
8. Run tests: confirm all pass (GREEN)
9. Commit: `test: add eval schema validation tests` then `feat: implement eval set loader`

**Expected output**: `loadEvalSet('eval/commands/status.eval.json')` returns validated object or throws descriptive error.

---

## Task 2: Stream-JSON transcript parser

**File(s)**: `scripts/lib/transcript-parser.js`, `test/eval/transcript-parser.test.js`

**What to implement**: Parse NDJSON output from `claude -p --output-format stream-json`. Extract: assistant text content, tool calls (name + input), final result. Return structured transcript object.

**TDD steps**:
1. Write test: valid NDJSON with assistant text → extracts text content
2. Write test: NDJSON with tool_use blocks → extracts tool name + input
3. Write test: NDJSON with `result` event → extracts final result
4. Write test: malformed line (not JSON) → skips line, logs warning, does not crash
5. Write test: empty input → returns empty transcript
6. Write test: mixed event types → extracts all in order
7. Run tests: confirm all fail (RED)
8. Implement: `parseTranscript(ndjsonString)` → `{ messages: [], toolCalls: [], result: {} }`
9. Run tests: confirm all pass (GREEN)
10. Commit: `test: add transcript parser tests` then `feat: implement stream-json transcript parser`

**Expected output**: `parseTranscript(rawOutput)` returns structured object with messages, tool calls, and result extracted.

---

## Task 3: Eval runner core — worktree + command execution

**File(s)**: `scripts/run-command-eval.js`, `test/eval/eval-runner.test.js`

**What to implement**: The main eval orchestrator. Creates a shared worktree, runs `claude -p` for each query in an eval set, resets between runs with `git checkout -- .`, collects raw transcripts, enforces timeout, destroys worktree in finally block.

**TDD steps**:
1. Write test: `createEvalWorktree()` → creates worktree, returns path, unique name includes timestamp
2. Write test: `destroyEvalWorktree(path)` → removes worktree even after error
3. Write test: `resetWorktree(path)` → runs `git checkout -- .`, cleans untracked files
4. Write test: `executeCommand(command, prompt, worktreePath, timeout)` → returns raw NDJSON string
5. Write test: command exceeds timeout → returns error result, not hung process
6. Write test: `CLAUDECODE` env var stripped from subprocess environment
7. Write test: `FORGE_EVAL=1` set in subprocess environment
8. Run tests: confirm all fail (RED)
9. Implement: worktree lifecycle + command execution with `Bun.spawn()`
10. Run tests: confirm all pass (GREEN)
11. Commit: `test: add eval runner core tests` then `feat: implement eval runner with worktree isolation`

**Expected output**: `runEval('eval/commands/status.eval.json')` creates worktree, executes queries, returns raw transcripts per query.

---

## Task 4: Grader agent definition

**File(s)**: `.claude/agents/command-grader.md`, `test/eval/grader-agent.test.js`

**What to implement**: LLM-based grader agent that receives a command transcript + assertion definitions and returns per-assertion pass/fail with reasoning. Agent file uses Claude Code agent frontmatter format.

**Agent responsibilities**:
- Receive: transcript text + assertion list
- For each assertion: determine pass/fail based on transcript evidence
- Standard: check if transcript content matches the assertion's `check` description
- HARD-GATE: check if agent stopped when precondition was unmet
- Contract: check if output contains artifact expected by downstream command
- Return: JSON with per-assertion `{ pass: boolean, reasoning: string }`

**TDD steps**:
1. Write test: grader agent file exists at `.claude/agents/command-grader.md`
2. Write test: agent file has valid frontmatter with `name` and `description`
3. Write test: agent system prompt mentions all three assertion types
4. Write test: agent system prompt includes JSON output format specification
5. Run tests: confirm all fail (RED)
6. Implement: write the agent `.md` file with system prompt
7. Run tests: confirm all pass (GREEN)
8. Commit: `test: add grader agent structure tests` then `feat: implement command grader agent`

**Expected output**: `.claude/agents/command-grader.md` exists with proper frontmatter and grading instructions.

---

## Task 5: Grading orchestrator — invoke grader + collect results

**File(s)**: `scripts/lib/grading.js`, `test/eval/grading.test.js`

**What to implement**: Orchestrator that takes a parsed transcript + assertions, invokes the grader agent (via `claude -p`), parses the grader's JSON response, computes per-query and overall scores. Handles grader failures gracefully.

**TDD steps**:
1. Write test: `gradeTranscript(transcript, assertions)` with mock grader response → returns scored assertions
2. Write test: grader returns valid JSON → each assertion has `pass`, `reasoning`
3. Write test: grader returns malformed JSON → error logged, assertions marked as `"error"`
4. Write test: overall score computation → count of passed / total assertions
5. Write test: empty assertions list → score is 1.0 (vacuous truth)
6. Run tests: confirm all fail (RED)
7. Implement: grading orchestrator with grader invocation
8. Run tests: confirm all pass (GREEN)
9. Commit: `test: add grading orchestrator tests` then `feat: implement grading orchestrator`

**Expected output**: `gradeTranscript(transcript, assertions)` returns `{ assertions: [...], score: 0.85 }`.

---

## Task 6: Eval result storage + history reader

**File(s)**: `scripts/lib/eval-storage.js`, `test/eval/eval-storage.test.js`

**What to implement**: Save eval results as timestamped JSON in `.forge/eval-logs/`. Read prior results for a command (cross-session context for improvement loop). Add `.forge/eval-logs/` to `.gitignore`.

**TDD steps**:
1. Write test: `saveEvalResult(result)` → creates `.forge/eval-logs/YYYY-MM-DD-HH-MM-<command>.json`
2. Write test: result file contains full eval data (command, queries, scores, timestamp)
3. Write test: `loadEvalHistory(command)` → returns array of prior results sorted by date
4. Write test: no prior results → returns empty array
5. Write test: `.forge/eval-logs/` directory created automatically if missing
6. Run tests: confirm all fail (RED)
7. Implement: storage functions + gitignore update
8. Run tests: confirm all pass (GREEN)
9. Commit: `test: add eval storage tests` then `feat: implement eval result storage`

**Expected output**: Eval results persist across sessions in `.forge/eval-logs/`.

---

## Task 7: Eval set definitions for /status and /validate

**File(s)**: `eval/commands/status.eval.json`, `eval/commands/validate.eval.json`, `test/eval/eval-sets.test.js`

**What to implement**: Write the actual eval query + assertion definitions for the two target commands. Each needs happy path, error path, and edge case scenarios.

**/status eval scenarios**:
- Happy path: clean repo → output shows beads stats, branch, recent commits
- In-progress work: issue exists in_progress → output shows progress data
- No beads: fresh repo with no issues → output handles gracefully

**/validate eval scenarios**:
- Happy path: all checks pass → output shows 4 green checks + stage transition
- Failing tests: test suite has failure → output reports failure, does NOT proceed
- HARD-GATE: missing fresh output → agent stops at gate (does not declare success)
- Contract: output contains `stage-transition validate ship` (consumed by /ship)

**TDD steps**:
1. Write test: `status.eval.json` loads without schema validation errors
2. Write test: `status.eval.json` has at least 3 queries
3. Write test: `validate.eval.json` loads without errors
4. Write test: `validate.eval.json` has at least one `hard-gate` assertion
5. Write test: `validate.eval.json` has at least one `contract` assertion
6. Write test: all query names are unique within each eval set
7. Run tests: confirm all fail (RED)
8. Implement: write both eval set JSON files
9. Run tests: confirm all pass (GREEN)
10. Commit: `test: add eval set validation tests` then `feat: add eval sets for /status and /validate`

**Expected output**: Two eval set files with comprehensive scenario coverage.

---

## Task 8: End-to-end eval pipeline — wire it all together

**File(s)**: `scripts/run-command-eval.js` (extend from Task 3), `test/eval/eval-pipeline.test.js`

**What to implement**: Wire the full pipeline: load eval set → create worktree → for each query: run setup → execute command → parse transcript → grade → run teardown → reset worktree → save results → destroy worktree. CLI interface: `bun run scripts/run-command-eval.js eval/commands/status.eval.json`.

**TDD steps**:
1. Write test: CLI accepts eval set path as argument
2. Write test: CLI validates eval set path exists before running
3. Write test: CLI outputs summary (pass/fail counts, overall score) to stdout
4. Write test: CLI exits 0 if score >= threshold, exits 1 if below
5. Write test: `--timeout` flag overrides default per-query timeout
6. Write test: `--threshold` flag sets pass/fail cutoff (default 0.7)
7. Run tests: confirm all fail (RED)
8. Implement: wire all modules together with CLI argument parsing
9. Run tests: confirm all pass (GREEN)
10. Commit: `test: add e2e eval pipeline tests` then `feat: wire end-to-end eval pipeline`

**Expected output**: `bun run scripts/run-command-eval.js eval/commands/status.eval.json` runs full eval and outputs scored report.

---

## Task 9: Improvement loop — analyze + rewrite + re-eval

**File(s)**: `scripts/improve-command.js`, `test/eval/improve-command.test.js`

**What to implement**: Semi-autonomous improvement loop. Reads eval results, identifies failing assertions, uses Claude to propose command rewrites, re-runs eval, pauses on regression/plateau. Stores iteration history. Presents diff for user approval.

**Behavior**:
- `--max-iterations N` (default 3)
- Each iteration: analyze failures → rewrite command .md → re-eval → compare score
- **Regression**: score dropped → rollback to best, STOP, print diff + regression details
- **Plateau**: same score 2x → STOP, print what's stuck
- **Improvement**: continue to next iteration
- At end: print diff (original → best) + per-assertion comparison
- Never auto-apply — user must confirm

**TDD steps**:
1. Write test: loads prior eval result and identifies failing assertions
2. Write test: generates rewrite prompt with failing assertion context
3. Write test: score improves → continues iteration
4. Write test: score regresses → rolls back to best version, stops
5. Write test: score plateaus (same 2x) → stops with explanation
6. Write test: `--max-iterations` respected (stops after N even if improving)
7. Write test: original command backed up before any rewrite
8. Write test: final output includes diff (original → best)
9. Run tests: confirm all fail (RED)
10. Implement: improvement loop with iteration tracking
11. Run tests: confirm all pass (GREEN)
12. Commit: `test: add improvement loop tests` then `feat: implement semi-autonomous improvement loop`

**Expected output**: `bun run scripts/improve-command.js .claude/commands/status.md --eval-set eval/commands/status.eval.json` runs improvement loop, presents diff.

---

## Task 10: Cross-session eval history + gitignore cleanup

**File(s)**: `scripts/improve-command.js` (extend), `.gitignore`, `test/eval/eval-history.test.js`

**What to implement**: When improvement loop starts, load all prior eval results for the target command from `.forge/eval-logs/`. Feed summary of historical failures to the rewrite prompt so the improver knows what was tried before and what regressed. Add `.forge/eval-logs/` to `.gitignore`.

**TDD steps**:
1. Write test: improvement loop reads prior eval history before first iteration
2. Write test: rewrite prompt includes summary of previously-tried changes (from history)
3. Write test: rewrite prompt includes which assertions have been historically flaky
4. Write test: `.gitignore` contains `.forge/eval-logs/`
5. Run tests: confirm all fail (RED)
6. Implement: history integration into improvement loop
7. Run tests: confirm all pass (GREEN)
8. Commit: `test: add cross-session eval history tests` then `feat: integrate eval history into improvement loop`

**Expected output**: Improvement loop is informed by past sessions — doesn't repeat failed approaches.

---

## Summary

| Task | Description | New Files | Tests |
|------|-------------|-----------|-------|
| 1 | Eval set schema + loader | `scripts/lib/eval-schema.js` | 5 |
| 2 | Stream-JSON transcript parser | `scripts/lib/transcript-parser.js` | 6 |
| 3 | Eval runner core (worktree + exec) | `scripts/run-command-eval.js` | 7 |
| 4 | Grader agent definition | `.claude/agents/command-grader.md` | 4 |
| 5 | Grading orchestrator | `scripts/lib/grading.js` | 5 |
| 6 | Eval result storage | `scripts/lib/eval-storage.js` | 5 |
| 7 | Eval set definitions | `eval/commands/*.eval.json` | 6 |
| 8 | End-to-end pipeline wiring | `scripts/run-command-eval.js` (extend) | 6 |
| 9 | Improvement loop | `scripts/improve-command.js` | 8 |
| 10 | Cross-session eval history | `scripts/improve-command.js` (extend), `.gitignore` | 4 |

**Total: 10 tasks, ~56 tests**

---

## Parallel Execution Plan

```
Wave 1 — no dependencies (run 4 subagents in parallel):
  ├── Task 1: Eval set schema + loader
  ├── Task 2: Stream-JSON transcript parser
  ├── Task 4: Grader agent definition
  └── Task 6: Eval result storage + history reader

Wave 2 — depends on Wave 1 (run 3 subagents in parallel):
  ├── Task 3: Eval runner core          ← needs Task 1 (schema) + Task 2 (parser)
  ├── Task 5: Grading orchestrator      ← needs Task 2 (parser) + Task 4 (grader)
  └── Task 7: Eval set definitions      ← needs Task 1 (schema for validation)

Wave 3 — integration (sequential):
  └── Task 8: E2E pipeline wiring       ← needs Tasks 3 + 5 + 6 + 7

Wave 4 — improvement loop (sequential):
  └── Task 9: Improvement loop          ← needs Task 8

Wave 5 — enhancement (sequential):
  └── Task 10: Cross-session history    ← needs Task 9
```

**Dependency graph**:
```
1 ──→ 3 ──→ 8 ──→ 9 ──→ 10
2 ──↗   ↗        ↑
2 ──→ 5 ────────↗
4 ──↗
6 ──────────────↗
1 ──→ 7 ───────↗
```

**Critical path**: 1 → 3 → 8 → 9 → 10 (5 steps instead of 10 sequential)
