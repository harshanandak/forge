# Team Orchestration — Task List

- **Feature**: team-orchestration
- **Date**: 2026-03-27
- **Beads**: forge-wzpb
- **Design doc**: [2026-03-27-team-orchestration-design.md](2026-03-27-team-orchestration-design.md)

---

## Parallel Wave Structure

```
Wave 1 (foundational — no dependencies):
  Task 1: Agent prompt convention library
  Task 2: Identity mapping (GitHub-username-only)
  Task 3: forge team CLI dispatcher + routing

Wave 2 (depends on Wave 1):
  Task 4: GitHub sync engine — issue create/claim/status/close
  Task 5: Claim locking with pre-claim check

Wave 3 (depends on Wave 2):
  Task 6: Workload view (forge team workload)
  Task 7: Epic rollup view (forge team epic)
  Task 8: Team dashboard (forge team dashboard)

Wave 4 (depends on Waves 2-3):
  Task 9: Hook-based sync (pre-push + stage transitions)
  Task 10: 1:1 enforcement + orphan detection (forge team verify)

Wave 5 (integration):
  Task 11: Workflow integration (/status, /plan, /ship extensions)
  Task 12: Integration tests + edge case coverage
```

---

## Wave 1: Foundational (no dependencies)

### Task 1: Agent prompt convention library

**File(s)**: `scripts/forge-team/lib/agent-prompt.sh` (new)

**What to implement**: Shared library for structured agent communication. All user-facing output from `forge team` goes through these helpers. Uses non-guessable prefix `FORGE_AGENT_7f3a:` to prevent AGENT_PROMPT injection from GitHub issue titles.

Functions:
- `agent_prompt()` — Output a prompt for the AI agent to ask the user. Format: `FORGE_AGENT_7f3a:PROMPT: <message>` to stderr.
- `agent_info()` — Informational output. Format: `FORGE_AGENT_7f3a:INFO: <message>` to stderr.
- `agent_error()` — Error output. Format: `FORGE_AGENT_7f3a:ERROR: <message>` to stderr.
- `sanitize_for_agent()` — Strip any occurrence of the `FORGE_AGENT_7f3a:` prefix from input strings (prevents injection from GitHub data).

**TDD steps**:
1. Write test: `scripts/forge-team/tests/agent-prompt.test.sh` — test each function outputs correct prefix to stderr. Test `sanitize_for_agent()` strips the prefix from malicious input. Test that normal text passes through unchanged.
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/agent-prompt.sh`
4. Run test: confirm passes
5. Commit: `feat: add agent prompt convention library with injection protection`

**Expected output**: All agent prompt tests pass. Prefix is non-guessable. Injection stripped.

---

### Task 2: Identity mapping (GitHub-username-only)

**File(s)**: `scripts/forge-team/lib/identity.sh` (new)

**What to implement**: GitHub-username-only identity mapping. Auto-detects via `gh api user --jq .login`. Stores in `.beads/team-map.jsonl` (append-only, LWW per GitHub username).

Functions:
- `get_github_user()` — Returns current developer's GitHub username via `gh api user --jq .login`. Caches result for session. If `gh` not authenticated, outputs `FORGE_AGENT_7f3a:PROMPT:` and returns 1.
- `team_map_add()` — Adds/updates entry in `.beads/team-map.jsonl`. Uses `atomic_jsonl_append()` from `lib/jsonl-lock.sh`. Schema: `{"github":"<user>","display_name":"<name>","updated_at":"<ts>","is_bot":false}`.
- `team_map_read()` — Reads all entries with LWW resolution (same pattern as `file_index_read()`). Returns JSON array.
- `team_map_get()` — Gets single entry by GitHub username.
- `is_bot()` — Returns 0 if username matches `*[bot]` pattern.
- `auto_detect_identity()` — Runs `get_github_user()`, checks if already in team-map, adds if missing. Silent on success.

Validation: GitHub usernames must match `^[a-zA-Z0-9-]+$` (reuse `sanitize.sh` patterns).

**TDD steps**:
1. Write test: `scripts/forge-team/tests/identity.test.sh` — test auto-detect with mock `gh` (GH_CMD override). Test bot detection. Test JSONL entry creation. Test LWW resolution. Test injection rejection. Test `gh` not authenticated → agent prompt.
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/identity.sh`
4. Run test: confirm passes
5. Commit: `feat: GitHub-username-only identity mapping with auto-detection`

**Expected output**: Identity auto-detected silently when `gh` authenticated. JSONL entry persisted. Bot accounts detected.

---

### Task 3: forge team CLI dispatcher + routing

