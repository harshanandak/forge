# WS1: CLI Abstraction Layer — Comprehensive Risk Analysis

**Document**: Risk assessment for Forge CLI abstraction layer migration  
**Scope**: `forge pr`, `forge info`, `forge rebase`, `forge audit` + agent instruction migration  
**Status**: Pre-implementation analysis  
**Last Updated**: 2026-04-06  

---

## Executive Summary

Forge CLI abstraction replaces raw `bd`/`gh`/`git` commands across 6 agents (Claude Code, Codex, Kilo, OpenCode, Cursor, Copilot). The primary dependency is **gh CLI**, which introduces critical failure modes around authentication, network, and version compatibility. **PreToolUse hooks only work on Claude Code** — leaving 5 agents unprotected. Agent instruction migration poses a 60+ file coordination challenge. This document details all identified risks, mitigations, and blockers.

---

## A. GH CLI Dependency Risks

### A1: gh CLI Not Installed

**Severity**: CRITICAL | **Likelihood**: MEDIUM | **Blocker**: YES

**Description**: `forge pr create`, `forge pr view`, `forge pr checks` all depend on `gh` CLI. If not installed or not in PATH, all PR operations fail silently or with cryptic ENOENT errors.

**Edge Cases**:
- Machines with only git (no gh CLI)
- CI/CD containers without gh pre-installed
- WSL1 on Windows (PATH resolution issues)
- Docker images in restricted repos without gh

**Current Mitigation**:
- `setup.js` runs `gh --version` and `gh auth status` checks at startup
- Warnings printed but commands continue (soft check only)

**Recommended Mitigations**:
1. **Hard gate in forge commands**: Check gh availability BEFORE invoking PR operations. Fail fast with clear message: "gh CLI required. Install: https://cli.github.com/manual/installation"
2. **Fallback to API**: forge-issues MCP replaces beads entirely; use MCP for PR operations instead of shelling to gh
3. **Pre-flight validation**: `forge setup` should return non-zero if gh is missing AND any PR workflow is attempted
4. **Container detection**: Warn users if running in docker/ci without gh (detect via ENV vars)

**Post-Mitigation Status**: MEDIUM severity, non-blocking if API fallback available

---

### A2: gh CLI Authentication Required

**Severity**: HIGH | **Likelihood**: MEDIUM | **Blocker**: YES

**Description**: gh CLI requires `gh auth login` before any operations. New machines, CI agents, or re-authed sessions will fail.

**Edge Cases**:
- GitHub Enterprise with custom API URL (requires `gh auth login --web --hostname github.enterprise.com`)
- Token expiry in long-running agent sessions (>1 hour)
- GHES (GitHub Enterprise Server) with self-signed certs
- CI runners with GITHUB_TOKEN env var but gh not configured
- User revokes token while agent is mid-workflow

**Current Mitigation**:
- `setup.js` detects auth status and prints warning
- No retry logic or fallback

**Recommended Mitigations**:
1. **Auth token detection**: Check `GITHUB_TOKEN`, `GH_TOKEN` env vars before invoking gh. If set, gh should auto-auth
2. **Graceful degradation**: If gh auth fails, pause and ask user: "GitHub CLI authentication required. Run: gh auth login"
3. **Enterprise support**: Detect GHES domain in git remote URL; configure gh for custom hostname
4. **Session recovery**: If token expires mid-workflow, catch auth error and prompt re-auth instead of silent failure
5. **forge setup --auth**: New command to validate and store auth state

**Post-Mitigation Status**: HIGH severity, manageable with auth detection

---

### A3: gh API Rate Limits

**Severity**: MEDIUM | **Likelihood**: HIGH | **Blocker**: NO (degraded)

**Description**: GitHub API has strict rate limits (60 req/hour unauthenticated, 5000/hour authenticated). Agents calling `gh pr view`, `gh pr list`, `gh pr checks` repeatedly could hit limits.

**Edge Cases**:
- Multiple agents querying the same repo simultaneously
- Polling loops in `/review` waiting for checks (`gh pr checks` every 10s × 100 iterations = 100 requests)
- Large repos with 1000+ open PRs (`gh pr list` slow, may paginate)
- `gh pr view --json` with many fields (counts as 1 request but expensive)

**Current Mitigation**:
- None in current code. Commands invoke gh directly without rate-limit awareness

