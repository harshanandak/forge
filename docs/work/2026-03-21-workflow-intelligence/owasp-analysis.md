# OWASP Top 10 Analysis: Workflow Intelligence Epic

**Date**: 2026-03-21
**Scope**: smart-status.sh, /plan command modifications, forge-validate rename, conflict detection via git diff

---

## A01:2021 — Broken Access Control

**Applies**: No
**Rationale**: All components are local CLI tools. No authentication, authorization, or multi-user access model exists. The script runs with the invoking user's OS permissions. No elevation or privilege boundary is crossed.

---

## A02:2021 — Cryptographic Failures

**Applies**: No
**Rationale**: No secrets, credentials, tokens, or sensitive data are processed, stored, or transmitted. The script reads git metadata and Beads issue JSON — all local, non-sensitive data.

---

## A03:2021 — Injection

**Applies**: YES — PRIMARY RISK

### Risk 1: Shell injection via `bd` / `git` output parsed by smart-status.sh

`bd list`, `bd show --json`, and `git diff` produce output that includes user-authored content (issue titles, branch names, commit messages). If this output is interpolated into shell commands without sanitization, an attacker-crafted issue title like `$(rm -rf /)` or backtick-wrapped commands (e.g., `` `malicious` ``) could execute arbitrary commands.

**Specific vectors in smart-status.sh**:
- Parsing `bd show --json` output: issue titles, descriptions, and notes fields contain free-text user input.
- Parsing `git diff` output: file paths from diff could contain shell metacharacters (rare but possible on some filesystems).
- Parsing `git worktree list` output: worktree paths with spaces or special characters.

### Risk 2: Argument injection via branch names in git diff

If smart-status.sh runs `git diff <branch1>..<branch2>` where branch names come from user input or `bd` metadata, a crafted branch name like `--output=/etc/cron.d/evil` could inject git flags.

### Mitigations (ALL required — apply collectively, not as alternatives):

1. **Reuse the `sanitize()` function** from `beads-context.sh` (line 38-54) and `dep-guard.sh`. Both scripts already have an identical, tested sanitization function that strips `$(...)`, backticks, semicolons, double quotes, and newlines. Copy it into smart-status.sh or source a shared helper.

2. **Quote ALL variable expansions** — use `"$var"` everywhere, no exceptions. The existing scripts demonstrate this well. smart-status.sh must follow the same pattern.

3. **Use `--` separator** for all git commands that accept user-derived arguments. Place `--` AFTER revisions/flags but BEFORE pathspecs:
   ```bash
   git diff "$branch1".."$branch2" -- "$file_path"
   git log --oneline "$branch" -- "$file_path"
   ```

4. **Prefer `jq` for JSON parsing** over grep/sed, with grep as fallback only. The existing `dep-guard.sh` already uses `jq` with fallback grep patterns. jq naturally isolates data without shell interpretation.

5. **Use `set -euo pipefail`** at script top (both existing scripts do this).

6. **Use `printf '%s'`** instead of `echo` for untrusted data (prevents `-e`/`-n` flag interpretation).

---

## A04:2021 — Insecure Design

**Applies**: Low risk

**Risk**: The ranking/scoring algorithm in smart-status.sh computes priority scores from Beads metadata. If the scoring logic is transparent and predictable, an AI agent could craft issue metadata to game priority rankings. This is a low-severity design concern for a local dev tool.

**Mitigation**: Document the scoring algorithm. Since this is a developer productivity tool (not a security boundary), no hardening needed beyond ensuring scores are computed from read-only git/beads data, never from external input.

---

## A05:2021 — Security Misconfiguration

**Applies**: Low risk

**Risk**: The forge-validate to forge-preflight rename touches `package.json` `bin` entries and filesystem scripts. If the rename is incomplete (old binary name still works, or old path still referenced), it could cause confusion but not a security vulnerability per se.

**Mitigation**: The blast-radius search (required by /plan Phase 2) should catch all references. Ensure `package.json` `bin.forge-validate` is removed, not just duplicated.

---

## A06:2021 — Vulnerable and Outdated Components

**Applies**: Low risk
**Rationale**: `smart-status.sh` is a bash script that uses standard Unix utilities plus the third-party tool `jq` (for JSON parsing). `jq` should be kept up to date but has a stable, well-audited codebase. The Node.js binary (`forge-preflight.js`, referenced in `forge-validate.js`) relies only on Node built-ins (`node:child_process`, `node:fs`) with `execFileSync` (injection-safe by design).

---

## A07:2021 — Identification and Authentication Failures

**Applies**: No
**Rationale**: No authentication mechanism exists. This is a local CLI tool.

---

## A08:2021 — Software and Data Integrity Failures

**Applies**: Low risk

**Risk**: smart-status.sh trusts the output of `bd show --json` and `git` commands implicitly. If the `.beads/issues.jsonl` file were tampered with (e.g., via a malicious PR), the script would process corrupted data. Similarly, conflict detection via `git diff` trusts git's integrity model.

**Mitigation**: Git's content-addressable storage provides integrity for diff output. For Beads data, the existing lefthook pre-push hooks and branch protection provide adequate safeguards. No additional mitigation needed for a local dev tool.

---

## A09:2021 — Security Logging and Monitoring Failures

**Applies**: No
**Rationale**: This is a local developer tool, not a production service. No logging or monitoring infrastructure is expected. The script outputs to terminal only.

---

## A10:2021 — Server-Side Request Forgery (SSRF)

**Applies**: No
**Rationale**: No HTTP requests, network calls, or URL handling occurs in any of the affected components. All operations are local filesystem and git operations.

---

## Summary

| Category | Applies | Severity | Action Required |
|----------|---------|----------|-----------------|
| A01 Broken Access Control | No | N/A | None |
| A02 Cryptographic Failures | No | N/A | None |
| **A03 Injection** | **YES** | **Medium** | **All required: reuse sanitize(), quote all vars, use `--` separator after revisions, prefer jq with grep fallback, set -euo pipefail, printf for untrusted data** |
| A04 Insecure Design | Low | Low | Document scoring algorithm |
| A05 Security Misconfiguration | Low | Low | Complete blast-radius for rename |
| A06 Vulnerable Components | Low | Low | Keep jq up to date |
| A07 Auth Failures | No | N/A | None |
| A08 Data Integrity | Low | Low | Rely on git integrity + lefthook |
| A09 Logging | No | N/A | None |
| A10 SSRF | No | N/A | None |

## Key Recommendation

The `sanitize()` function is duplicated identically in both `beads-context.sh` (line 38) and `dep-guard.sh`. For smart-status.sh, either:

1. **Copy the function again** (simplest, matches existing pattern), or
2. **Extract to a shared `scripts/lib/sanitize.sh`** and source it from all three scripts (cleaner but adds a dependency).

Option 1 is recommended given the existing codebase convention of self-contained scripts.
