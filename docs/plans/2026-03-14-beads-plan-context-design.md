# Design Doc: beads-plan-context

**Feature**: beads-plan-context
**Date**: 2026-03-14
**Status**: Phase 3 complete — ready for /dev
**Branch**: feat/beads-plan-context
**Beads**: forge-bmy (open)

---

## Purpose

When resuming work across sessions, agents must read the Beads issue AND separately find/read the design doc AND have no visibility into task progress. This feature embeds plan context directly in Beads fields so that `bd show <id>` returns enough context to resume without hunting for files.

**Who benefits**: Any agent (Claude Code, Cursor, Cline, Copilot, etc.) resuming a multi-session feature.

---

## Success Criteria

1. `/plan` Phase 3 auto-runs `scripts/beads-context.sh set-design` after task list creation — populates `--design` with task count + file path
2. `/plan` Phase 3 auto-runs `scripts/beads-context.sh set-acceptance` — populates `--acceptance` with success criteria from design doc
3. `/dev` Step E auto-runs `scripts/beads-context.sh update-progress` after each task completion — appends progress line to `--notes`
4. `/status` calls `scripts/beads-context.sh parse-progress` to show compact progress (e.g., "3/7 tasks done | Last: Validation logic (def5678)") with a hint to run `bd show <id>` for details
5. `scripts/beads-context.sh` exists, is agent-agnostic (plain bash), and handles formatting + error checking
6. `bd update` failure in `/dev` Step E is a HARD-GATE — blocks progression to next task
7. All existing tests pass after changes
8. Command sync (`scripts/sync-commands.js`) still works — no adapter changes needed (body-only modifications)
9. Stage transitions are recorded via `scripts/beads-context.sh stage-transition` using `--comment` at each stage exit — enables agents to determine current workflow stage on resume

---

## Out of Scope

1. **Modifying Beads itself** — we consume existing `bd update` commands, not change the tool
2. **Changing design doc file format** — `docs/plans/` structure stays the same
3. **Retroactively updating old issues** — pre-existing issues won't have design/notes populated
4. **Modifying `scripts/sync-commands.js` or adapter pipeline** — command body changes sync automatically
5. **Agent-specific adapter files** — only canonical `.claude/commands/` files are edited

---

## Approach Selected: Helper script + inline skill updates

**Why a helper script (`scripts/beads-context.sh`)**:
- Forge supports 8+ agents. Each reads the same command body (via sync pipeline). But natural language formatting instructions can be interpreted differently by different LLMs.
- A shell script enforces a single, consistent format for Beads field content — any agent just calls the script with structured args.
- Parsing logic (for `/status`) lives in one place — not duplicated across agent configs.
- Error handling (exit code checking for HARD-GATE) is centralized.

**Why not inline-only (Approach 1)**: Format consistency across agents is not guaranteed when relying on natural language instructions alone.

**Why not convention doc (Approach 3)**: A convention doc can drift from implementation. The script IS the convention — self-documenting and self-enforcing.

---

## Constraints

- `bd update --design` and `--append-notes` are existing Beads fields — no new fields needed
- The script must work on Windows (Git Bash), macOS, and Linux
- Content in `--design` should be a summary + file path (not the full task list) to avoid duplication
- Content in `--append-notes` should be medium granularity: task title + test count + commit SHA + decision gate count
- `bd update` failure is a HARD-GATE in `/dev` Step E — blocks next task

---

## Edge Cases

1. **`bd update` fails** (locked DB, invalid ID, disk error): HARD-GATE — stop and surface the error. Do not proceed to next task.
2. **Task title contains special characters** (quotes, newlines): Script must sanitize before passing to `bd update`.
3. **Old issues without design/notes fields**: `/status` shows "No progress data" — no crash, no backfill.
4. **Issue ID not found** (typo, wrong worktree): Script validates exit code and shows clear error.
5. **Multiple agents working on same issue**: Each agent's `--append-notes` appends — no conflict (Beads appends are additive).

---

## Ambiguity Policy

**(B) Pause and ask.** If a spec gap is found mid-dev, the agent stops and asks the user before proceeding.

---

