# Design: GitHub <-> Beads Bidirectional Issue Sync

- **Feature**: github-beads-sync
- **Date**: 2026-03-21
- **Status**: Draft
- **Epic**: forge-d2cl
- **Branch**: feat/github-beads-sync

---

## Purpose

Bridge GitHub Issues (human/team/public interface) and Beads (AI agent engine) so they stay in sync automatically. Contributors and external users interact via GitHub Issues; AI agents interact via Beads CLI. Neither side needs to know about the other.

Packaged as a **Forge plugin** integrated into `bunx forge setup` — users opt-in during interactive setup, and the workflows + scripts are scaffolded into their project.

### Who benefits

- **Contributors**: Create/close issues on GitHub as usual. Beads stays updated without manual `bd close` or `bd sync`.
- **AI agents**: Run `bd ready` and pick up work that originated from GitHub Issues. Close via `bd close` and GitHub auto-updates.
- **Project managers / teams**: Use GitHub Projects boards for kanban/table views. Issues auto-populate from the sync.
- **Open source maintainers**: Public-facing issue tracker (GitHub) backed by structured AI-native tracking (Beads).

---

## Success Criteria

1. When a GitHub issue is created, a corresponding Beads issue exists within 60 seconds with title, GitHub URL, mapped labels/priority/assignee.
2. When a GitHub issue is closed (including via `Closes #N` in a merged PR), the linked Beads issue is automatically closed.
3. When a Beads issue is closed (Phase 2), the linked GitHub issue is automatically closed.
4. No infinite loops between GitHub and Beads sync.
5. Idempotent — re-running workflows on the same issue produces no duplicates or errors.
6. `forge setup` can scaffold all required files into a user's project.
7. Opt-out available via `skip-beads-sync` label or `no-beads` in issue body.

---

## Out of Scope

- **Field updates after creation** — Title, description, labels, priority are synced at creation only. No ongoing field sync. (Future: forge-na3x, P4)
- **Reusable composite GitHub Action** — Phase 1 uses Node scripts called from workflows. Packaging as `uses: forge/beads-sync@v1` is future work. (Future: forge-s3cb, P4)
- **Multi-developer orchestration** — Assignment mapping is included (one-way on create), but workload balancing, cross-dev dependencies, and team dashboards are separate. (Future: forge-wzpb, P3; existing: forge-puh, P2)
- **GitHub Projects board management** — We create well-labeled issues; users configure GitHub's native "auto-add to project" feature themselves. Documented, not automated.
- **Cross-repo sync** — Same-repo only. Cross-repo would require PATs and different architecture.

---

## Design Decisions

### D1: Source of Truth — Create-Only Sync (Option D)

Issues are created bidirectionally and status (open/closed) syncs, but fields are never overwritten after creation. Each side owns its own fields post-creation. Avoids conflict resolution entirely.

### D2: Mapping Strategy — Bot Comment + Mapping File (Option C)

- **Bot comment**: Human-visible `<!-- beads-sync -->Beads: forge-abc` on the GitHub issue. Self-documenting.
- **Mapping file**: `.github/beads-mapping.json` with `{ "42": "forge-abc" }`. Fast lookup on close, debuggable, resilient if comment is deleted.
- Bot comment is the UX layer; mapping file is the reliability layer.

### D3: Plugin Distribution — Forge Setup Addon (Option C)

Integrated into `bunx forge setup`. During interactive setup: "Enable GitHub <-> Beads sync? (y/n)". Scaffolds workflow files, scripts, config, and mapping file template.

### D4: Label & Priority Mapping — Configurable (Option C)

Default mapping in `github-beads-sync.config.json`:
```json
{
  "labelToType": {
    "bug": "bug",
    "enhancement": "feature",
    "documentation": "task",
    "question": "task"
  },
  "labelToPriority": {
    "P0": 0, "critical": 0,
    "P1": 1, "high": 1,
    "P2": 2, "medium": 2,
    "P3": 3, "low": 3,
    "P4": 4, "backlog": 4
  },
  "defaultType": "task",
  "defaultPriority": 2,
  "mapAssignee": true
}
```
Users customize to match their label conventions. Applied at creation only (per D1).

### D5: GitHub Projects Integration — User-Configured (Option C)

Document how to use GitHub's native "auto-add issues to project" workflow. Our plugin creates well-labeled issues; GitHub's own automation handles board placement. Less code, more flexibility.

