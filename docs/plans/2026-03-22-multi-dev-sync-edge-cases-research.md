# Multi-Developer Sync Edge Cases — Research Findings

**Date**: 2026-03-22
**Purpose**: Concrete solutions for 8 edge cases in git-based JSONL issue tracking sync
**Constraints**: Git-native, bash scripts, no external services, offline-capable

---

## 1. Concurrent JSONL Sync Race Conditions

### Problem
Two developers run `bd sync` simultaneously, both modify `.beads/issues.jsonl`. Git merge fails on same-line edits.

### Recommended Solution: Custom Git Merge Driver + Per-Line Deduplication

**Concrete approach**: Register a custom git merge driver in `.gitattributes` that treats JSONL as a **set file** (each line is an independent record, order irrelevant, dedup by unique key).

```gitattributes
# .gitattributes
.beads/issues.jsonl merge=jsonl-set
.beads/file-index.jsonl merge=jsonl-set
```

```gitconfig
# .gitconfig (or repo .git/config)
[merge "jsonl-set"]
  name = JSONL set-based merge (dedup by ID)
  driver = scripts/git-merge-jsonl %O %A %B %L
```

**The merge driver script** (`scripts/git-merge-jsonl`):
1. Read all three files (ancestor `%O`, ours `%A`, theirs `%B`)
2. Parse each line as JSON, extract the unique key (e.g., `id` field)
3. For lines that exist in only one side: include them (append-only additions)
4. For lines modified on both sides (same `id`, different content): **last-writer-wins** using an embedded `updated_at` timestamp field
5. Write the merged result back to `%A` (git convention)
6. Exit 0 (success) or 1 (unresolvable conflict)

**Why this is best**:
- Zero-config for developers — git handles it transparently during pull/merge
- Works offline — no server needed
- Proven pattern: a3nm's blog documents this exact approach for log/set files, used in production for years
- Git's built-in `union` merge strategy is a simpler fallback (appends both sides, may create duplicates) but a custom driver with dedup-by-ID is more robust

**Alternative considered — CRDTs**: Overkill for this use case. CRDTs add 16-32 bytes metadata per entry and require a CRDT library. Our JSONL entries already have unique IDs and timestamps, which is sufficient for last-writer-wins resolution.

**Alternative considered — Per-developer files**: Each dev writes to `.beads/issues-{devid}.jsonl`. Eliminates conflicts entirely but complicates reads (must merge N files) and queries. Good fallback if the merge driver proves insufficient at scale.

