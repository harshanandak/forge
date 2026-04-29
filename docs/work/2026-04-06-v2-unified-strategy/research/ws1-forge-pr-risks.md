# Forge PR Create Deep-Dive Risk Analysis

**Status**: Analysis of proposed `forge pr create` flow integrating forge-issues system  
**Date**: 2026-04-06  
**Scope**: All 7 steps of PR creation + crosscutting failure modes  
**Total Failure Modes Analyzed**: 69 distinct scenarios

---

## Executive Summary

The proposed `forge pr create` flow introduces 7 sequential integration points, each with failure modes that can result in:
- **Silent partial failures** (PR created, link-back fails)
- **State inconsistencies** (issue marked done, PR still draft)
- **Race conditions** (parallel worktrees, CI overwrites)
- **CI/non-MCP blindness** (local-only SQLite, no ephemeral environment support)

**Critical insight**: The current /ship command is robust because it's self-contained (just `gh pr create` + template). The new flow distributes concerns across 7 steps—each adds coupling and failure surfaces.

---

## Step 1: Read .forge/progress.md

**Purpose**: Populate PR body with accumulated notes from /plan and /dev stages.

### Failure Modes

| Failure | Impact | Likelihood | Trigger |
|---------|--------|-----------|---------|
| File doesn't exist | PR body empty/minimal; lose context | High | First run, agent skipped writing, race during cleanup |
| File is stale | Wrong context in PR (old feature notes) | Medium | User paused work, took break, agent didn't update |
| File is malformed | Parse error, corrupted markdown | Low | Crash during agent write, truncation |
| File too large (5MB+) | Buffer overflow, timeout reading | Low | Agent accumulated months of verbose notes |
| Sensitive data in file | Credentials leaked in PR description | Medium | Agent cached API keys, internal IPs, PII |
| Multiple progress files | Which one is current? race condition | High | Parallel worktrees, .forge not `.git/forge` (not protected) |
| Concurrent writes | Agent A reads stale state while B writes | Medium | Tight /plan→/dev→/ship loop with parallelism |

### Recommended Controls

- **Atomic writes**: Use `.forge/progress.md.tmp` + `mv` (atomic on POSIX)
- **Versioning**: `.forge/progress.md.1.bak` keeps last version for recovery
- **Size limit**: Reject > 1MB, suggest archiving to `docs/research/` instead
- **Content filtering**: Regex scan for AWS_SECRET_KEY, OPENAI_API_KEY, etc.
- **Worktree isolation**: Store in `.git/forge/progress-<branch>.md` (locked in .git/)
- **Stale detection**: Compare file mtime to git branch mtime; warn if > 1 hour old

---

## Step 2: Read forge-issues SQLite (.git/forge/state.db)

**Purpose**: Fetch linked issues, dependency graph, and current PR state.

### Key Risks

- **Concurrency**: SQLite locked by parallel agents (timeout, PR blocked)
- **Corruption**: Power loss, OOM kill leaves DB unusable (recovery via events.jsonl)
- **Non-existent DB**: New repos, CI environments have no state.db
- **MCP dependency**: No fallback if forge-issues server down
- **WAL orphans**: Stale .git/forge/state.db-wal from crashed process

### Recommended Controls

- Enable WAL mode by default; `PRAGMA busy_timeout=5000` for 5-sec lock wait
- Build fallback: if state.db unreadable, rebuild from append-only events.jsonl
- Detect CI environment; use read-only mode if running in GitHub Actions
- Healthcheck MCP server before attempting reads
- Create `forge issues rebuild` command for corruption recovery

---

## Step 3: Auto-Generate "Closes #X" from Dependency Graph

**Purpose**: Link PR to GitHub issues via `Closes #42, #43` syntax.

### Key Risks