### D6: Approach — Node Scripts + GitHub Actions (Approach 2)

Thin `.yml` workflows call `node scripts/github-beads-sync.mjs opened|closed`. Logic lives in testable Node modules under `scripts/github-beads-sync/`. Matches repo conventions, testable, Windows-compatible.

### D7: Ambiguity Policy — Rubric Scoring (Option C)

Per project policy: >=80% confidence -> proceed and document, <80% -> stop and ask user.

---

## Constraints

- **No hook bypasses**: AI agents must never use `LEFTHOOK=0` or `--no-verify`.
- **GITHUB_TOKEN only**: No PATs required for same-repo. Document PAT needs for cross-repo (out of scope).
- **Linux CI runners**: Beads CLI installs via `bun add -g @beads/bd` on Linux (no Windows EPERM issue).
- **Sanitize inputs**: GitHub issue titles/bodies flow into `bd create` args — must sanitize to prevent command injection.
- **Serialized writes**: Only one workflow writes to `.beads/` at a time to avoid concurrent edit conflicts.

---

## Architecture

```
GitHub Issue Created (#42)
  |
  v
.github/workflows/github-to-beads.yml
  |-- Guard: skip bot, skip-beads-sync label, no-beads body
  |-- Idempotency: check existing bot comment
  |-- node scripts/github-beads-sync.mjs opened
  |     |-- Read issue via GitHub API (title, labels, assignee)
  |     |-- Map labels -> type/priority via config
  |     |-- bd create --title "..." --type X --priority N --assignee Y
  |     |-- bd update <id> --description "GitHub: .../issues/42"
  |     |-- Update .github/beads-mapping.json { "42": "forge-abc" }
  |     |-- Post bot comment: <!-- beads-sync -->Beads: forge-abc
  |-- git add .beads/ .github/beads-mapping.json
  |-- git commit -m "chore(beads): sync from GitHub issue #42"
  |-- git push
  v
Done

GitHub Issue Closed (#42)
  |
  v
.github/workflows/github-to-beads.yml (issues.closed trigger)
  |-- Guard: skip bot, skip if not_planned
  |-- node scripts/github-beads-sync.mjs closed
  |     |-- Read .github/beads-mapping.json -> "42" -> "forge-abc"
  |     |-- Fallback: parse bot comment if mapping missing
  |     |-- bd show forge-abc -> check if still open
  |     |-- bd close forge-abc --reason "Closed via GitHub issue #42"
  |-- git add .beads/
  |-- git commit -m "chore(beads): close forge-abc via GitHub issue #42"
  |-- git push
  v
Done

Beads Issue Closed (Phase 2)
  |
  v
.github/workflows/beads-to-github.yml (push trigger, paths: .beads/**)
  |-- Guard: skip if commit message starts with "chore(beads):"
  |-- node scripts/github-beads-sync.mjs beads-closed
  |     |-- Diff issues.jsonl for closed transitions
  |     |-- Parse description for GitHub URL
  |     |-- gh api PATCH to close GitHub issue
  |-- No .beads/ commit needed (already pushed)
  v
Done
```

---

## Edge Cases

1. **GitHub issue created by bot** -> Guard checks `github.actor`, skips to prevent loops.
2. **Issue already has beads-sync comment** -> Idempotency check, skip `bd create`.
3. **Bot comment deleted** -> Fallback to mapping file lookup on close.
4. **Mapping file missing entry** -> Fallback to comment parsing, then `bd search` by GitHub URL.
5. **Beads issue already closed** -> `bd show` check before `bd close`, skip if already closed.
6. **Concurrent workflow runs** -> Git push retry with rebase (max 3 attempts).
7. **Issue closed as not_planned** -> Optionally skip Beads close or close with different reason.
8. **Fork PRs with `Closes #N`** -> Works because GitHub closes the issue on the upstream repo, triggering our workflow there.
9. **Issue title contains shell metacharacters** -> Sanitize via Node (no shell interpolation).
10. **`bd` not in PATH** -> Workflow installs it fresh each run; pinned version in workflow.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Infinite loops (GH <-> Beads) | Bot detection, commit message prefix guard, opt-out label |
| bd version skew | Pin `@beads/bd` version in workflow; document |
| Concurrent .beads/ edits | Serialize via single workflow; git push retry with rebase |
| Command injection via issue title | Node `execFile` (no shell), sanitize args |
| Mapping file grows unbounded | Periodic cleanup of closed issues (future maintenance task) |
| GITHUB_TOKEN insufficient | Document permissions; same-repo only in Phase 1 |

