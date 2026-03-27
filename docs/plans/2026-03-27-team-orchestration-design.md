# Team Orchestration — Design Doc

- **Feature**: team-orchestration
- **Date**: 2026-03-27
- **Status**: Phase 1 complete
- **Beads**: forge-wzpb (Layer 3 of forge-qml5 epic)
- **Depends on**: forge-w69s (session awareness, merged PR #92), forge-puh (parallel PRs, merged PR #98), forge-d2cl (GitHub↔Beads sync, PRs #71, #73)

---

## Purpose

Enable multi-developer teams to coordinate work through assignment tracking, cross-developer dependency visibility, and team dashboards — with Beads and GitHub Issues kept in perfect 1:1 sync as the shared source of truth.

Currently, forge-puh provides parallel PR coordination (merge order, conflict simulation), but there is no:

- Developer identity mapping (Beads identity ≠ GitHub username ≠ git email)
- Assignee/claim sync between Beads and GitHub
- Cross-developer blocking visibility ("your feature blocks mine")
- Team-level views (workload per developer, epic progress, team dashboard)
- 1:1 enforcement between Beads issues and GitHub issues

This causes:
- Two developers unknowingly claiming the same issue
- No visibility into who is blocked by whom across the team
- No aggregated team state — each developer only sees their own work
- Beads data stuck in feature branches, invisible to other developers

## Success Criteria

1. **1:1 Beads↔GitHub enforcement** — Every `bd create` auto-creates a GitHub issue if none exists. Every GitHub issue creation triggers Beads issue creation (existing forge-d2cl). `bd doctor --check=orphans` flags issues that exist on only one side.
2. **Identity mapping** — Auto-detects GitHub username (`gh api user`), git email (`git config user.email`), and session identity on first run. Stored in `.beads/team-map.jsonl`. Resolves multiple machines/emails to one canonical GitHub identity.
3. **Assignee/claim sync** — `bd update --claim` → `gh issue edit --add-assignee`. Pre-claim check queries GitHub: if already assigned, outputs `AGENT_PROMPT: forge-abc is claimed by Developer B. Proceed anyway?`
4. **Status label sync** — `bd update --status=in_progress` → GitHub label `status/in-progress`. Bidirectional for `open`, `in_progress`, `blocked`, `closed`.
5. **Priority label sync** — `bd create --priority=2` → GitHub label `P2`. Bidirectional.
6. **Dependency sync** — `bd dep add A B` → GitHub comment on issue A: "Blocked by #N". `forge/has-deps` and `forge/blocks-others` labels applied via pr-coordinator.
7. **`forge team workload [--developer=<name>]`** — Shows all in-progress issues per developer. Queries GitHub as source of truth. Shows blocked/unblocked status.
8. **`forge team epic <id>`** — Shows epic progress: N/M child issues done, per-developer breakdown, blocked children, completion percentage.
9. **`forge team dashboard`** — Team dashboard: open issues per developer, blocked count, stale count (>48h no activity), epic progress summary.
10. **Hook-based sync** — Pre-push hook auto-syncs changed Beads state to GitHub. Stage transitions trigger sync. Configurable in `.beads/config.yaml`.
11. **AGENT_PROMPT convention** — All user-facing questions output as `AGENT_PROMPT:` prefix. AI agents read this and ask the user. No interactive terminal prompts.
12. **Backward compatible** — All existing `bd` commands, scripts, and forge workflow stages work unchanged.

## Out of Scope

- AST-level function-level conflict detection (deferred to forge-ognn)
- WebSocket push server / live presence (deferred to forge-ognn)
- Permission enforcement (assignment is informational, not access control)
- Notification systems (Slack, email, push alerts)
- Dolt remote hosting setup (uses git + GitHub, not DoltHub)
- Cross-repository coordination

## Approach Selected: Plugin Architecture (Approach 3)

### Why not Approach 1 (bd subcommands)?
`bd` is the Beads CLI — coupling team orchestration to it means depending on an external tool's CLI that Forge doesn't control. Adding features = editing Go code in Beads. Upgrading `bd` risks breaking team features.

### Why not Approach 2 (monolithic script)?
A single `forge-team.sh` would grow too large as features are added. No separation of concerns, harder to test individual components.

### Approach 3: Plugin Architecture

```
scripts/
  forge-team/
    index.sh              ← Entry point + subcommand dispatcher
    lib/
      identity.sh          ← Identity mapping, auto-detection, AGENT_PROMPT
      sync-github.sh       ← GitHub ↔ Beads sync (extends forge-d2cl)
      workload.sh          ← Workload view logic
      epic.sh              ← Epic rollup logic
      dashboard.sh         ← Team dashboard logic
      hooks.sh             ← Pre-push, stage-transition sync hooks
      agent-prompt.sh      ← AGENT_PROMPT output convention helpers
    tests/
      identity.test.sh
      sync-github.test.sh
      workload.test.sh
      epic.test.sh
      dashboard.test.sh
      hooks.test.sh
```

**Interface:**
```bash
forge team workload                    # Show all devs' active work
forge team workload --developer=harsha # Filter to one dev
forge team epic forge-qml5             # Epic progress rollup
forge team dashboard                   # Full team view
forge team add                         # Auto-detect + AGENT_PROMPT if needed
forge team verify                      # Check identity map, flag orphans
forge team sync                        # Manual GitHub ↔ Beads sync
```

**Integration points:**
- Pre-push hook calls `forge team sync` for changed Beads state
- `/status` calls `forge team workload --me`
- `/plan` calls `forge team verify` before starting
- `bd create` hook calls `forge team sync-issue <id>` to create GitHub issue
- `bd update --claim` hook calls `forge team sync-claim <id>`
- `bd close` hook calls `forge team sync-close <id>`

### Identity Mapping

Stored in `.beads/team-map.jsonl` (append-only, LWW per GitHub username):

```json
{"github":"harshanandak","git_emails":["harsha@befach.com"],"session_ids":["harsha@befach.com@LAPTOP-WORK"],"display_name":"Harsha Nanda","updated_at":"2026-03-27T00:00:00Z","is_bot":false}
```

**Auto-detection flow** (no user interaction 90% of the time):
1. `gh api user --jq .login` → GitHub username
2. `git config user.email` → git email
3. `get_session_identity` → session identity
4. If all succeed → write mapping entry silently
5. If any fail → output `AGENT_PROMPT: <question>` for AI agent to ask user

**Resolving identities:**
- Any Beads session identity → look up in team-map → resolve to GitHub username
- Any git email → look up in team-map → resolve to GitHub username
- Multiple machines/emails per developer → all map to same GitHub username

### GitHub Sync Strategy

**Caching:** Local cache of GitHub issue state in `.beads/github-cache.jsonl`. Only query GitHub for issues that changed (use `since` parameter on list endpoint).

**Batch queries:** Use GitHub GraphQL API to fetch all issues in one call instead of REST per-issue. `gh api graphql` supports this.

**Hook-driven updates:** Only sync to GitHub when something actually changes:
- `bd create` → create GitHub issue
- `bd update --claim` → update GitHub assignee
- `bd update --status` → update GitHub label
- `bd close` → close GitHub issue
- `bd dep add` → add comment on GitHub issue

**Offline behavior:** Fail with clear error: `AGENT_ERROR: No GitHub access. Team features require internet connectivity. Run 'forge team sync' when back online.`

### AGENT_PROMPT Convention

All user-facing questions use structured output prefixes:

```bash
# Agent should ask the user and run the suggested command
echo "AGENT_PROMPT: Could not detect GitHub username. Ask the user for their GitHub username, then run: forge team add --github=<username>" >&2

# Informational — agent can summarize for user
echo "AGENT_INFO: Team sync complete. 3 issues synced, 1 new assignment detected." >&2

# Error — agent should investigate or report
echo "AGENT_ERROR: GitHub API rate limit exceeded. Try again in 15 minutes." >&2
```

This works with ANY AI agent because it's plain text in stderr/stdout.

## Constraints

1. **No interactive prompts** — Forge is a background tool. Use `AGENT_PROMPT:` for all user questions.
2. **GitHub required** — Team features need `gh` CLI authenticated. Offline = fail with clear error.
3. **No Dolt remote** — Uses git for JSONL sync, GitHub API for issue sync. No DoltHub dependency.
4. **No permission enforcement** — Assignment is informational only. Any developer can work on any issue.
5. **Backward compatible** — All existing `bd` commands, scripts, and forge stages work unchanged.
6. **Agent-agnostic** — Works with Claude, Cursor, Cline, Copilot, or any agent that reads stdout/stderr.

## Edge Cases

### A) Same developer, multiple machines
Auto-detected via git email matching. Both `harsha@LAPTOP-WORK` and `harsha@LAPTOP-HOME` map to `harshanandak` because they share `git config user.email`. If emails differ, `forge team verify` flags the mismatch and outputs `AGENT_PROMPT:`.

### B) Two developers claim same issue simultaneously
Pre-claim check queries GitHub assignee. If already assigned:
- Output: `AGENT_PROMPT: forge-abc is already claimed by Developer B (assigned 5 min ago). Override? Run: forge team claim forge-abc --force`
- `--force` overrides, logs audit trail via `bd comments add`

### C) GitHub issue exists without Beads counterpart (orphan)
`forge team verify` detects orphans. Outputs: `AGENT_PROMPT: GitHub issue #42 has no Beads counterpart. Run: forge team import #42`

### D) Beads issue exists without GitHub counterpart (orphan)
`forge team verify` detects. Outputs: `AGENT_PROMPT: forge-abc has no GitHub issue. Run: forge team sync-issue forge-abc`

### E) Bot accounts in workload
Auto-detected from `[bot]` suffix in GitHub username. Filtered from `forge team workload` and `forge team dashboard`. Visible in `forge team verify --include-bots`.

### F) GitHub rate limiting
Batch queries via GraphQL (one call for all issues). Cache GitHub state locally. Hook-driven sync only updates what changed. Typical team (5 devs, 50 issues) uses ~10 API calls per sync cycle, well under the 5000/hour limit.

### G) Git email changes
Developer changes git email. Old Beads issues show old identity. `forge team verify` detects the mismatch and outputs `AGENT_PROMPT: New git email detected (new@email.com). Map to existing GitHub user harshanandak? Run: forge team add --github=harshanandak --email=new@email.com`

### H) Epic with mixed ownership
Epic `forge-qml5` has child issues owned by different developers. `forge team epic` shows per-developer breakdown. No single "owner" enforced — epics are collaborative.

### I) Stale assignments
Developer claims an issue but goes inactive (no commits for 48h+). `forge team dashboard` flags stale assignments. Does NOT auto-unassign — outputs `AGENT_INFO: forge-abc claimed by Developer B has been inactive for 72h.`

## Ambiguity Policy

Use 7-dimension rubric scoring per /dev decision gate:
- >= 80% confidence: proceed and document the decision
- < 80% confidence: stop and ask user