- **Issue not synced**: Local forge IDs used; GitHub doesn't recognize
- **Monorepo confusion**: Issue in different upstream repo
- **Stale state.db**: Partial sync; some issues unsynced
- **Branch-issue mismatch**: forge-xyz branch, issue #99 (wrong link)
- **Already closed**: "Closes #42" but issue closed yesterday

### Recommended Controls

- Validate GitHub issue IDs assigned in state.db before generating "Closes"
- Query issue state before PR creation; skip closed issues
- For forks, verify issue exists on upstream
- Fallback: if sync incomplete, create PR without "Closes" lines + warn user

---

## Step 4: Add forge Labels (type, priority) to PR

**Purpose**: Auto-tag PR with forge metadata (bug, feature, urgent).

### Key Risks

- **Missing labels**: Labels not pre-created on GitHub repo
- **Permission denied**: User lacks write access to labels
- **Naming conflicts**: forge/type:bug vs existing type:bug scheme
- **Inference errors**: Type/priority guessed wrong from schema

### Recommended Controls

- Pre-flight check: verify labels exist before PR creation
- Fail-open: if labeling fails, PR still created but unlabeled
- Define canonical labels in `.forge/labels.json`; auto-create on first run
- Use idempotent `gh pr edit` if PR already exists with wrong labels

---

## Step 5: Run `forge evaluate --quick` Before Creating PR

**Purpose**: Validate code quality; gate PR on score (unclear if soft or hard).

### Key Risks

- **Blocker ambiguity**: No threshold defined; should low score block PR or warn?
- **Evaluator timeout**: Hangs indefinitely; PR creation blocked
- **MCP dependency**: Server down, token limit hit, evaluator unavailable
- **Stale cache**: Analysis from pre-rebase state; code changed since
- **Token cost**: 5-10 sec, 1000+ tokens per evaluation (expensive at scale)

### Recommended Controls

