# Design: Command Behavioral Eval + Improvement Loop

- **Slug**: command-eval
- **Date**: 2026-03-16
- **Status**: Draft
- **Branch**: feat/command-eval
- **Worktree**: .worktrees/command-eval
- **Beads**: forge-agp
- **Parent design**: docs/plans/2026-03-10-command-creator-and-eval-design.md (PR-B section)

---

## Purpose

Forge ships 11 slash commands (`.claude/commands/*.md`) with HARD-GATEs, cross-command contracts, and structured output expectations. Currently there is no way to verify that:
- Commands produce expected output sections (standard assertions)
- HARD-GATEs actually stop the agent when preconditions are unmet
- Command A's output feeds correctly into command B's input (contract assertions)
- Command modifications don't regress quality

**Goal**: Ship a behavioral eval runner + grader + semi-autonomous improvement loop for commands, starting with `/status` and `/validate`.

---

## Success Criteria

1. Grader agent evaluates command transcripts against three assertion types: standard, HARD-GATE, contract
2. Eval runner (`scripts/run-command-eval.js`) executes commands in a shared worktree with git reset between runs
3. At least 3 eval scenarios per target command (happy path, error path, edge case)
4. First targets: `/status` and `/validate`
5. Improvement loop (`scripts/improve-command.js`) runs up to N iterations, pauses on score regression or plateau
6. User approval gate before any command modification is applied
7. Eval results stored in `.forge/eval-logs/` for cross-session context
8. All scripts are JavaScript (Bun), consistent with existing codebase

---

## Out of Scope

- Evaluating commands on non-Claude-Code agents (Cursor, Cline, etc.)
- Creating new commands or modifying the 7-stage workflow
- Skill evaluation (separate PR-C, forge-1jx)
- Auto-applying improvements without user approval

---

## Approach Selected

### Language: JavaScript (Bun)

Chosen over Python adaptation of `eval_win.py` because:
- All existing scripts are JS (`sync-commands.js`, all tests in Bun)
- Frontmatter parser already exists in `sync-commands.js:26-81` (reusable)
- `Bun.spawn()` handles subprocess streaming natively on Windows
- Improvement loop needs to call `sync-commands.js` after rewrites — trivial in JS
- Test infrastructure (`bun test`) already established

### Three Assertion Types

**1. Standard assertions** — verify command output contains expected content.
```json
{ "type": "standard", "check": "output mentions active beads issues" }
```
Catches: missing output sections, incomplete runs, removed features.

**2. HARD-GATE assertions** — verify the agent stops when a precondition is unmet.
```json
{ "type": "hard-gate", "precondition": "no tests exist", "check": "agent stopped and reported failure, did NOT declare success" }
```
Catches: broken safety gates that silently let the agent proceed. Highest-value assertion type — workflow integrity depends on these.

**3. Contract assertions** — verify command A's output feeds command B's input.
```json
{ "type": "contract", "producer": "plan", "consumer": "dev", "check": "output contains task file path matching docs/plans/YYYY-MM-DD-*-tasks.md" }
```
Catches: pipeline breaks between stages (e.g., changing a file naming convention in /plan that /dev expects).

### Eval Execution Environment

**Shared worktree with git reset between runs** (option C):
- Create one worktree at eval start
- Run `git checkout -- .` + cleanup between eval queries (milliseconds vs seconds per worktree create)
- Set `FORGE_EVAL=1` env var so commands can detect eval mode
- Clean up beads artifacts created during eval in the reset step
- Destroy worktree at eval end

### Grader Agent

LLM-based grader (`.claude/agents/command-grader.md`) that receives:
- The command's eval transcript (stream-json output)
- The assertion definitions for that query
- Returns per-assertion pass/fail with reasoning

### Improvement Loop: Semi-Autonomous

Behavior:
1. Run eval → baseline score
2. Read prior eval logs from `.forge/eval-logs/` (cross-session context)
3. For iteration 1..N (default N=3):
   - Analyze failing assertions
   - Rewrite command `.md` using Claude with extended thinking
   - Re-run eval → new score
   - **If score dropped**: rollback to best version, STOP, show diff + regression details
   - **If plateaued** (same score 2x): STOP, show what's stuck
   - **If improved**: continue to next iteration
4. Present diff (original → best version) with per-assertion breakdown
5. Wait for user approval before applying

### Ambiguity Policy

**Pause and ask** — when the grader hits unclear situations (flaky assertions, unparseable stream-json), stop and ask the user for input. Do not guess.

---

## Constraints

- **Windows compatible**: All scripts must work in Git Bash on Windows (no `select.select()`)
- **No new dependencies**: Use Bun built-ins, `claude` CLI, `git`, `bd`
- **User approval gate**: Improvement loop NEVER auto-applies changes
- **Deterministic-first targets**: `/status` (simplest) then `/validate` (has HARD-GATEs)
- **Must strip `CLAUDECODE` env var** in subprocess to allow nested `claude -p` calls

---

## Edge Cases

1. **Flaky assertions**: LLM non-determinism means same command can produce different output across runs. Grader should flag inconsistency, pause for user input (per ambiguity policy).
2. **Worktree state leakage**: `bd create` during eval leaves real beads issues. Reset step must clean these up (delete issues created during eval, or use `FORGE_EVAL=1` to skip beads writes).
3. **Command timeout**: `claude -p` may hang. Eval runner must enforce a timeout per query (configurable, default 120s).
4. **Concurrent eval runs**: Two evals sharing the same worktree would corrupt each other. Eval runner must use a unique worktree name with timestamp/PID.
5. **Improvement regression spiral**: Score drops below original after rewrite. Rollback mechanism must restore exact original content (git stash or in-memory copy).
6. **Stream-json parse failure**: Unexpected format from `claude -p`. Eval runner should log raw output to `.forge/eval-logs/` and pause for user input.