**Recommended Mitigations**:
1. **Caching**: Store PR state locally with TTL (e.g., cache `.forge/state/pr-<number>.json` for 30s)
2. **Batch queries**: Use `gh pr list --json` once, filter locally instead of multiple `gh pr view` calls
3. **Exponential backoff**: If rate-limited (HTTP 403), wait and retry with backoff
4. **Token-aware limits**: Detect auth method (token vs user login) and adjust polling frequency
5. **Metrics**: Log API call count per stage; warn if approaching limits

**Post-Mitigation Status**: MEDIUM severity, manageable with caching

---

### A4: gh CLI Version Differences

**Severity**: MEDIUM | **Likelihood**: MEDIUM | **Blocker**: MAYBE

**Description**: gh CLI flag syntax and JSON output format vary across versions. Older versions may not support `--json`, `--jq` filters, or certain flags.

**Edge Cases**:
- User on gh v1.10 (2021), agent requires v2.0+ (2021)
- CI runner with outdated gh pre-installed
- Homebrew/apt versions lag latest gh release by weeks
- Cross-platform version drift (macOS via Homebrew, Linux via apt, Windows via installer)

**Current Mitigation**:
- `setup.js` checks `gh --version` but doesn't validate minimum version
- Commands assume modern gh syntax (e.g., `--json`, `--jq`)

**Recommended Mitigations**:
1. **Version check**: Parse `gh --version` output; enforce minimum version (e.g., `>= 2.0.0`)
2. **Feature detection**: Test `gh pr view --json 2>&1 | grep -q "json"` to detect JSON support
3. **Documentation**: Document minimum gh version in setup guide
4. **CI/CD**: Upgrade gh in container images to latest stable

**Post-Mitigation Status**: MEDIUM severity, manageable with version checks

---

## B. Agent Instruction Migration Risks

### B1: 60+ Files, 6 Agents, Inconsistent State

**Severity**: HIGH | **Likelihood**: HIGH | **Blocker**: YES

**Description**: Forge replaces raw commands in 11 `.claude/commands/*.md` files across 6 agents. Updating all 6 agent configs requires coordinated file generation and testing. Missing updates in even one agent allows raw commands.

**File Inventory**:
- `.claude/commands/{dev, plan, premerge, review, research, rollback, ship, status, validate, verify, sonarcloud}.md`
- Codex, Kilo, OpenCode, Cursor, Copilot: AGENTS.md + agent-specific rules
- Total: 11 × 6 = 66+ instruction files

