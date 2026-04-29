# Multi-Developer Session Awareness — Research Summary

**Date:** 2026-03-22
**Purpose:** Research-only — no code written. Findings to inform design of multi-developer session awareness in a git-based issue tracker (Beads/JSONL).

---

## 1. Git Multi-Developer Conflict Detection Best Practices

### Key Patterns
- **Feature branch isolation** is the primary prevention strategy — each developer/agent works on an isolated branch, merging via PR.
- **Regular integration sessions** reduced conflicts by 50% in enterprise case studies.
- **Small, self-contained commits** make conflicts easier to identify and resolve.
- **`git merge-tree`** performs merge entirely in memory without affecting working directory or index — ideal for scripted conflict prediction without side effects.
- **`git merge --no-commit --no-ff`** is the simpler dry-run approach but modifies the index temporarily.

### Pitfalls
- Stale feature branches cause 75% of enterprise merge conflicts.
- Tools that hardcode branch names (e.g., looking for "main" or "master") instead of checking remote HEAD fail on renamed defaults.

### Applicability
- `git merge-tree` is the best fit for our bash-script approach: no side effects, no external services, scriptable output parsing.
- Overlap detection via `git diff --name-only branch1...branch2` gives file-level overlap cheaply.

**Sources:**
- [DevGex: Conflict Detection Dry-Run](https://devgex.com/en/article/00017592)
- [DEV Community: Navigating Git Conflicts](https://dev.to/code_heisenberg/navigating-git-conflicts-best-practices-to-prevent-code-loss-in-development-teams-3h6g)
- [Atlassian: Merge Conflicts](https://www.atlassian.com/git/tutorials/using-branches/merge-conflicts)

---

## 2. JSONL File Merge Strategies for Git

### Key Patterns
- **Append-only JSONL** is naturally merge-friendly: each line is independent, so concurrent appends to different lines rarely conflict.
- **Custom git merge drivers** (e.g., `git-json-merge`) use structural 3-way merge with xdiff instead of line-by-line comparison.
- **CRDT-based approaches** preserve all concurrent updates via multi-value registers rather than discarding one edit.
- **Last-Write-Wins (LWW)** uses timestamps — simplest but loses data (Bob's increment erased if Alice's timestamp is later).

### JSONL-Specific Strategies (for Beads `issues.jsonl`)
- **Append-only with dedup:** Each issue gets a unique ID. On merge, if two branches add lines with the same ID, a post-merge dedup script keeps the one with the latest `updated_at` timestamp (LWW per record).
- **Tombstone pattern** already in use: deleted issues get `"status":"tombstone"` with `deleted_at` — this is CRDT-compatible (delete wins over update if timestamps agree).
- **Line-per-record format** means git's default merge handles most cases (non-overlapping appends auto-merge).

### Pitfalls
- Git's default merge breaks on same-line edits (e.g., two devs update the same issue simultaneously).
- JSON structural awareness is lost in line-based diff — custom merge driver needed only if same-record conflicts are common.
- LWW requires synchronized clocks; in practice, local timestamps are sufficient for single-team use.

### Applicability
- Our JSONL format (one issue per line, unique IDs, timestamps) is well-suited for append-only + LWW-per-record resolution.
- A lightweight bash post-merge hook can dedup by ID, keeping latest `updated_at`.
- No need for full CRDT complexity unless we support offline branches merging weeks of divergent edits.

**Sources:**
- [DZone: LWW vs CRDTs](https://dzone.com/articles/conflict-resolution-using-last-write-wins-vs-crdts)
- [git-json-merge on GitHub](https://github.com/jonatanpedersen/git-json-merge)
- [Martin Kleppmann: JSON CRDT](https://martin.kleppmann.com/2017/04/24/json-crdt.html)
- [CRDT Dictionary](https://www.iankduncan.com/engineering/2025-11-27-crdt-dictionary/)

---

## 3. Git Worktree Multi-User Coordination Patterns

### Key Patterns
- **Worktree-per-agent/developer** is the emerging standard: each gets its own workspace, branch, staging area — no file-level collisions possible.
- **Shared git object database:** All worktrees share the same `.git` directory — cheap on disk, but means lock contention on `index.lock` and ref updates.
- **Specialized agent roles** (Architect, Builder, Validator) with shared planning documents for coordination.
- **Emerging tooling:** `ccswarm` (Claude Code multi-agent orchestration), `agentree`, `worktree-cli` with MCP integration.

### Pitfalls
- **Worktree confusion:** Easy to make changes in the wrong worktree — need clear naming conventions.
- **Shared state race conditions:** Database files (like SQLite), Docker state, cache dirs are NOT isolated between worktrees.
- **Regular pruning needed:** `git worktree prune` to clean up stale worktrees.
- **Same branch restriction:** Two worktrees cannot check out the same branch simultaneously.

### Applicability
- Forge already uses `.worktrees/<slug>` pattern (confirmed: 3 active worktrees in this repo).
- Beads SQLite (`beads.db`) is in the main `.beads/` directory — shared across worktrees. This is a potential race condition point.
- Session awareness should detect active worktrees via `git worktree list` and warn about file overlaps.

**Sources:**
- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [ccswarm: Multi-agent orchestration](https://github.com/nwiizo/ccswarm)
- [Vibehackers: Worktrees Multi-Agent Development](https://vibehackers.io/blog/git-worktrees-multi-agent-development)
- [Nick Mitchinson: Worktrees for Multi-Feature Development](https://www.nrmitchi.com/2025/10/using-git-worktrees-for-multi-feature-development-with-ai-agents/)

---

## 4. Detecting Overlapping File Changes Across Branches

### Key Patterns
- **`git diff --name-only branch1...branch2`** — lists files changed in branch2 since it diverged from branch1. Comparing two feature branches requires finding their common ancestor with main.
- **`git diff --name-status`** — adds change type (Added/Modified/Deleted) to each file.
- **Cross-branch overlap detection algorithm:**
  1. For each active worktree/branch, get changed files: `git diff --name-only $(git merge-base main feat/X)..feat/X`
  2. Compute set intersection across all branch file lists
  3. Files appearing in 2+ branches are "overlap candidates"
- **`git merge-tree`** — goes deeper than file-level: detects line-level conflicts without touching working directory.
- **GitKraken's conflict prevention** scans branch against target to identify overlapping changes before PR — conceptually what we want in CLI form.

### Pitfalls
- File-level overlap != actual conflict (two branches can modify different parts of the same file without conflicting).
- Line-level detection via `merge-tree` is more accurate but more expensive.
- Rename detection (`-M` flag) needed to catch files that were renamed in one branch.

### Applicability
- **Two-tier detection recommended:**
  1. **Fast/cheap:** File-level overlap via `git diff --name-only` (run on every `/status`)
  2. **Deep/expensive:** Line-level conflict prediction via `git merge-tree` (run on-demand or pre-merge)
- Both are pure git commands — no external services, works in bash scripts.

**Sources:**
- [GitHub TIL: List Changed Files Between Branches](https://github.com/jbranchaud/til/blob/master/git/list-all-files-changed-between-two-branches.md)
- [KodeKloud: Git Diff Between Branches](https://kodekloud.com/blog/git-diff-how-to-compare-files-between-two-branches/)
- [Git Merge-Tree Documentation](https://git-scm.com/docs/git-merge-tree)

---

## 5. Beads Issue Tracker Sync & Branch Patterns

### Key Patterns
- **Beads architecture:** SQLite locally → JSONL export → git commit/push for distribution.
- **Sync branch (legacy):** Older versions used a `beads-sync` branch via git worktree. This has been replaced by Dolt refs (`refs/dolt/data`).
- **Current JSONL format (confirmed from repo):**
  - `.beads/issues.jsonl` — one JSON object per line, each with: `id`, `title`, `status`, `priority`, `issue_type`, `owner`, `created_at`, `updated_at`, `notes`, `comments[]`, `dependencies[]`
  - `.beads/interactions.jsonl` — separate file for interaction tracking
  - `.beads/metadata.json` — repo-level metadata
  - `.beads/config.yaml` — configuration
  - `.beads/beads.db` — SQLite (primary data store, gitignored except for JSONL export)
- **Tombstone pattern:** Deleted issues set `"status":"tombstone"` with `deleted_at`, `deleted_by`, `delete_reason` — preserves history.

### Pitfalls
- SQLite WAL files (`beads.db-shm`, `beads.db-wal`) must never be committed — they're transient.
- Multiple worktrees sharing the same `.beads/beads.db` can cause SQLite locking issues.
- JSONL is the git-portable format; SQLite is the fast local format. They can diverge if `bd sync` isn't run.

### Applicability
- Session awareness should track which developer/agent is modifying which issues (by `owner` field or active worktree branch).
- JSONL append-only nature means multi-developer writes to `issues.jsonl` are mostly safe if different issues are being edited.
- Same-issue conflicts need LWW resolution by `updated_at` timestamp.

**Sources:**
- [Beads GitHub: FAQ](https://github.com/steveyegge/beads/blob/main/docs/FAQ.md)
- [Beads GitHub: Worktrees](https://github.com/steveyegge/beads/blob/main/docs/WORKTREES.md)
- [Beads GitHub: Protected Branches](https://github.com/steveyegge/beads/blob/main/docs/PROTECTED_BRANCHES.md)
- [Better Stack: Beads Guide](https://betterstack.com/community/guides/ai/beads-issue-tracker-ai-agents/)

---

## 6. Developer Session Tracking — Git-Native Approaches

### Key Patterns
- **Git Hours** (Node.js CLI): Groups commits into "sessions" based on time gaps between commits. Foundational approach.
- **Git Notes** (`refs/notes/`): Attach metadata to commits without changing SHA hashes. Per-commit annotations stored as blobs, namespaced (e.g., `refs/notes/sessions`, `refs/notes/reviews`). Scriptable, shared via `git push origin refs/notes/*`.
- **Memento** (git extension): Attaches AI session transcripts to commits as git notes — provenance chain from commit to reasoning.
- **Git AI**: Tracks AI-generated code, links every AI-written line to agent/model/prompts via git notes stored locally or in cloud.
- **Commit message conventions:** "The session is the commit message" — encode session metadata (start time, duration, agent ID) directly in commit messages or trailers.

### Pitfalls
- Git notes are NOT fetched by default — require explicit `git fetch origin refs/notes/*:refs/notes/*`.
- Git notes merge conflicts are possible if two developers annotate the same commit.
- `$HOSTNAME` and timestamp-based session IDs assume no clock skew — fine for single-team use.
- Overly detailed session tracking creates noise; focus on actionable metadata (who, what branch, what files).

### Applicability
- **Lightweight session file** (e.g., `.beads/sessions/<hostname>-<pid>.json`) is simpler than git notes for our use case.
- Session file contains: hostname, user, branch, worktree path, PID, start time, last heartbeat, active issue IDs.
- Stale session detection: if `last_heartbeat` is older than threshold (e.g., 5 minutes), session is considered dead.
- Git notes are better for long-term audit trails; session files are better for real-time awareness.

**Sources:**
- [Git Notes Documentation](https://git-scm.com/docs/git-notes)
- [Git Notes for Metadata Tracking](https://www.dariuszparys.com/git-notes-for-metadata-and-progress-tracking/)
- [Ris Adams: Git Notes & Trailers](https://risadams.com/blog/2025/04/17/git-notes/)
- [Tyler Cipriani: Git Notes](https://tylercipriani.com/blog/2022/11/19/git-notes-gits-coolest-most-unloved-feature/)
- [Blake Crosley: The Session Is the Commit Message](https://blakecrosley.com/blog/session-is-the-commit-message/)

---

## 7. Auto-Detecting the Default Branch from Git Remote

### Methods (Ranked by Reliability)

1. **`git symbolic-ref refs/remotes/origin/HEAD`** — reads the cached symbolic ref. Fast, no network. **But:** only valid after `git remote set-head origin -a` has been run at least once.
   - Returns: `refs/remotes/origin/master` (strip prefix to get branch name)
   - Fails if: clone is old and remote HEAD was renamed since.

2. **`git remote show origin | grep 'HEAD branch'`** — queries the remote live. Always accurate. **But:** requires network access, slower (~1-2s).
   - Output: `HEAD branch: master`
   - Parse with: `git remote show origin | sed -n '/HEAD branch/s/.*: //p'`

3. **`git config init.defaultBranch`** — reads the local git config default. **But:** only applies to new repos created locally, not clones.

4. **Hardcoded fallback chain:** Check for `main`, then `master`, then `develop`. **But:** fails on repos with non-standard defaults (e.g., `trunk`, `production`).

### Edge Cases
- **Renamed default branches:** After renaming `master` → `main` on GitHub, clones still show `master` as HEAD until `git remote set-head origin -a` is run.
- **Bare repos:** `git symbolic-ref HEAD` works directly (no remote prefix).
- **Fork repos:** May have a different default than upstream.
- **Claude Code bug** ([#24516](https://github.com/anthropics/claude-code/issues/24516)): Hardcodes "main" detection instead of checking remote HEAD.

### Recommended Algorithm
```bash
get_default_branch() {
  # Method 1: Cached symbolic ref (fast, no network)
  local ref
  ref=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)
  if [ -n "$ref" ]; then
    echo "${ref#refs/remotes/origin/}"
    return 0
  fi

  # Method 2: Query remote (slow, requires network)
  local branch
  branch=$(git remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p')
  if [ -n "$branch" ]; then
    # Cache it for next time
    git remote set-head origin "$branch" 2>/dev/null
    echo "$branch"
    return 0
  fi

  # Method 3: Check common names
  for name in main master; do
    if git show-ref --verify --quiet "refs/remotes/origin/$name" 2>/dev/null; then
      echo "$name"
      return 0
    fi
  done

  # Fallback
  echo "main"
}
```

### Confirmed for This Repo
- `git symbolic-ref refs/remotes/origin/HEAD` → `refs/remotes/origin/master` (works)
- `git remote show origin | HEAD branch` → `master` (works)
- `git config init.defaultBranch` → `master` (works)

**Sources:**
- [usethis R package: git-default-branch](https://usethis.r-lib.org/reference/git-default-branch.html)
- [Claude Code Issue #24516](https://github.com/anthropics/claude-code/issues/24516)
- [Git Remote Documentation](https://git-scm.com/docs/git-remote/2.17.0)

---

## 8. Hostname Detection Cross-Platform (Bash)

### Methods (Ranked by Portability)

| Method | Linux | macOS | Windows (Git Bash/MSYS2) | Notes |
|--------|-------|-------|--------------------------|-------|
| `hostname` command | Yes | Yes | Yes | Most portable. `-s` flag for short name. |
| `$HOSTNAME` variable | Yes (bash) | Yes (bash) | Yes (bash) | Bash-specific; not available in sh/dash/zsh by default. |
| `$COMPUTERNAME` | No | No | Yes | Windows environment variable; uppercase. |
| `/etc/hostname` | Yes | No | No | Linux-only file. |
| `/proc/sys/kernel/hostname` | Yes | No | No | Linux-only procfs. |
| `hostnamectl` | Yes (systemd) | No | No | systemd-only. |
| `scutil --get ComputerName` | No | Yes | No | macOS-specific. |

### Confirmed for This Repo (Windows Git Bash)
```
HOSTNAME=Harsha-OFC
hostname command=Harsha-OFC
COMPUTERNAME=HARSHA-OFC   (note: uppercase)
OS=Windows_NT
OSTYPE=msys
```

### Recommended Cross-Platform Function
```bash
get_hostname() {
  # hostname command is available on all three platforms
  hostname -s 2>/dev/null || hostname 2>/dev/null || echo "${HOSTNAME:-${COMPUTERNAME:-unknown}}"
}
```

### Pitfalls
- **macOS:** `$HOSTNAME` and `hostname -s` may differ from the "Computer Name" set in System Preferences.
- **Windows:** `$HOSTNAME` in Git Bash is case-preserved; `$COMPUTERNAME` is uppercase.
- **hostname -s** strips the domain part (e.g., `host.example.com` → `host`). Use `-f` for FQDN.
- **Docker/containers:** Hostname is the container ID by default unless explicitly set.

**Sources:**
- [7th Zero: Bash Platform Detection](https://7thzero.com/blog/bash-101-part-3-platform-detection-and-dynamic-run-time-command-)
- [nixCraft: Linux Hostname](https://www.cyberciti.biz/faq/find-my-linux-machine-name/)
- [Rosetta Code: Hostname](https://rosettacode.org/wiki/Hostname)
- [SysTutorials: Hostname in Bash](https://www.systutorials.com/how-to-get-the-hostname-of-the-node-in-bash/)

---

## Key Recommendations for Multi-Dev Awareness Feature

### Architecture Sketch (Not Implementation — Just Direction)

1. **Session tracking:** Lightweight JSON files in `.beads/sessions/` — one per active agent/developer session. Contains hostname, PID, branch, worktree, active issues, heartbeat timestamp. Stale after 5-minute heartbeat gap.

2. **Overlap detection:** On `/status` or `bd` commands, scan active sessions + `git diff --name-only` per branch to detect file-level overlaps. Warn but don't block.

3. **JSONL conflict prevention:** Append-only writes with unique IDs. On merge conflicts, LWW by `updated_at` per record. Tombstones already handled correctly.

4. **Default branch detection:** Use the 3-method fallback algorithm (symbolic-ref → remote show → name check).

5. **Hostname:** Use `hostname -s` as primary, fallback chain for edge cases.

6. **No external services:** Everything uses git commands, bash, and local files.