## Decisions Log

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | What Beads fields to use? | `--design` (plan summary), `--acceptance` (success criteria), `--append-notes` (task progress) | These exist today — no Beads modifications needed |
| 2 | Content limits | Summary + file path in `--design`, not full task list | Avoids duplication, lighter, single source of truth stays in the file |
| 3 | Progress granularity | Medium: title + test count + commit + decision gates | Enough to resume, no duplication of review results |
| 4 | `/status` display | Compact summary + `bd show` hint | Preserves `/status` as fast scan, scales to parallel features |
| 5 | `bd update` failure handling | HARD-GATE — blocks next task | User wants strict enforcement |
| 6 | Ambiguity policy | Pause and ask | User preference for control over speed |
| 7 | Agent-agnostic approach | Helper script (`scripts/beads-context.sh`) | Shell script callable from any agent, enforces consistent format |
| 8 | Stage tracking | `--comment` with standardized format at stage exits | Enables agents to determine current workflow stage on resume |

---

## Script Interface

```bash
# Set design summary in Beads (called from /plan Phase 3)
bash scripts/beads-context.sh set-design <issue-id> <task-count> <task-file-path>
# → bd update <id> --design "N tasks | <task-file-path>"

# Set acceptance criteria (called from /plan Phase 3)
bash scripts/beads-context.sh set-acceptance <issue-id> "<criteria-text>"
# → bd update <id> --acceptance "<criteria-text>"

# Append task progress (called from /dev Step E)
bash scripts/beads-context.sh update-progress <issue-id> <task-num> <total> "<title>" <commit-sha> <test-count> <gate-count>
# → bd update <id> --append-notes "Task N/M done: <title> | <test-count> tests | <commit-sha> | <gate-count> gates"

# Parse progress for /status display
bash scripts/beads-context.sh parse-progress <issue-id>
# → "3/7 tasks done | Last: <title> (<commit-sha>)"

# Record stage transition (called at each stage exit)
bash scripts/beads-context.sh stage-transition <issue-id> <completed-stage> <next-stage>
# → bd update <id> --comment "Stage: <completed-stage> complete → ready for <next-stage>"
```

---

## Technical Research

### Beads Field Verification (2026-03-14)

Verified against Beads v0.49.1:

| Flag | Works? | Behavior | Persists in JSONL? |
|------|--------|----------|-------------------|
| `--design "text"` | Yes | Overwrites | Yes — `DESIGN` section in `bd show` |
| `--acceptance "text"` | Yes | Overwrites | Yes — `ACCEPTANCE CRITERIA` section |
| `--append-notes "text"` | Yes | Appends with `\n` separator | Yes — `NOTES` section |
| `--notes "text"` | Yes | Overwrites all notes | Yes |
| `--design ""` | Yes | Clears the field | Yes |

No character/length limits documented. Real-world issues have multi-paragraph notes with no truncation.

### DRY Check

No existing Beads field population infrastructure exists in the codebase:
- No scripts format or parse Beads fields
- No progress tracking via `--append-notes` in any command
- `/status` uses only `bd list` — no field inspection
- This is greenfield work — no duplication risk

### OWASP Top 10 Analysis

| Category | Applies? | Mitigation |
|----------|----------|------------|
| A03: Injection | Yes — task titles passed as shell args to `bd update` | Script quotes all variables, sanitizes special chars |
| A01-A02, A04-A10 | No | No auth, network, data exposure, or crypto |

### TDD Test Scenarios

1. **Happy path — update-progress**: Run with valid args → exit 0, `bd show` contains formatted line
2. **Error path — invalid ID**: Run with bad issue ID → exit non-zero, clear error message
3. **Edge case — special characters**: Task title with quotes → properly escaped, no injection
4. **Edge case — parse empty notes**: `parse-progress` when no notes → "No progress data"
5. **Happy path — set-design + set-acceptance**: Both populate, `bd show` displays correctly
6. **Happy path — stage-transition**: Records comment with standardized format, `bd show` displays it

### Codebase Integration Points

| File | Current Beads usage | Change needed |
|------|-------------------|---------------|
| `.claude/commands/plan.md` L196-197 | `bd create` + `bd update --status` | Add `beads-context.sh set-design` + `set-acceptance` after task list |
| `.claude/commands/dev.md` L251 | `bd update --comment` at completion | Add `beads-context.sh update-progress` in Step E HARD-GATE |
| `.claude/commands/status.md` L28-30 | `bd list --status in_progress` | Add `beads-context.sh parse-progress` for compact display |
| `scripts/` | No Beads scripts | New `beads-context.sh` |