- **Decouple from critical path**: Run evaluation *after* PR creation (background)
- Timeout guard: `timeout 30s forge evaluate --quick`
- Define threshold: `EVALUATE_THRESHOLD=0.7`; warn if below, allow override
- Cache results in state.db; skip if code unchanged
- Fallback: if evaluator unavailable, proceed with warning (don't block)

---

## Step 6: Link Back: Update forge-issues with PR URL

**Purpose**: Write PR URL to state.db and GitHub issue metadata.

### Key Risks

- **GitHub API failure**: PR created but issue not updated (silent orphan)
- **SQLite locked**: Concurrent write from another agent; UPDATE fails
- **Stale PR reference**: Force-push after PR creation (link-back points to old PR)
- **PR in draft but issue marked done**: Mismatch in states
- **PR deleted after link-back**: Issue still points to deleted PR

### Recommended Controls

- Idempotent link-back: store PR URL in both state.db and issue body
- Synchronous write: don't queue; write immediately before returning URL
- Retry backoff: if GitHub API fails, retry 3x with 1s, 2s, 4s delays
- Verify: after link-back, HEAD 200 on PR URL before claiming success
- Orphan recovery: `forge issues verify` command to detect stale references

---

## Step 7: Return PR URL to Agent

**Purpose**: Give user/agent the PR URL for next steps.

### Key Risks

- **Misleading success**: PR created, link-back failed (partial failure hidden)
- **Draft vs ready ambiguity**: No --draft flag; defaults to ready (should low eval score → draft?)
- **Wrong base branch**: PR created against develop, not main
- **URL parsing failed**: Regex missed GitHub response format change
- **Timeout**: PR created but URL never returned to caller

### Recommended Controls

- Explicit return: `{ success, prUrl, prNumber, partialFailures: [...] }`
- Define success: PR created on GitHub (not "link-back succeeded")
- Draft logic: if eval_score < 0.7: create --draft; else ready
- Robust parsing: `gh pr view --json url` instead of regex
- Long timeout for link-back retries; separate from URL return

---

## Crosscutting Failure Modes

### CI / Non-MCP Environments

Detect CI env and use read-only mode. Store state.db in .git/forge/. Fallback to minimal PR body if progress.md missing.

### Second Call (Idempotency)

Idempotency check: `gh pr list --head <branch>` before step 5. Return existing PR if found. Parse GitHub 422 → PR exists.

### Draft vs Ready Decision

Decision tree: eval_score < 0.7 → --draft flag. Warn user: "Score 0.6 (low). Creating as DRAFT."

### Force-Push and Re-Create

Detect force-push; warn user. Track PR history in state.db (versioning). Mark old PRs as superseded.

### Agent-Specific Differences (6 Agents)

| Agent | State Model | Link-Back Support |
|-------|------------|---|
| Claude | Beads DB (.claude/commands) | YES (persistent state) |
| Cline | File-based (.cline/workflows) | NO (no state across sessions) |
| Cursor | File-based (.cursor/commands) | NO |
| Codex | Skill state (.codex/skills) | UNCLEAR |
| KiloCode | File-based (.kilocode/workflows) | NO |
| OpenCode | File-based (.opencode/commands) | NO |

**Critical decision**: Is link-back Claude-only? Or must all agents sync to shared state.db?

---

## Recommended Implementation Strategy

### Phase 1: Decouple Evaluation from Critical Path
- Run evaluation *after* PR creation (background process)
- PR defaults to ready; evaluation score updates post-hoc
- Evaluation is advisory (GitHub check), not gate

### Phase 2: Explicit Idempotency
```bash
if gh pr list --head <branch> --json number | grep -q .; then
  echo "PR already exists: $(gh pr view --head <branch> --json url)"
  exit 0
fi
```

### Phase 3: Fallback-First for Each Step
1. Try primary (e.g., read state.db)
2. If fails, fall back gracefully (e.g., empty issue list)
3. Create PR with available data; don't block on auxiliary data
4. Log skipped steps; user runs `forge issues verify` to fix later

### Phase 4: State Verification Sweep
```bash
forge issues verify <issue-id>
# Checks: PR exists, URL correct, issue consistent, no orphans
```

### Phase 5: Agent-Specific Implementation Matrix
- Steps 1-4: All agents (progress.md, state.db, Closes, labels)
- Steps 6-7: Claude only (link-back requires persistent state)
- Other agents: PR created, warning printed "Link-back not supported"

---

## Test Scenarios (Pre-Ship Validation)

### Must-Pass (10 scenarios)
1. Happy path: all steps succeed, PR with full metadata
2. Missing progress.md: PR created, minimal body (no crash)
3. SQLite locked: timeout, clear error, no partial state
4. Issue not synced: PR created without "Closes", warning shown
5. Second call: idempotent, returns existing PR URL
6. Fork PR: link-back skipped gracefully, PR still created
7. CI environment: read-only mode, no state.db required
8. Evaluator timeout: PR created anyway, evaluation optional
9. GitHub API 422: detected, existing PR returned
10. Force-push: user warned, old PR marked stale

### Must-Fail (4 hard gates)
1. No git remote: exit before push
2. No GitHub token: exit before gh pr create
3. Not on feature branch: branch = main/master → error
4. /validate not run: missing validation output → error

---

## Summary: Risk Topology

**High-Risk Steps** (most likely to fail):
- Step 2: SQLite concurrency/corruption
- Step 3: Issue not synced to GitHub
- Step 5: Evaluator timeout or MCP server down
- Step 6: GitHub API transient error during link-back

**High-Impact Failures**:
- Partial success (PR created, link-back fails) → silent issue orphaning
- Duplicate PR creation → audit confusion
- Draft vs ready mismatch → PR merged unintentionally

**Cross-Cutting Risks**:
- CI environments have no state.db → link-back impossible
- Parallel worktrees + shared state.db → race conditions
- 6 agents with different state models → inconsistent behavior

**Recommendation**: Make steps 1-4 robust and self-contained. Push steps 6-7 (link-back) into optional stage for Claude only. This reduces critical path and enables composition.