**File(s)**: `scripts/forge-team/index.sh` (new), `lib/commands/team.js` (new), `bin/forge.js` (extend)

**What to implement**: Entry point for `forge team <subcommand>` with dispatcher routing.

`scripts/forge-team/index.sh`:
- Sources `lib/agent-prompt.sh`, `lib/identity.sh`
- Dispatcher: `workload`, `epic`, `dashboard`, `add`, `verify`, `sync`, `help`
- Stub functions for each (filled in later tasks)
- Input validation on all subcommands
- Exit codes: 0=success, 1=error, 2=validation error

`lib/commands/team.js`:
- Node.js wrapper that calls `scripts/forge-team/index.sh` via `execFileSync`
- Passes subcommand and flags through

`bin/forge.js`:
- Add `else if (command === 'team')` routing to the existing dispatcher

**TDD steps**:
1. Write test: `scripts/forge-team/tests/dispatcher.test.sh` — test routing to each subcommand. Test unknown subcommand exits 1. Test `help` prints usage. Test `forge team` with no args shows help.
2. Write test: `test/commands/team.test.js` — test `forge team help` via the JS dispatcher. Test routing.
3. Run tests: confirm fails
4. Implement: Create all three files
5. Run tests: confirm passes
6. Commit: `feat: forge team CLI dispatcher with subcommand routing`

**Expected output**: `forge team help` prints usage. All subcommands reachable. Unknown commands rejected.

---

## Wave 2: Core Sync (depends on Wave 1)

### Task 4: GitHub sync engine — issue create/claim/status/close

**File(s)**: `scripts/forge-team/lib/sync-github.sh` (new)

**What to implement**: Bidirectional sync between Beads and GitHub for issue lifecycle events. Extends forge-d2cl patterns.

Functions:
- `sync_issue_create()` — Given a Beads issue ID, creates a GitHub issue via `gh issue create`. Stores GitHub issue number via `bd set-state <id> github_issue=<N>`. Updates `.github/beads-mapping.json`.
- `sync_issue_claim()` — Given a Beads issue ID, updates GitHub assignee via `gh issue edit <N> --add-assignee <github-user>`.
- `sync_issue_status()` — Given a Beads issue ID and status, updates GitHub labels: adds `status/<status>`, removes old status labels.
- `sync_issue_close()` — Given a Beads issue ID, closes the linked GitHub issue via `gh issue close <N>`.
- `sync_issue_deps()` — Given a dependency (A depends on B), adds comment on GitHub issue A: "Blocked by #N".
- `sync_pull()` — Batch pull: query GitHub issues via GraphQL, update local Beads state for any changes (assignee, status, closed).
- `_gh_graphql_issues()` — Helper: fetch all open issues via single GraphQL query (batch, not per-issue REST).

All GitHub-sourced strings sanitized via `sanitize_for_agent()` before use in shell commands or JSONL.

**TDD steps**:
1. Write test: `scripts/forge-team/tests/sync-github.test.sh` — test each sync function with mock `gh` (GH_CMD override) and mock `bd` (BD_CMD override). Test create → GitHub issue created. Test claim → assignee updated. Test status → labels added/removed. Test close → issue closed. Test injection in issue title sanitized.
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/sync-github.sh`
4. Run test: confirm passes
5. Commit: `feat: GitHub sync engine for issue create/claim/status/close/deps`

**Expected output**: All sync functions work with mocks. GitHub API calls use correct arguments. Injection sanitized.

---

### Task 5: Claim locking with pre-claim check

**File(s)**: `scripts/forge-team/lib/sync-github.sh` (extend)

**What to implement**: Before allowing `bd update --claim`, check GitHub assignee and use flock to prevent race conditions.

Functions:
- `pre_claim_check()` — Queries GitHub issue assignee. If already assigned to someone else, outputs `FORGE_AGENT_7f3a:PROMPT: forge-abc is claimed by <user> (<time> ago). Override? Run: forge team claim <id> --force`. Returns 1.
- `claim_with_lock()` — Wraps the check-then-claim in `flock` advisory lock (`.beads/claim.lock`). Inside lock: re-check GitHub assignee → if clear, claim on both Beads and GitHub → release lock.
- `forge_team_claim()` — Top-level: runs `pre_claim_check()`, if clear runs `claim_with_lock()`. `--force` flag skips the check (logs override via `bd comments add`).

**TDD steps**:
1. Write test: test pre-claim on unassigned issue → proceeds. Test pre-claim on assigned issue → agent prompt. Test `--force` overrides. Test flock prevents concurrent claims (two parallel calls, one succeeds, one gets lock warning).
2. Run test: confirm fails
3. Implement: Extend `sync-github.sh` with claim functions
4. Run test: confirm passes
5. Commit: `feat: flock-based claim locking with pre-claim check`

**Expected output**: Pre-claim check prevents double-claiming. Force override logged. Concurrent claims handled by flock.

---

## Wave 3: Views (depends on Wave 2)

### Task 6: Workload view (forge team workload)

**File(s)**: `scripts/forge-team/lib/workload.sh` (new)

**What to implement**: Replace `workload` stub in dispatcher.

- `forge team workload` — Shows all developers' active issues grouped by assignee. Queries GitHub as source of truth (via `sync_pull()` then local data). Shows: issue ID, title, status, age, blocked status.
- `forge team workload --developer=<github-user>` — Filter to one developer.
- `forge team workload --me` — Filter to current developer (via `get_github_user()`).
- `forge team workload --format=json` — JSON output for programmatic use.

**TDD steps**:
1. Write test: test with mock data (multiple developers, mixed statuses). Test `--developer` filter. Test `--me`. Test empty (no issues). Test stale assignments flagged (>48h).
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/workload.sh`
4. Run test: confirm passes
5. Commit: `feat: forge team workload — per-developer active issue views`