---

## Architecture

```
scripts/run-command-eval.js          # Eval runner (orchestrator)
  ├── creates shared worktree
  ├── for each query in eval set:
  │     ├── claude -p "/command" --output-format stream-json
  │     ├── git checkout -- . (reset between runs)
  │     └── feeds transcript to grader agent
  ├── outputs JSON report → .forge/eval-logs/
  └── destroys worktree

scripts/improve-command.js           # Improvement loop
  ├── runs eval (baseline)
  ├── reads .forge/eval-logs/ (prior history)
  ├── iteration loop (max N):
  │     ├── analyzes failing assertions
  │     ├── rewrites command .md
  │     ├── re-runs eval
  │     └── pause-on-regression / plateau
  └── presents diff for user approval

.claude/agents/command-grader.md     # Grader agent (LLM-based)
  └── receives transcript + assertions → returns pass/fail per assertion

eval/commands/status.eval.json       # Eval set for /status
eval/commands/validate.eval.json     # Eval set for /validate

.forge/eval-logs/                    # Eval results (gitignored)
  └── YYYY-MM-DD-HH-MM-<command>.json
```

### Eval Set Schema

```json
{
  "command": "/status",
  "description": "Checks project state — beads issues, git branch, recent commits",
  "queries": [
    {
      "name": "happy_path_clean_repo",
      "prompt": "What's the current state of the project?",
      "setup": null,
      "assertions": [
        { "type": "standard", "check": "output lists active beads issues or states none exist" },
        { "type": "standard", "check": "output shows current git branch name" },
        { "type": "standard", "check": "output shows recent commit history" }
      ]
    },
    {
      "name": "in_progress_work",
      "prompt": "/status",
      "setup": "bd create --title=test-issue --type=task && bd update $ID --status=in_progress",
      "assertions": [
        { "type": "standard", "check": "output shows the in-progress issue" },
        { "type": "standard", "check": "output includes parse-progress data or task count" }
      ]
    }
  ]
}
```

### Eval Result Schema

```json
{
  "command": "/status",
  "timestamp": "2026-03-16T14:30:00Z",
  "worktree": ".worktrees/eval-status-1710595800",
  "results": [
    {
      "query": "happy_path_clean_repo",
      "assertions": [
        { "type": "standard", "check": "output lists active beads issues", "pass": true, "reasoning": "Output contained 'Ready work (3 issues)'" },
        { "type": "standard", "check": "output shows current git branch", "pass": true, "reasoning": "Output contained 'Branch: feat/command-eval'" }
      ],
      "score": 1.0
    }
  ],
  "overall_score": 0.85,
  "duration_ms": 45000
}
```

---

## OWASP Top 10 Analysis

| Category | Risk | Applies? | Mitigation |
|----------|------|----------|------------|
| A03 Injection | Eval queries or command names passed to shell | **Medium** | Validate command names against `[a-z-]+` regex; use `Bun.spawn()` array form (no shell interpolation) |
| A04 Insecure Design | Improvement loop proposes malicious content | Low | User approval gate; diff shown for review |
| A05 Misconfiguration | Eval worktree left behind on failure | Low | try/finally cleanup; unique worktree names |
| A08 Data Integrity | Eval results tampered between runs | Low | Git-backed storage; `.forge/eval-logs/` gitignored but timestamped |
| A09 Logging | Transcripts may contain env vars or secrets | **Medium** | Strip `CLAUDECODE` env var; warn if transcript contains patterns like `API_KEY=`, `token=` |

---

## TDD Test Scenarios

### Eval Runner (`scripts/run-command-eval.js`)
1. **Happy path**: Load eval set, run queries, produce scored JSON report
2. **Invalid eval set**: Missing required fields → clear error message
3. **Command timeout**: `claude -p` exceeds timeout → query marked as failed, not hung
4. **Worktree cleanup**: Even on error, worktree is destroyed (try/finally)
5. **NDJSON parsing**: Valid stream-json → correct tool call extraction
6. **Malformed stream-json**: Garbage line in output → logged, not crashed

### Grader Agent (`command-grader.md`)
7. **Standard pass**: Transcript contains expected content → assertion passes
8. **Standard fail**: Transcript missing expected content → assertion fails with reasoning
9. **HARD-GATE pass**: Agent stopped at gate → assertion passes
10. **HARD-GATE fail**: Agent sailed past gate → assertion fails
11. **Contract pass**: Output contains artifact matching consumer's expectation
12. **Contract fail**: Output missing or wrong format for downstream command

### Improvement Loop (`scripts/improve-command.js`)
13. **Score improves**: Rewrite bumps score → continues to next iteration
14. **Score regresses**: Rewrite drops score → rollback, stop, show diff
15. **Score plateaus**: Same score twice → stop, show what's stuck
16. **User approval**: Presents diff, does NOT auto-apply

---

## Sources

- Parent design doc: `docs/plans/2026-03-10-command-creator-and-eval-design.md`
- Skill eval reference: `scripts/eval_win.py` (250 lines, Windows-compatible)
- Eval set reference: `skills/parallel-deep-research/evals/evals.json`
- Frontmatter parser: `scripts/sync-commands.js:26-81`
- Claude CLI headless mode: `claude -p --output-format stream-json`