---

## File Structure (what gets scaffolded)

```
.github/
  workflows/
    github-to-beads.yml          # issues.opened + issues.closed triggers
    beads-to-github.yml          # Phase 2: push trigger for .beads/** changes
  beads-mapping.json             # { "github_issue_number": "beads_id" }
scripts/
  github-beads-sync/
    index.mjs                    # Entry point: opened|closed|beads-closed
    parse-link.mjs               # Parse beads ID from comment, GitHub URL from description
    run-bd.mjs                   # Wrapper around bd CLI (execFile, no shell)
    comment-issue.mjs            # Post/read bot comments on GitHub issues
    mapping.mjs                  # Read/write .github/beads-mapping.json
    config.mjs                   # Load github-beads-sync.config.json
  github-beads-sync.config.json  # Label/priority/type mapping config
test/
  scripts/
    github-beads-sync.test.js    # Unit tests for pure functions
```

---

## Technical Research

### Codebase Patterns to Reuse

| Pattern | Location | How to Reuse |
|---------|----------|--------------|
| `execFileSync` with array args | `scripts/branch-protection.js` | Same pattern for `bd` CLI calls — no shell, args as array |
| `validateCommonSecurity()` | `bin/forge.js` | Import for sanitizing GitHub issue titles/bodies before passing to `bd` |
| `askYesNo()` prompt | `bin/forge.js` | Reuse in `forge setup` for "Enable GitHub sync?" prompt |
| User section preservation | `bin/forge.js` (`<!-- USER:START -->`) | Apply to scaffolded workflow files so users can customize |
| `$GITHUB_STEP_SUMMARY` | `.github/workflows/test.yml` | Use for workflow run summaries |
| `concurrency` groups | Existing workflows | Mandatory for serializing `.beads/` writes |

### bd CLI Capabilities (Verified)

Key flags for sync:
- **Create**: `bd create --title "..." --type X --priority N --assignee Y --description "..." --external-ref "gh-42"`
- **Close**: `bd close <id> --reason "Closed via GitHub issue #42"`
- **Search**: `bd search "query"` (full text across title + description + ID)
- **List**: `bd list --desc-contains="github.com/issues/42"` (filter by description content)
- **Show**: `bd show <id>` (check if open/closed)

Discovery: `--external-ref` flag stores `gh-42` natively on the Beads issue. This provides a third lookup path alongside bot comment and mapping file.

### OWASP Top 10 Analysis

| Category | Applies? | Risk | Mitigation |
|----------|----------|------|------------|
| **A03: Injection** | CRITICAL | Issue titles/bodies flow into `bd create` args. Existing proof: `forge-04t` in `.beads/issues.jsonl` contains `echo PWNED2 rm -rf /`. | `execFile` with array args (no shell). Sanitize via `validateCommonSecurity()`. Never use `${{ github.event.issue.title }}` in `run:` blocks — pass via `env:` instead. |
| **A01: Broken Access Control** | HIGH | On public repos, any GitHub user can open issues, triggering commits to default branch. | Gate on `author_association` (MEMBER, COLLABORATOR, OWNER) OR require maintainer-applied label (e.g., `beads-track`). Configurable per-repo. |
| **A08: Data Integrity** | HIGH | Attacker-controlled content gets committed to `.beads/` without review. | Sanitize all fields. Commit only to `.beads/` and `.github/beads-mapping.json` — never touch source code. Limit what's stored (title, URL, type, priority — not raw body). |
| **A05: Security Misconfiguration** | MEDIUM | Workflow permissions too broad. | Use minimal permissions: `contents: write` (for push), `issues: write` (for comments). No PATs needed for same-repo. |
| **A09: Logging & Monitoring** | MEDIUM | Silent failures in sync. | Write to `$GITHUB_STEP_SUMMARY`. Log skipped/failed syncs. Mapping file serves as audit trail. |
| **A02: Cryptographic Failures** | LOW | No secrets in sync data. | GITHUB_TOKEN is ephemeral, scoped to workflow run. No custom secrets needed. |
| **A04-A10 (others)** | N/A | Not applicable to this feature's surface area. | — |

**GitHub Actions-Specific Risks:**