**Expected output**: Issues grouped by developer. Blocked items flagged. Stale items noted.

---

### Task 7: Epic rollup view (forge team epic)

**File(s)**: `scripts/forge-team/lib/epic.sh` (new)

**What to implement**: Replace `epic` stub in dispatcher.

- `forge team epic <id>` — Shows epic progress: total children, done count, in-progress, blocked. Per-developer breakdown. Completion percentage.
- `forge team epic <id> --format=json` — JSON output.
- If epic has no children → "No child issues".
- Shows blocked children with blocking reason (which issue blocks them).

**TDD steps**:
1. Write test: test epic with mixed status children. Test epic with blocked children. Test empty epic. Test per-developer breakdown. Test completion percentage calculation.
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/epic.sh`
4. Run test: confirm passes
5. Commit: `feat: forge team epic — epic progress rollup with per-developer breakdown`

**Expected output**: Epic progress displayed accurately. Blocked children flagged with reason.

---

### Task 8: Team dashboard (forge team dashboard)

**File(s)**: `scripts/forge-team/lib/dashboard.sh` (new)

**What to implement**: Replace `dashboard` stub in dispatcher.

- `forge team dashboard` — Aggregated team view: per-developer stats (open count, in-progress count, blocked count), stale assignments (>48h), epic progress summaries.
- `forge team dashboard --format=json` — JSON output.
- Pulls data via `sync_pull()` first, then aggregates from local Beads data.

**TDD steps**:
1. Write test: test full dashboard with mock data (multiple developers, epics). Test single developer team. Test all-clear (nothing blocked, nothing stale).
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/dashboard.sh`
4. Run test: confirm passes
5. Commit: `feat: forge team dashboard — aggregated team health view`

**Expected output**: Per-developer stats displayed. Stale and blocked items highlighted.

---

## Wave 4: Automation (depends on Waves 2-3)

### Task 9: Hook-based sync (pre-push + stage transitions)

**File(s)**: `scripts/forge-team/lib/hooks.sh` (new), `lefthook.yml` (extend), `scripts/beads-context.sh` (extend)

**What to implement**: Automatic GitHub sync triggered by git hooks and forge stage transitions.

- **Pre-push hook**: After existing checks pass, run `forge team sync` to push changed Beads state to GitHub. Non-blocking — warn on failure, don't prevent push.
- **Stage transitions**: Extend `beads-context.sh stage-transition` to call `forge team sync` after recording the transition. Auto-syncs status changes to GitHub.
- **`forge team sync`**: Manual trigger. Runs `sync_pull()` then pushes any local changes to GitHub. Reports what was synced.
- Configurable in `.beads/config.yaml`: `team.auto-sync: true|false` (default true).

**TDD steps**:
1. Write test: test sync on stage transition fires. Test pre-push hook integration (verify `forge team sync` is called). Test `auto-sync: false` config disables sync. Test sync failure doesn't block push.
2. Run test: confirm fails
3. Implement: Create `hooks.sh`, extend `lefthook.yml`, extend `beads-context.sh`
4. Run test: confirm passes
5. Run `node scripts/sync-commands.js` to propagate any command changes
6. Commit: `feat: hook-based GitHub sync on pre-push and stage transitions`

**Expected output**: Beads state auto-synced to GitHub on push and stage transitions. Failures warn but don't block.