**Real-world examples**:
- [a3nm's git-merge-set](https://a3nm.net/blog/git_auto_conflicts.html) — custom merge driver for set/log files
- [git-json-merge](https://github.com/jonatanpedersen/git-json-merge) — xdiff-based JSON merge driver
- [Beadbox/Dolt](https://beadbox.app) — cell-level three-way merge for issue tracking
- Git's built-in `merge=union` strategy in `.gitattributes`

**Complexity**: Moderate (custom merge driver script ~50-80 lines of bash/node)

---

## 2. TOCTOU in Conflict Detection

### Problem
Dev A checks for conflicts (clean), starts working. Dev B claims same module 5 seconds later. By commit time, Dev A's check is stale.

### Recommended Solution: Optimistic Concurrency Control with Re-validation at Commit

**Concrete approach**: Embed a **version vector** (or simple monotonic counter) per issue/claim in the JSONL. At commit time, re-validate:

```
1. Developer runs `bd claim <issue-id>`
2. Script does: git pull --rebase (get latest state)
3. Check if issue is already claimed → if yes, abort with message
4. Write claim with: { claimed_by, claimed_at, version: current_version + 1 }
5. git add + git commit + git push
6. If push fails (someone else pushed): git pull --rebase, re-check claim
7. If claim was taken during rebase: abort and notify developer
8. If clean: push succeeds, claim is atomic
```

**The key insight**: Git push is already an atomic compare-and-swap at the ref level. If the remote ref has moved since your last fetch, push fails. This is exactly optimistic concurrency control — git itself is the concurrency primitive.

**Additional safeguard — pre-commit hook**:
```bash
# .lefthook/pre-commit/check-beads-conflicts.sh
# Re-fetch and verify no conflicts before allowing commit
git fetch origin --quiet
# Compare local .beads/ state with origin
if git diff origin/master -- .beads/issues.jsonl | grep -q "claimed_by"; then
  echo "WARNING: .beads/ state has changed on remote. Run 'bd sync' first."
fi
```

**Why this is best**:
- Uses git's built-in atomicity — no external locking service needed
- Optimistic approach means no blocking — devs work freely, conflicts detected only at push time
- Wikipedia's OCC article confirms: "Before committing, each transaction verifies that no other transaction has modified the data it has read. If conflicting modifications found, the committing transaction rolls back and can be restarted."
- Works offline — checks happen at sync time, not during work

**Real-world examples**:
- Git itself uses OCC — push fails if remote has diverged
- Elasticsearch uses `_seq_no` + `_primary_term` for optimistic concurrency
- DynamoDB uses version numbers for optimistic locking

**Complexity**: Trivial (git push already does this; add a wrapper script ~20 lines)

---

## 3. Orphaned Claims / Session Crashes

### Problem
Claude Code session claims an issue, laptop crashes. Claim never released. Other devs see it as "claimed" indefinitely.

### Recommended Solution: Timestamp-Based Staleness with Configurable TTL

**Concrete approach**: Every claim includes a `claimed_at` ISO timestamp. A configurable TTL (default: 2 hours) determines staleness. No heartbeat needed.

```
Claim record:
{
  "id": "beads-42",
  "claimed_by": "harsha@laptop",
  "claimed_at": "2026-03-22T10:30:00Z",
  "ttl_minutes": 120
}

Staleness check (in bd sync / bd status):
  current_time - claimed_at > ttl_minutes → mark as stale
  Stale claims shown with warning: "Claimed by harsha@laptop 3h ago (STALE)"
  Any developer can reclaim stale issues: `bd claim --force <issue-id>`
```

**Optional enhancement — activity-based freshness**: Instead of (or in addition to) a fixed TTL, check git log for recent commits by the claiming developer on files related to the issue. If the developer has committed in the last N minutes, the claim is "active" regardless of TTL.

```bash
# Check if claimer has recent activity
last_commit=$(git log -1 --format=%ct --author="$claimer" -- "$related_files")
now=$(date +%s)
idle_seconds=$((now - last_commit))
if [ $idle_seconds -lt $((ttl_minutes * 60)) ]; then
  echo "Claim is active (last commit ${idle_seconds}s ago)"
fi
```

**Why this is best**:
- No server, no heartbeat daemon, no background process
- Works offline — staleness is evaluated at read time by whoever queries
- Simple to understand and debug
- Martin Fowler's "HeartBeat" pattern acknowledges that for non-real-time systems, periodic checking (pull-based) is simpler than continuous heartbeats (push-based)
- Consul/HashiCorp uses session TTLs for exactly this purpose in their distributed lock system

**Real-world examples**:
- Consul sessions: TTL-based invalidation for distributed locks
- Redis locks: `SET key value EX ttl NX` — expire-based lock release
- Git LFS file locking: advisory locks with server-side staleness detection

**Complexity**: Trivial (timestamp comparison, ~15 lines of bash)

---

## 4. Large Team Scale (10-15 Concurrent Sessions)

### Problem
File index grows large, sync becomes slow, conflict detection has too many false positives at module level.

### Recommended Solution: Hierarchical Module Granularity + Index Partitioning

**Concrete approach — three-tier strategy**:

#### A. Finer-grained conflict zones (reduce false positives)
Instead of module-level conflict detection (e.g., "src/commands/"), use **file-level** tracking:

```jsonl
{"file":"src/commands/plan.ts","claimed_by":"dev-a","claimed_at":"..."}
{"file":"src/commands/dev.ts","claimed_by":"dev-b","claimed_at":"..."}
```

Two developers working on different files in the same directory no longer conflict.

#### B. Index partitioning (reduce sync size)
Split the monolithic `file-index.jsonl` into per-directory index files:

```
.beads/
  issues.jsonl           # All issues (small, rarely conflicts)
  file-index/
    src-commands.jsonl    # File claims for src/commands/
    src-lib.jsonl         # File claims for src/lib/
    tests.jsonl           # File claims for tests/
```

Benefits:
- Git merges operate on smaller files
- Developers working on unrelated areas never touch the same index file
- Custom merge driver handles each partition independently

#### C. Periodic compaction (keep index lean)
```bash
# bd gc — garbage collect completed/stale claims
# Remove claims older than 7 days with status=completed
# Remove stale claims older than 24 hours
jq -c 'select(.status != "completed" or (now - (.completed_at | fromdateiso8601) < 604800))' \
  .beads/file-index.jsonl > .beads/file-index.jsonl.tmp
mv .beads/file-index.jsonl.tmp .beads/file-index.jsonl
```

**Why Bloom filters are NOT recommended**: Bloom filters are probabilistic — they have false positives by design. For conflict detection, false positives mean "you might have a conflict when you don't," which is the exact problem we're trying to reduce. Deterministic file-level tracking is better.

**Why this is best**:
- File-level granularity eliminates most false positives
- Partitioning keeps individual files small
- Compaction prevents unbounded growth
- All git-native, no external services

**Real-world examples**:
- Salesforce CI/CD tools use file-level change tracking to avoid conflicts
- Large monorepos (Google, Meta) use path-based ownership (CODEOWNERS) for conflict prevention

**Complexity**: Moderate (partitioning logic ~100 lines; compaction ~30 lines)

---

## 5. Cross-Platform Hostname/Identity Issues

### Problem
`hostname -s` behaves differently across Windows Git Bash, WSL, macOS, and Linux. Identity format inconsistencies break claim matching.

### Recommended Solution: Use `git config user.name` + Normalized Machine ID

**Concrete approach**: Don't use hostname at all for identity. Use git's own identity system plus a stable machine fingerprint:

```bash
get_developer_identity() {
  # Primary: git user identity (consistent across platforms)
  local git_user
  git_user=$(git config user.name 2>/dev/null || echo "unknown")

  # Secondary: stable machine ID (for multi-session disambiguation)
  local machine_id
  case "${OSTYPE:-$(uname -s | tr '[:upper:]' '[:lower:]')}" in
    linux*|linux-gnu*)
      # Linux: use machine-id (stable across reboots)
      machine_id=$(cat /etc/machine-id 2>/dev/null | head -c 8)
      ;;
    darwin*)
      # macOS: use hardware UUID
      machine_id=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}' | head -c 8)
      ;;
    msys*|mingw*|cygwin*)
      # Windows Git Bash: use COMPUTERNAME (always set)
      machine_id=$(echo "${COMPUTERNAME:-$(hostname)}" | tr '[:upper:]' '[:lower:]' | head -c 8)
      ;;
    *)
      # WSL or unknown: check for WSL first
      if grep -qi microsoft /proc/version 2>/dev/null; then
        machine_id=$(cat /etc/machine-id 2>/dev/null | head -c 8)
      else
        machine_id=$(hostname | tr '[:upper:]' '[:lower:]' | head -c 8)
      fi
      ;;
  esac

  # Session ID: PID of the parent shell (disambiguates multiple sessions)
  local session_id="$$"

  echo "${git_user}@${machine_id}:${session_id}"
}
# Output example: "harsha@a1b2c3d4:12345"
```

**Why this is best**:
- `git config user.name` is the one identity guaranteed to exist in any git environment
- `$OSTYPE` is a bash built-in (no subprocess, fastest check) — neofetch project recommends this over `$(uname)`
- `COMPUTERNAME` is always set on Windows (even in Git Bash/MSYS2)
- `/etc/machine-id` is standardized on systemd Linux systems (stable across reboots)
- Session PID disambiguates multiple parallel sessions on the same machine
- Truncated to 8 chars for readability

**Why NOT hostname**: `hostname -s` is not POSIX. On Windows Git Bash it returns the MSYS hostname, not the Windows hostname. On some Docker containers, hostname is random. On WSL, it may return the Windows hostname or the WSL hostname depending on WSL version.

**Real-world examples**:
- Neofetch uses `$OSTYPE` for OS detection (GitHub issue #433)
- Git's own `config.mak.uname` uses `uname -s` with case matching for build system
- systemd's `/etc/machine-id` is the standard stable machine identifier on Linux

**Complexity**: Trivial (identity function ~25 lines, called once per session)

---

## 6. Network Partitions / Partial Sync

### Problem
Dev syncs, network drops mid-transfer. JSONL file is truncated or corrupted.

### Recommended Solution: Line-Level Validation + Atomic Write Pattern

**Concrete approach — three layers of defense**:

#### A. Post-sync JSONL validation
After every `git pull`, validate the JSONL file line by line:

```bash
validate_jsonl() {
  local file="$1"
  local line_num=0
  local errors=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    if [ -z "$line" ]; then continue; fi  # skip blank lines
    if ! echo "$line" | jq empty 2>/dev/null; then
      echo "ERROR: Invalid JSON at line $line_num: $line"
      errors=$((errors + 1))
    fi
  done < "$file"
  return $errors
}
```

#### B. Truncation detection
Check for common truncation indicators:
```bash
detect_truncation() {
  local file="$1"
  # Check 1: File ends with incomplete JSON (no closing brace)
  local last_char
  last_char=$(tail -c 1 "$file")
  if [ "$last_char" != "}" ] && [ "$last_char" != $'\n' ]; then
    echo "WARNING: File may be truncated (last char: '$last_char')"
    return 1
  fi
  # Check 2: Last line is valid JSON
  local last_line
  last_line=$(tail -1 "$file")
  if ! echo "$last_line" | jq empty 2>/dev/null; then
    echo "WARNING: Last line is invalid JSON — likely truncated"
    return 1
  fi
  return 0
}
```

#### C. Recovery strategy
```bash
recover_jsonl() {
  local file="$1"
  # Strategy 1: Remove only the corrupted last line (truncation)
  local total_lines
  total_lines=$(wc -l < "$file")
  head -n $((total_lines - 1)) "$file" > "${file}.recovered"
  if validate_jsonl "${file}.recovered"; then
    mv "${file}.recovered" "$file"
    echo "Recovered: removed truncated last line"
    return 0
  fi
  # Strategy 2: Keep only valid lines
  local tmp="${file}.clean"
  > "$tmp"
  while IFS= read -r line; do
    if echo "$line" | jq empty 2>/dev/null; then
      echo "$line" >> "$tmp"
    fi
  done < "$file"
  mv "$tmp" "$file"
  echo "Recovered: kept $(wc -l < "$file") valid lines, discarded corrupted"
}
```

**Why this is best**:
- JSONL's line-per-record format is inherently resilient — corruption affects at most one record
- Git itself provides protection: `git fsck` detects object corruption, and partial transfers leave the repo in a consistent state (git uses atomic ref updates)
- The real risk is not git corruption (git handles this) but application-level write interruption during `bd sync`'s JSONL manipulation
- Validation is cheap (jq per line) and can run as a post-merge hook

**Additional safeguard — git post-merge hook**:
```bash
# .git/hooks/post-merge
for f in .beads/*.jsonl; do
  if ! validate_jsonl "$f"; then
    echo "WARNING: $f has invalid lines after merge. Run 'bd repair' to fix."
  fi
done
```

**Real-world examples**:
- Apache Kafka uses segment-based logs with CRC checksums per record
- SQLite uses write-ahead logs with checksums for crash recovery
- JSONL validators (jsonltools.com) validate line-by-line

**Complexity**: Moderate (validation ~30 lines, recovery ~40 lines, hook setup ~10 lines)

---

## 7. Branch Protection vs Beads Sync

### Problem
Repos with strict branch protection (require PR, require reviews) prevent `bd sync` from pushing directly to the protected branch.

### Recommended Solution: Dedicated `beads/sync` Branch + GitHub App Bypass (Two Options)

#### Option A: Dedicated sync branch (simplest, works everywhere)

```bash
# bd sync uses a dedicated unprotected branch
BEADS_SYNC_BRANCH="beads/sync"

bd_sync() {
  # Push beads changes to dedicated branch
  git push origin HEAD:refs/heads/$BEADS_SYNC_BRANCH

  # On the receiving end, developers pull from this branch:
  git fetch origin $BEADS_SYNC_BRANCH
  git checkout origin/$BEADS_SYNC_BRANCH -- .beads/
}
```

The `beads/sync` branch is never protected — it only contains .beads/ metadata. Developers fetch from it to get the latest issue state.

#### Option B: GitHub Rulesets with path-based bypass (GitHub-specific)

Use GitHub's modern **rulesets** (not legacy branch protection) which support file path restrictions:

1. Create a **push ruleset** for the `main`/`master` branch
2. Add the rule "Require a pull request before merging"
3. In the bypass list, add a **GitHub App** (e.g., "Beads Sync Bot") or specific team
4. The App gets a short-lived token via `actions/create-github-app-token` to push .beads/ changes

**Important limitation**: GitHub rulesets' "Restrict file paths" rule **blocks** pushes to specified paths — it cannot **allow** specific paths while blocking others in the same rule. The bypass must be actor-based (specific App or team), not path-based.

#### Option C: Orphan branch (git-native, no GitHub features needed)

```bash
# Create an orphan branch for beads metadata
git checkout --orphan beads-meta
git rm -rf .
# Copy only .beads/ content
cp -r .beads/ .
git add .beads/
git commit -m "beads: initial metadata"
git push origin beads-meta
```

The `beads-meta` orphan branch has completely independent history from code branches. Branch protection on `main` has zero effect on it. Developers sync metadata by:
```bash
git fetch origin beads-meta
git checkout origin/beads-meta -- .beads/
```

**Why Option A/C are best for our constraints**:
- No GitHub-specific features required — works on GitLab, Bitbucket, self-hosted
- No App registration or token management
- Works offline — sync branch is just another git branch
- Option C (orphan) is cleanest: complete separation of metadata and code history

**Real-world examples**:
- `gh-pages` orphan branch pattern — used by GitHub Pages for years
- Terraform state in dedicated branches
- GitHub's own recommendation: use rulesets + bypass lists for automation

**Complexity**: Trivial (Option A: ~10 lines wrapper) / Moderate (Option C: initial setup + sync scripts ~50 lines)

---

## 8. Git Flow Compatibility

### Problem
Teams using git flow have `develop`, `release/*`, `hotfix/*` branches. Which branch should beads sync to? What if develop and main diverge on .beads/ state?

### Recommended Solution: Single Canonical Beads Branch, Independent of Git Flow

**Concrete approach**: Beads metadata syncs to ONE branch, regardless of git flow structure. This branch is configurable:

```bash
# .beads/config
BEADS_SYNC_BRANCH="beads/sync"  # Default: dedicated branch
# Or: "develop" for teams that want it on develop
# Or: "main" for trunk-based teams
```

**Why a dedicated branch (not develop or main)**:

| Strategy | Pros | Cons |
|----------|------|------|
| Sync to `develop` | Natural for git flow | Blocked during release freezes; diverges from main |
| Sync to `main` | Single source of truth | Branch protection may block; git flow treats main as release-only |
| Sync to `beads/sync` | Always available; no protection issues; no divergence | Extra branch to manage; developers must fetch from it |

**The divergence problem and solution**:
If beads syncs to `develop`, and `develop` is ahead of `main` (normal in git flow), then:
- Developers on `hotfix/*` branches (branched from `main`) see stale beads state
- Release branches may carry stale beads state

Solution: The dedicated `beads/sync` branch is always the canonical source. All branches fetch beads state from it:

```bash
# In any branch, get latest beads state:
bd_refresh() {
  git fetch origin beads/sync --quiet
  git checkout origin/beads/sync -- .beads/ 2>/dev/null
  echo "Beads state refreshed from beads/sync"
}
```

**Integration with bd sync**:
```bash
bd_sync() {
  local sync_branch
  sync_branch=$(git config --get beads.syncBranch 2>/dev/null || echo "beads/sync")

  # 1. Fetch latest beads state
  git fetch origin "$sync_branch" --quiet

  # 2. Three-way merge our .beads/ with remote .beads/
  # (uses the custom JSONL merge driver from Edge Case #1)
  git checkout origin/"$sync_branch" -- .beads/ 2>/dev/null
  # ... merge logic ...

  # 3. Push back to sync branch
  git push origin HEAD:.beads-temp
  # Or use the sync branch directly if we have push access
}
```

**Why this is best**:
- Completely decouples issue tracking from code branching strategy
- Works with git flow, GitHub flow, trunk-based, or any other model
- No divergence problem — single canonical branch
- Configurable for teams that prefer simpler setups (just set `beads.syncBranch=develop`)

**Real-world examples**:
- Fossil SCM's autosync operates independently of branching
- `gh-pages` branch is independent of development branches
- Terraform remote state is branch-independent

**Complexity**: Trivial (config option + fetch/checkout wrapper ~30 lines)

---

## Summary Matrix

| Edge Case | Solution | Complexity | Key Mechanism |
|-----------|----------|------------|---------------|
| 1. Concurrent JSONL sync | Custom git merge driver (dedup by ID) | Moderate | `.gitattributes` + merge script |
| 2. TOCTOU conflict detection | Git push as atomic CAS + re-validate | Trivial | OCC via git's own ref atomicity |
| 3. Orphaned claims | Timestamp-based TTL + git log activity check | Trivial | `claimed_at` + configurable TTL |
| 4. Large team scale | File-level granularity + index partitioning | Moderate | Per-directory JSONL files |
| 5. Cross-platform identity | `git config user.name` + OS-specific machine ID | Trivial | `$OSTYPE` switch + stable IDs |
| 6. Network partitions | Line-level JSONL validation + recovery | Moderate | Post-merge hook + jq validation |
| 7. Branch protection | Dedicated `beads/sync` branch or orphan branch | Trivial | Separate unprotected branch |
| 8. Git flow compat | Single canonical beads branch, configurable | Trivial | `beads.syncBranch` git config |

## Architecture Decision: Dedicated Beads Branch

Edge cases 7 and 8 both converge on the same solution: **a dedicated branch for beads metadata sync**. This is the single most impactful architectural decision, as it:
- Eliminates branch protection conflicts (#7)
- Eliminates git flow divergence (#8)
- Simplifies the merge driver (#1) — only beads content on this branch
- Makes staleness detection easier (#3) — clear commit history per developer

**Recommended default**: `beads/sync` branch (not an orphan — easier to set up and understand).

---

## Sources

### Edge Case 1 — Concurrent JSONL Sync
- [Automatic git conflict resolution on logs and sets (a3nm)](https://a3nm.net/blog/git_auto_conflicts.html)
- [git-json-merge — xdiff-based JSON merge driver](https://github.com/jonatanpedersen/git-json-merge)
- [A Conflict-Free Replicated JSON Datatype (arxiv)](https://arxiv.org/pdf/1608.03960)
- [CRDT Implementations](https://crdt.tech/implementations)
- [Linear Alternatives: Local-First Issue Tracking (Beadbox)](https://beadbox.app/en/blog/linear-alternatives-local-first-issue-tracking)

### Edge Case 2 — TOCTOU
- [Optimistic Concurrency Control (Wikipedia)](https://en.wikipedia.org/wiki/Optimistic_concurrency_control)
- [TOCTOU Race Condition (CWE-367)](https://cwe.mitre.org/data/definitions/367.html)
- [Optimistic Locking (eugene-eeo)](https://eugene-eeo.github.io/blog/optlock.html)

### Edge Case 3 — Orphaned Claims
- [Heartbeats in Distributed Systems (Arpit Bhayani)](https://arpitbhayani.me/blogs/heartbeats-in-distributed-systems/)
- [HeartBeat Pattern (Martin Fowler)](https://martinfowler.com/articles/patterns-of-distributed-systems/heartbeat.html)
- [Sessions and Distributed Locks (Consul/HashiCorp)](https://developer.hashicorp.com/consul/docs/dynamic-app-config/sessions)

### Edge Case 4 — Scale
- [Bloom Filters in System Design (GeeksforGeeks)](https://www.geeksforgeeks.org/bloom-filters-in-system-design/)
- [Scaling Hardware Design with Git](https://www.wevolver.com/article/scaling-hardware-design-with-git-strategies-for-large-team-management)

### Edge Case 5 — Cross-Platform Identity
- [Cross-Platform Bash Snippet for Linux, WSL, Cygwin, MSYS, GitBash](https://gist.github.com/mikeslattery/5c60655478f76e26b9232aedc664eb7d)
- [Bash OS Detection (neofetch $OSTYPE recommendation)](https://github.com/dylanaraps/neofetch/issues/433)
- [Git's config.mak.uname platform detection](https://github.com/git/git/blob/master/config.mak.uname)

### Edge Case 6 — Network Partitions
- [JSONL Validator](https://jsonltools.com/jsonl-validator)
- [File Integrity Verification (TechTarget)](https://www.techtarget.com/searchcontentmanagement/tip/How-to-check-and-verify-file-integrity)

### Edge Case 7 — Branch Protection
- [Available Rules for Rulesets (GitHub Docs)](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub Actions Push to Protected Branch (Ninjaneers)](https://medium.com/ninjaneers/letting-github-actions-push-to-protected-branches-a-how-to-57096876850d)
- [GitHub Rulesets with Push Rules (GitHub Changelog)](https://github.blog/changelog/2024-09-10-push-rules-are-now-generally-available-and-updates-to-custom-properties/)

### Edge Case 8 — Git Flow Compatibility
- [Gitflow Workflow (Atlassian)](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow)
- [Git Orphan Branches (Graphite)](https://graphite.com/guides/git-orphan-branches)
- [Fossil SCM Autosync](https://fossil-scm.org/home/doc/tip/www/fossil-v-git.wiki)
- [Git LFS Locking Proposal](https://github.com/git-lfs/git-lfs/blob/main/docs/proposals/locking.md)