**Edge Cases**:
- Agent inherits instructions from parent (some agents may auto-sync, others may not)
- Old instructions still referenced in git history (agents call old commands)
- Setup scripts hardcode agent configs (don't auto-update)
- Instructions generated dynamically (forge setup creates AGENTS.md) — stale if setup not re-run

**Current Mitigation**:
- `setup.js` copies command templates to each agent
- No validation that all agents have identical/current versions

**Recommended Mitigations**:
1. **Single source of truth**: Store commands in `/forge/lib/commands-generated/` instead of per-agent; agents symlink to shared version
2. **Setup checksum**: `forge setup` generates SHA256 of all instructions; agents store in config; warn if stale (>30d)
3. **Audit command**: `forge audit --instructions` lists all agent instruction files, flags if any reference raw bd/gh/git
4. **CI check**: Pre-commit hook validates all agent configs match schema
5. **Versioning**: Commands versioned as `{command}-{version}.md`; setup pins compatible versions
6. **Test coverage**: Each agent tested with all 7 stages (plan → verify) in CI

**Post-Mitigation Status**: HIGH severity, critical for enforcement

---

### B2: Instructions Reference Old bd Commands

**Severity**: HIGH | **Likelihood**: MEDIUM | **Blocker**: YES

**Description**: Existing CLAUDE.md, AGENTS.md, or Beads documentation may reference `bd` commands (e.g., `bd issue list`, `bd update`). Agents copy or inherit these stale instructions.

**Edge Cases**:
- Beads prefixed issue IDs (e.g., `beads-123`) still used in old instructions
- Backward compatibility period where both bd and forge-issues work
- Comments in code reference old bd workflow
- Setup guide documents bd commands (not updated during migration)

**Current Mitigation**:
- premerge.md explicitly blocks `gh pr merge` via hook
- No automated check for bd references

**Recommended Mitigations**:
1. **Search and replace**: Grep for `bd issue`, `bd update`, `bd comment`, `bd ready`, `bd search` across all instruction files; replace with forge equivalents
2. **Deprecation warnings**: Add section to CLAUDE.md: "bd CLI deprecated. Use forge CLI instead."
3. **Migration guide**: Document old → new command mapping (e.g., `bd issue list → forge issue list`)
4. **Beads ID transition**: forge-issues MCP accepts both old (beads-123) and new (forge-123) IDs during transition period
5. **Lint rule**: Add to `.claude/rules/*.md`: agents MUST NOT call `bd` directly

**Post-Mitigation Status**: HIGH severity, resolvable via audit and replacement

---

### B3: New Agent Instructions Generated Incorrectly by forge setup

**Severity**: HIGH | **Likelihood**: MEDIUM | **Blocker**: YES

**Description**: `forge setup` generates agent instructions dynamically. If template is wrong or setup crashes, agents get broken configs. Setup is not idempotent or tested.

**Edge Cases**:
- Setup runs on new machine; overwrites existing customizations
- Setup fails mid-way (e.g., network timeout writing AGENTS.md); leaves partial state
- Template hardcodes agent names/IDs that differ from actual agent config
- Setup doesn't validate agent is actually installed before generating instructions

**Current Mitigation**:
- setup.js copies files but doesn't validate agent state after
- No idempotency checks or rollback

**Recommended Mitigations**:
1. **Dry-run**: `forge setup --dry-run` shows what will be changed without writing
2. **Backup**: `forge setup` saves backup of old instructions as `.claude/commands-backup-{timestamp}/`
3. **Validation**: After setup, run `forge audit --instructions` to verify all agents have correct configs
4. **Agent detection**: `forge setup` queries each agent for installed plugins/commands before generating instructions
5. **Checksum verification**: After setup writes files, compute SHA and compare expected; fail if mismatch
6. **Test suite**: `forge setup` runs smoke test (e.g., `forge plan --help`) for each agent

**Post-Mitigation Status**: HIGH severity, critical for setup robustness

---

## C. PreToolUse Hook Enforcement Risks

### C1: Hooks Only Work on Claude Code

**Severity**: CRITICAL | **Likelihood**: CERTAIN | **Blocker**: YES

**Description**: PreToolUse hooks are configured in `.claude/settings.json`, which only applies to Claude Code. The 5 other agents (Codex, Kilo, OpenCode, Cursor, Copilot) do NOT support hooks.

**Evidence**:
- claude.plugin.json: "hooks": true
- codex, kilo, opencode, cursor, copilot: "hooks": false

**Impact**: Blocking `gh pr merge`, `git reset --hard`, force push only works for Claude Code. Other agents can still execute these commands.

**Current Mitigation**:
- Instructions tell agents NOT to run blocked commands (soft enforcement)
- Comments in `.claude/commands/*.md`: "**NEVER run `gh pr merge`** — blocked by PreToolUse hook"

**Recommended Mitigations**:
1. **Instruction-based enforcement**: Add mandatory section to every agent's instructions
2. **Assertion in command exit**: `forge ship` does NOT succeed unless `gh pr create` output contains PR URL; aborts if missing
3. **Audit logging**: `forge audit --command-log` lists all bash invocations per session; flag any dangerous commands
4. **Agent selection**: For critical workflows, require Claude Code (only agent with hooks)
5. **MCP fallback**: forge-issues MCP can REJECT operations before reaching gh CLI

**Post-Mitigation Status**: CRITICAL — hooks inadequate; requires multi-layer defense

---

## D. forge pr create Deep Integration Risks

### D1: gh pr create Fails (Network, Auth, Permissions)

**Severity**: HIGH | **Likelihood**: MEDIUM | **Blocker**: YES

**Description**: `gh pr create` can fail mid-way due to network timeout, auth revoked, or insufficient permissions. Partial failure leaves PR half-created or not created.

**Edge Cases**:
- Network timeout during PR creation (PR may or may not be created)
- User loses push permission between `/validate` and `/ship`
- GitHub repo archived or deleted
- Base branch no longer exists (deleted by user)

**Current Mitigation**:
- execFileSync throws on non-zero exit; error bubbles up
- No idempotency check (second invocation would fail "PR already exists")

**Recommended Mitigations**:
1. **Idempotency**: Check if PR already exists (via `gh pr list`) before creating; if exists, return existing PR URL
2. **Retry logic**: Exponential backoff for transient failures (network timeouts)
3. **Detailed error messages**: Parse gh error output; translate to actionable user guidance
4. **Rollback**: If PR creation fails after branch push, offer: "Branch pushed but PR failed. Retry PR creation? Or undo push?"
5. **Dry-run**: `forge ship --dry-run` previews PR creation without actually creating

**Post-Mitigation Status**: HIGH severity, critical for reliability

---

## E. forge rebase Conflict Handling Risks

### E1: Merge Conflicts Auto-Resolution Failure

**Severity**: HIGH | **Likelihood**: MEDIUM | **Blocker**: YES

**Description**: `forge rebase` detects merge conflicts but cannot resolve them automatically. Agent hangs or fails with unclear error.

**Edge Cases**:
- Same file modified in both feature and base branch (conflict in git mergetool)
- Conflict markers in documentation (merge tool can't decide)
- Large rebase with 100+ commits, multiple conflicts

**Current Mitigation**:
- `ship.md` step 4 mentions `git rebase --abort` but no automation

**Recommended Mitigations**:
1. **Conflict detection**: `forge rebase` runs `git rebase origin/base` and catches `CONFLICT` in output; stops before entering conflict state
2. **Interactive guidance**: Print conflicted files and next steps instead of hanging
3. **Merge strategy**: Offer `ours` or `theirs` strategy (may discard changes)
4. **Escalate**: If conflicts unresolvable, escalate to user with conflict details
5. **Test after rebase**: Run tests after successful rebase to catch logic errors

**Post-Mitigation Status**: HIGH severity, requires manual guidance and testing

---

## F. Cross-Platform Risks

### F1: Path Handling (Windows vs Unix)

**Severity**: MEDIUM | **Likelihood**: HIGH | **Blocker**: YES

**Description**: Windows uses backslashes (`\`), Unix uses forward slashes (`/`). Forge commands may hardcode paths.

**Edge Cases**:
- Hardcoded Unix path fails on Windows
- CRLF in scripts breaks on Unix
- WSL path resolution (C:\Users vs /mnt/c/Users)

**Current Mitigation**:
- Commands use `node:path` module for some path operations
- Bash scripts use forward slashes (works on Git Bash, WSL)

**Recommended Mitigations**:
1. **Use node:path**: All path operations should use `path.join()`, `path.resolve()`, not string concat
2. **Cross-platform scripts**: Use `bash` (Git Bash, WSL) or Node.js instead of `.bat` batch files
3. **Path normalization**: Convert Windows paths to Unix: `path.normalize().replace(/\\/g, '/')`
4. **Testing**: Test all commands on Windows (native PowerShell, WSL, Git Bash) and macOS/Linux

**Post-Mitigation Status**: MEDIUM severity, manageable with path.* APIs

---

### F2: Shell Quoting Differences

**Severity**: MEDIUM | **Likelihood**: MEDIUM | **Blocker**: YES (for complex args)

**Description**: Windows PowerShell, Bash, cmd.exe have different quoting rules. Arguments with spaces or special chars may fail.

**Current Mitigation**:
- ship.js uses `execFileSync` with separate args array (avoids shell parsing)

**Recommended Mitigations**:
1. **Always use execFileSync**: Pass args as array, not concatenated string
2. **Escape special chars**: Use shell-escape library for complex args
3. **Avoid shell features**: Don't rely on pipes, redirects in Node.js code; use Node.js APIs instead

**Post-Mitigation Status**: MEDIUM severity, manageable with execFileSync arrays

---

## G. Backward Compatibility Risks

### G1: Existing Scripts Call bd Directly

**Severity**: MEDIUM | **Likelihood**: HIGH | **Blocker**: YES

**Description**: Existing project scripts (CI/CD, setup, deploy) may call `bd` directly. These scripts break if `bd` unavailable.

**Edge Cases**:
- GitHub Actions workflow runs `bd issue update`
- Setup script: `scripts/setup.sh` runs `bd ready` to list ready issues
- Deploy script: `scripts/deploy.sh` closes issue after successful deployment

**Current Mitigation**:
- None. Scripts not audited or migrated

**Recommended Mitigations**:
1. **Audit scripts**: `forge audit --scripts` lists all `.sh`, `.js` files calling `bd`
2. **Rewrite scripts**: Replace bd calls with forge or MCP equivalents
3. **Wrapper**: Create bash wrapper `/usr/local/bin/bd` that calls `forge` (for legacy compatibility)
4. **CI/CD migration**: Update GitHub Actions workflows to use `forge` instead of `bd`

**Post-Mitigation Status**: MEDIUM severity, requires script audit and migration

---

### G2: Existing Beads Issues with bd-Prefixed IDs

**Severity**: MEDIUM | **Likelihood**: HIGH | **Blocker**: YES

**Description**: Beads uses bd-prefixed issue IDs (e.g., `beads-123`). forge-issues MCP must support old IDs for backward compatibility.

**Edge Cases**:
- Old issues still referenced in PRs, commits, docs
- Beads database has 1000s of issues with beads-* IDs
- Migration tool needs to map old IDs to new IDs (or support both)

**Current Mitigation**:
- forge-issues MCP design unspecified; may not support old IDs

**Recommended Mitigations**:
1. **ID aliasing**: forge-issues MCP accepts both `beads-123` and `forge-123` formats; maps to internal issue
2. **Migration tool**: `forge migrate-issues` imports beads issues; assigns new IDs; creates mapping file
3. **Dual-mode**: During transition period, support both bd and forge queries
4. **Mapping file**: `.forge/issue-id-mapping.json` maps old → new IDs; used in retroactive comment searches

**Post-Mitigation Status**: MEDIUM severity, critical for issue continuity

---

## H. Summary Table: Risk Prioritization

| ID | Category | Risk | Severity | Likelihood | Blocker | Key Mitigation |
|---|---|---|---|---|---|---|
| A1 | gh CLI | Not installed | CRITICAL | MEDIUM | YES | Hard gate, API fallback |
| A2 | gh CLI | Auth required | HIGH | MEDIUM | YES | Auth token detection, GHES support |
| A3 | gh CLI | Rate limits | MEDIUM | HIGH | NO | Caching, batch queries, backoff |
| A4 | gh CLI | Version drift | MEDIUM | MEDIUM | MAYBE | Version check, feature detection |
| B1 | Instructions | 60+ files sync | HIGH | HIGH | YES | Single source of truth, audit command |
| B2 | Instructions | bd references | HIGH | MEDIUM | YES | Search/replace, deprecation warnings |
| B3 | Instructions | Setup broken | HIGH | MEDIUM | YES | Dry-run, validation, checksums |
| C1 | Hooks | Only Claude Code | CRITICAL | CERTAIN | YES | Multi-layer defense, instruction-based |
| D1 | PR Creation | gh fails | HIGH | MEDIUM | YES | Idempotency, retry, detailed errors |
| E1 | Rebase | Auto-resolve fails | HIGH | MEDIUM | YES | Conflict detection, manual guidance |
| F1 | Cross-platform | Path handling | MEDIUM | HIGH | YES | Use node:path, normalize |
| F2 | Cross-platform | Shell quoting | MEDIUM | MEDIUM | YES | execFileSync arrays, shell-escape |
| G1 | Backward compat | Scripts call bd | MEDIUM | HIGH | YES | Script audit, rewrite, wrapper |
| G2 | Backward compat | Beads IDs | MEDIUM | HIGH | YES | ID aliasing, migration tool |

---

## I. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)
- [ ] A1-A2: gh CLI dependency checks (hard gates, auth validation)
- [ ] C1: Multi-layer hook enforcement (instruction-based, MCP-based)
- [ ] D1: PR idempotency, retry logic
- [ ] F1-F2: Cross-platform path/shell handling

### Phase 2: Migration (Weeks 3-4)
- [ ] B1-B3: Agent instruction sync, setup validation
- [ ] G1-G2: Backward compatibility layer (script migration, ID mapping)

### Phase 3: Reliability (Weeks 5-6)
- [ ] E1: Rebase error handling, conflict detection
- [ ] Testing on all platforms (Windows, macOS, Linux)

### Phase 4: Hardening (Weeks 7-8)
- [ ] Smoke tests for all 6 agents
- [ ] Failure mode testing (gh offline, auth expired, rate limited)
- [ ] Agent instruction audit (grep for bd/gh raw commands)

---

## J. Critical Blockers

**MUST RESOLVE before WS1 rollout**:
1. **C1**: Hooks don't work on 5/6 agents → multi-layer enforcement needed
2. **B1**: Agent instruction sync across 60+ files → single source of truth required
3. **A1-A2**: gh CLI dependency → hard gates and auth detection required
4. **G2**: Beads ID compatibility → MCP must alias old IDs

---

**Recommendation**: Delay WS1 rollout until blockers addressed. Minimum 6-8 weeks of hardening needed. Start with Claude Code only; validate approach before other 5 agents.