| Risk | Severity | Mitigation |
|------|----------|------------|
| Workflow injection via `${{ }}` interpolation | CRITICAL | Never interpolate event data in `run:` blocks. Use `env:` to pass data safely. |
| Race conditions (concurrent workflow runs) | HIGH | `concurrency: { group: beads-sync, cancel-in-progress: false }` — queue, don't cancel. |
| Fork PR manipulation | LOW | `issues` events only fire on the base repo, not forks. Not exploitable. |
| Token scope escalation | LOW | `GITHUB_TOKEN` is auto-scoped to the repo. No PAT needed. |

### Developer UX Research Findings

**Key insight**: The #1 reason developers don't update issue status is it requires leaving their workflow. 50% of devs lose 10+ hrs/week to non-coding tasks (Atlassian 2025).

**What makes sync "awesome" (validated patterns):**

1. **Zero-action status updates** — Linear auto-updates from PR/branch activity. Our sync achieves this: create issue on GitHub -> Beads auto-creates; close on GitHub -> Beads auto-closes. Developer does nothing extra.

2. **Edit-don't-create for bot comments** — Vercel edits ONE comment per PR instead of creating new ones. Our bot comment should follow this: one `<!-- beads-sync -->` comment per issue, edited if re-synced (not a new comment each time).

3. **Silent by default** — Bot notification noise is the #1 complaint. Our bot comment should be minimal, use collapsible `<details>` for metadata, and avoid @-mentioning anyone.

4. **Convention over configuration** — Branch name parsing, closing keywords, and `--external-ref` should work with zero setup. The config file exists for customization, not as a requirement.

**Minimum viable sync (80% value):**
- Bidirectional create + bidirectional close = 80% of the value
- Label/priority mapping on create = +10%
- Everything else (auto-status from branch activity, comment sync, field updates) = Phase 2+

**Bot comment format (based on Vercel/Dependabot patterns):**
```markdown
<!-- beads-sync:42 -->
**Beads:** `forge-abc` | [View in Beads](bd show forge-abc)
<details>
<summary>Sync details</summary>

- Type: feature
- Priority: P2
- External ref: gh-42
- Synced: 2026-03-21T10:00:00Z
</details>
```

### DRY Check

Searched for existing GitHub sync implementations:
- No existing webhook/issue sync code in the codebase
- No `github-beads` or `issue-sync` patterns found
- The `scripts/` directory has `branch-protection.js` and `sync-commands.js` but nothing for issue sync
- **Result: No duplication. Proceeding with new implementation.**

### TDD Test Scenarios

| # | Scenario | Type | Input | Expected Output |
|---|----------|------|-------|-----------------|
| 1 | Parse beads ID from bot comment | Happy path | `<!-- beads-sync:42 -->\n**Beads:** forge-abc` | `"forge-abc"` |
| 2 | Parse beads ID when comment missing | Error path | `"Regular comment with no beads tag"` | `null` |
| 3 | Parse GitHub URL from beads description | Happy path | `"GitHub: https://github.com/owner/repo/issues/42"` | `{ owner: "owner", repo: "repo", number: 42 }` |
| 4 | Mapping file read/write | Happy path | Write `{ "42": "forge-abc" }`, read back | `"forge-abc"` for key `"42"` |
| 5 | Mapping file missing entry | Edge case | Read key `"99"` from `{ "42": "forge-abc" }` | `null` |
| 6 | Sanitize malicious issue title | Security | `"Normal title; rm -rf / && echo PWNED"` | Sanitized string or rejection |
| 7 | Label-to-type mapping with config | Happy path | Labels `["bug", "P1"]`, default config | `{ type: "bug", priority: 1 }` |
| 8 | Label mapping with no matching labels | Edge case | Labels `["wontfix", "stale"]` | `{ type: "task", priority: 2 }` (defaults) |
| 9 | Idempotency — issue already synced | Edge case | Issue #42 already has beads-sync comment | Skip, return existing beads ID |
| 10 | Build bd create args from GitHub issue | Integration | `{ title, labels, assignee, url }` | Correct `execFile` args array |
| 11 | Concurrent mapping file access | Race condition | Two simultaneous writes | File not corrupted, both entries present |
| 12 | Bot comment format generation | Happy path | `{ beadsId: "forge-abc", issueNumber: 42, type: "feature" }` | Correct markdown with HTML comment tag |