---

### Task 10: 1:1 enforcement + orphan detection (forge team verify)

**File(s)**: `scripts/forge-team/lib/verify.sh` (new)

**What to implement**: Replace `verify` stub in dispatcher.

- `forge team verify` — Checks:
  1. All Beads issues have a linked GitHub issue (via `bd set-state github_issue` or `.github/beads-mapping.json`). Orphan Beads issues → `FORGE_AGENT_7f3a:PROMPT: forge-abc has no GitHub issue. Run: forge team sync-issue forge-abc`
  2. All GitHub issues (open, in the repo) have a Beads counterpart. Orphan GitHub issues → `FORGE_AGENT_7f3a:PROMPT: GitHub issue #42 has no Beads issue. Run: forge team import #42`
  3. All assignees in team-map are valid GitHub users
  4. Identity mapping is complete (current developer is mapped)
  5. `gh auth status` succeeds
- Exit 0 if all clean. Exit 1 if orphans found (with agent prompts).

**TDD steps**:
1. Write test: test all-clean scenario. Test orphan Beads issue detected. Test orphan GitHub issue detected. Test unmapped identity. Test `gh` not authenticated.
2. Run test: confirm fails
3. Implement: Create `scripts/forge-team/lib/verify.sh`
4. Run test: confirm passes
5. Commit: `feat: forge team verify — 1:1 enforcement and orphan detection`

**Expected output**: Clean run exits 0. Orphans detected with actionable agent prompts.

---

## Wave 5: Integration (depends on Waves 3-4)

### Task 11: Workflow integration (/status, /plan, /ship extensions)

**File(s)**: `.claude/commands/status.md`, `.claude/commands/plan.md`, `.claude/commands/ship.md`

**What to implement**: Integrate `forge team` into the forge workflow stages.

- **`/status`**: Add call to `forge team workload --me` to show current developer's active work. Add `forge team dashboard` summary (one-line: "Team: 3 devs, 2 blocked, 1 stale").
- **`/plan`**: Add call to `forge team verify` at entry to ensure identity is mapped before starting. Add call to `forge team workload` to show if the planned work area overlaps with other developers.
- **`/ship`**: After PR creation, auto-run `forge team sync` to push issue state to GitHub. Add `forge team verify` to confirm 1:1 mapping before shipping.

After editing commands, run `node scripts/sync-commands.js` to propagate to all 7 agent directories.

**TDD steps**:
1. Write test: verify command files contain `forge team` integration calls. Verify sync-commands.js --check passes.
2. Run test: confirm fails
3. Implement: Add integration sections to command files
4. Run test: confirm passes
5. Commit: `feat: forge team integration in /status, /plan, and /ship workflows`

**Expected output**: Command files contain integration points. All agent directories in sync.

---

### Task 12: Integration tests + edge case coverage

**File(s)**: `scripts/forge-team/tests/integration.test.sh` (new)

**What to implement**: End-to-end tests covering the full workflow and edge cases.

**Integration scenarios**:
1. Full flow: auto-detect identity → create issue → sync to GitHub → claim → workload shows it → close → GitHub closed
2. Two developers: both in team-map → workload shows both → cross-dev dependency visible
3. Epic rollup: epic with children owned by different developers → correct breakdown

**Edge case scenarios**:
- Edge B: Concurrent claim → flock prevents double-claim
- Edge C: Orphan Beads issue → verify detects and prompts
- Edge D: Orphan GitHub issue → verify detects and prompts
- Edge E: Bot accounts filtered from workload
- Edge F: GitHub rate limit → error message with retry guidance
- Edge I: Stale assignment → dashboard flags it
- AGENT_PROMPT injection → prefix stripped from malicious issue title

**TDD steps**:
1. Write test: all scenarios with mock `gh` and `bd`
2. Run test: confirm passes (or fix failing edge cases)
3. Commit: `test: integration tests and edge case coverage for forge team`

**Expected output**: All edge cases covered. Full workflow passing.

---

## Summary

| Wave | Tasks | Complexity |
|------|-------|------------|
| 1 | Tasks 1-3 (agent prompt, identity, dispatcher) | Low |
| 2 | Tasks 4-5 (GitHub sync, claim locking) | Medium-High |
| 3 | Tasks 6-8 (workload, epic, dashboard views) | Medium |
| 4 | Tasks 9-10 (hooks, verification) | Medium |
| 5 | Tasks 11-12 (workflow integration, integration tests) | Medium |

**Total**: 12 tasks across 5 waves. Tasks within each wave can run in parallel.
