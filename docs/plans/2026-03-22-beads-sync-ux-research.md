# Beads Sync UX Research: Git-Based Metadata Sync Across Multiple Developers

**Date:** 2026-03-22
**Context:** 5 developers, each with 2-3 parallel sessions. Need to sync `.beads/issues.jsonl` and `.beads/file-index.jsonl` across all developers so everyone sees what others are working on.
**Goal:** Find the approach with the best developer UX — ideally "sync just works" without developers knowing.

---

## Approaches Ranked by Developer UX (Best to Worst)

### Rank 1: Custom Hidden Refs (`refs/beads/*`) — The git-bug Pattern

**How it works:** Store beads data as git objects (blobs/trees/commits) under a custom ref namespace `refs/beads/`. Configure refspecs so `git fetch` and `git push` automatically sync this namespace. Developers never see it in `git branch`, `git log`, or their working tree.

**Prior art:**
- **git-bug** (9.7k stars) stores bugs under `refs/bugs/<id>` — each bug is a chain of commits containing operation packs (JSON). Sync is `git bug push/pull` which maps to `git push/fetch` on the `refs/bugs/*` namespace. Uses Operation-based CRDTs with Lamport clocks for conflict-free merging.
- **git-appraise** (5.3k stars, Google) stores code reviews under `refs/notes/devtools/*`. Each review item is a single line of JSON. Uses `cat_sort_uniq` merge strategy (sort lines, deduplicate) — perfectly suited for JSONL.

**Merge conflicts:** Append-only JSONL + `cat_sort_uniq`-style merging = conflict-free by design. Each line is an independent record. Concurrent appends just concatenate and sort.

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 10/10 | Completely invisible. No new branches, no checkout switching, no merge conflicts in working tree. Data syncs with normal git operations if refspecs configured. |
| Onboarding friction | 8/10 | Requires one-time `git config` to add refspec. Can be automated in `bunx forge setup`. New clones need the config. |
| Merge conflict handling | 10/10 | JSONL + sort/dedup = zero conflicts. git-appraise proved this at Google scale. |
| Compatibility | 10/10 | Works with any git workflow (git flow, trunk-based, forks). Refs are orthogonal to branches. |
| Offline support | 10/10 | Full offline. Syncs on next push/fetch. |
| Implementation complexity | 7/10 | Medium. Need to write git plumbing commands (hash-object, mktree, commit-tree, update-ref) in bash. ~100-150 lines. But git-bug's source code is a reference implementation. |

**How to implement for beads:**
```bash
# Write: hash JSONL content into a blob, create tree, commit, update ref
blob=$(git hash-object -w .beads/issues.jsonl)
tree=$(printf "100644 blob $blob\tissues.jsonl\n" | git mktree)
commit=$(git commit-tree $tree -m "beads sync" [-p $prev_commit])
git update-ref refs/beads/data $commit

# Sync: add refspec to git config (one-time setup)
git config --add remote.origin.fetch '+refs/beads/*:refs/remotes/origin/beads/*'
git config --add remote.origin.push '+refs/beads/*:refs/beads/*'

# Read: extract data from ref
git show refs/beads/data:issues.jsonl > .beads/issues.jsonl
```

**Key insight from git-appraise:** Storing each record as one line of JSON, then using `cat | sort | uniq` for merging, is a proven pattern that eliminates merge conflicts entirely for append-heavy data.

---

### Rank 2: Git Notes with Custom Ref (`refs/notes/beads`)

**How it works:** Git notes are metadata blobs attached to commits. You can use a custom notes ref (`refs/notes/beads`) to store arbitrary data. Notes have built-in merge strategies including `cat_sort_uniq`.

**Prior art:** git-appraise uses exactly this — `refs/notes/devtools/reviews`, `refs/notes/devtools/ci`, etc.

**Merge conflicts:** Built-in `cat_sort_uniq` strategy in `git notes merge`. Set via `notes.beads.mergeStrategy = cat_sort_uniq`.

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 9/10 | Nearly invisible. Notes don't appear in working tree. But notes are per-commit (attached to a specific commit), which is a conceptual mismatch — beads data isn't about specific commits. |
| Onboarding friction | 7/10 | Need refspec config AND `notes.displayRef` config. Notes aren't fetched by default — must add `+refs/notes/beads:refs/notes/beads` to fetch refspec. |
| Merge conflict handling | 9/10 | Built-in `cat_sort_uniq` is perfect for JSONL. Slight edge case: notes are per-commit, so if two developers annotate different commits, data is fragmented. |
| Compatibility | 8/10 | Works with any workflow, but some hosting platforms strip notes on fork operations. GitHub preserves notes but doesn't display custom refs in UI. |
| Offline support | 10/10 | Full offline. |
| Implementation complexity | 6/10 | Conceptual mismatch is the issue. Notes attach to commits, but beads data is global state. You'd need a sentinel commit or a workaround to store global JSONL. More awkward than custom refs. |

**Fundamental limitation:** Notes are designed to annotate *specific commits*. Beads data is a global issue list, not per-commit metadata. You'd have to pick an arbitrary commit to attach the data to (e.g., always the root commit), which is a hack. git-appraise works because reviews genuinely annotate commits. git-bug chose custom refs over notes for exactly this reason.

---

### Rank 3: Orphan Branch (`beads/sync`)

**How it works:** Create a branch with `git checkout --orphan beads/sync` that has no shared history with the code branches. Store only `.beads/` files there. This is the same pattern GitHub Pages uses with `gh-pages`.

**Prior art:** `gh-pages` branch is the canonical example. Many projects use orphan branches for generated docs, coverage reports, etc.

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 7/10 | Shows up in `git branch` list. Developers see it and wonder what it is. Not confusing to experienced git users (gh-pages pattern is well-known), but adds noise. |
| Onboarding friction | 6/10 | Need to explain "don't checkout that branch, it's for metadata." Hook scripts can automate sync, but the branch is visible and invites questions. |
| Merge conflict handling | 7/10 | Standard git merge on the orphan branch. JSONL append-only helps, but concurrent pushes to same branch = normal merge conflicts. Need either locking or a custom merge driver for `.jsonl` files. |
| Compatibility | 9/10 | Works everywhere. Orphan branches are standard git. gh-pages proved the pattern. |
| Offline support | 10/10 | Full offline. |
| Implementation complexity | 5/10 | Easiest to implement. Standard git commands. But sync logic (checkout orphan, update files, commit, push, checkout back) is error-prone with worktrees. |

**Advantage over "dedicated branch":** No shared history means the branch never accidentally merges into code branches. Cleaner than option 2 (dedicated `beads/sync` branch with shared history).

**Disadvantage:** Concurrent pushes to the same branch cause fast-forward failures. Need retry logic or per-developer branches that merge.

---

### Rank 4: Sync to Master/Develop (Original Option 1)

**How it works:** `.beads/` directory lives alongside code on the main branch. Every commit can include beads changes. Branch protection allows `.beads/` pushes.

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 6/10 | Simplest mental model — files are just there. But beads changes pollute `git log`, `git diff`, PR diffs. Every feature branch has stale beads data. |
| Onboarding friction | 9/10 | Zero new concepts. Files in a directory. |
| Merge conflict handling | 4/10 | Every branch has its own copy of beads data. Merging feature branches = merge conflicts on `.beads/` files constantly. 5 developers x 2-3 sessions = guaranteed conflicts. |
| Compatibility | 6/10 | Requires branch protection exemptions for `.beads/`. Doesn't work with fork-based workflows (PRs from forks can't push to upstream `.beads/`). |
| Offline support | 10/10 | Full offline. |
| Implementation complexity | 9/10 | Trivial. `git add .beads/ && git commit && git push`. |

**Fatal flaw:** With 5 developers and 10-15 parallel sessions, beads data diverges immediately across branches. Each feature branch has stale data. Merges are a nightmare. This is the worst approach for multi-developer scenarios despite being the simplest.

---

### Rank 5: Dedicated `beads/sync` Branch (Original Option 2)

**How it works:** A regular branch (with shared history from where it was created) dedicated to beads data.

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 6/10 | Same visibility concerns as orphan branch, plus shared history means accidental merges are possible. |
| Onboarding friction | 6/10 | Must explain the branch and the sync workflow. |
| Merge conflict handling | 7/10 | Same as orphan branch — concurrent pushes conflict. |
| Compatibility | 8/10 | Standard git. |
| Offline support | 10/10 | Full offline. |
| Implementation complexity | 5/10 | Easy. Standard git. |

**Strictly worse than orphan branch** — shared history adds risk of accidental merge with no offsetting benefit.

---

### Rank 6: Git Submodule for `.beads/`

**How it works:** Create a separate repo for beads data. Include it as a submodule at `.beads/`.

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 3/10 | Submodules are universally disliked. Extra `git submodule update --init` on clone. Detached HEAD states. Forgotten submodule commits. |
| Onboarding friction | 2/10 | Must explain submodules, a concept most developers actively avoid. Onboarding docs double in size. |
| Merge conflict handling | 6/10 | Conflicts are in the submodule repo, which is simpler (only JSONL files). But submodule pointer conflicts in the parent repo are common and confusing. |
| Compatibility | 5/10 | Works technically, but CI, hooks, and tooling all need submodule awareness. Many git GUIs handle submodules poorly. |
| Offline support | 8/10 | Works offline but requires both repos cloned. |
| Implementation complexity | 4/10 | Moderate setup, high ongoing maintenance burden. |

**Not recommended.** The cognitive overhead of submodules far outweighs any architectural benefit for a simple JSONL sync problem.

---

### Rank 7: Smudge/Clean Filters

**How it works:** Git attributes with `filter=beads` on `.beads/*`. Smudge filter runs on checkout (could pull latest from remote). Clean filter runs on commit (could push).

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 5/10 | Truly invisible when working... but breaks in surprising ways. Network calls in smudge/clean are fragile (offline? slow?). Filters must be idempotent (smudge -> clean = identity). |
| Onboarding friction | 4/10 | Must configure git config for the filter driver. If not configured, files are checked out raw (silent failure). Must understand a very niche git feature. |
| Merge conflict handling | 3/10 | Filters don't help with merges. Still get normal merge conflicts on the files. Filters just transform content on checkout/checkin — they don't merge. |
| Compatibility | 4/10 | Requires per-machine config. Different filter behavior across machines is a nightmare to debug. |
| Offline support | 2/10 | If smudge filter makes network calls, offline = broken checkout. If it doesn't, what's the point? |
| Implementation complexity | 3/10 | High complexity for low reward. Filter drivers are hard to debug, especially cross-platform. |

**Not recommended.** Smudge/clean filters are designed for content transformation (line endings, keyword expansion), not data synchronization. Wrong tool for the job.

---

### Rank 8: GitHub Actions / Webhooks

**How it works:** A GitHub Action triggers on push events. It reads `.beads/` from the pushed branch and syncs it to a central location (another branch, release artifact, etc.).

**Evaluation:**
| Dimension | Score | Notes |
|-----------|-------|-------|
| Developer UX | 7/10 | Invisible sync — happens in the cloud. But introduces latency (Actions take 10-30s to start). And requires GitHub specifically. |
| Onboarding friction | 5/10 | Must understand the Action exists. Debugging sync failures requires CI knowledge. |
| Merge conflict handling | 6/10 | Action can implement smart merging (read all branches, merge JSONL, commit). But race conditions between concurrent Action runs are hard to handle. |
| Compatibility | 3/10 | GitHub-only. Doesn't work with GitLab, Bitbucket, self-hosted. Tied to a specific platform. |
| Offline support | 0/10 | Zero offline support. Requires push to GitHub + Action execution. If GitHub is down, no sync. |
| Implementation complexity | 6/10 | Moderate. Writing the Action YAML + merge script. But debugging CI-based sync is painful. |

**Not recommended as primary mechanism.** Could be a useful *supplement* (e.g., Action that validates beads data integrity on PR), but cannot be the primary sync mechanism due to zero offline support and platform lock-in.

---

## Summary Ranking

| Rank | Approach | UX Score | Key Advantage | Key Risk |
|------|----------|----------|---------------|----------|
| 1 | **Custom Hidden Refs** (`refs/beads/*`) | 10/10 | Completely invisible, conflict-free JSONL merge, proven by git-bug (9.7k stars) | Requires git plumbing knowledge to implement |
| 2 | **Git Notes** (`refs/notes/beads`) | 9/10 | Built-in merge strategies, invisible | Conceptual mismatch (notes are per-commit, beads is global) |
| 3 | **Orphan Branch** | 7/10 | Well-known pattern (gh-pages), standard git | Visible in branch list, concurrent push conflicts |
| 4 | Sync to Master | 6/10 | Zero new concepts | Merge conflict hell with 5+ developers |
| 5 | Dedicated Branch | 6/10 | Easy to understand | Strictly worse than orphan branch |
| 6 | GitHub Actions | 7/10 | Zero local config | No offline, platform lock-in |
| 7 | Submodule | 3/10 | Clean separation | Everyone hates submodules |
| 8 | Smudge/Clean | 5/10 | Truly invisible when working | Wrong tool, fragile, no merge help |

---

## Recommendation

**Primary: Custom Hidden Refs (`refs/beads/*`)** — This is the clear winner.

The pattern is proven at scale by two major open-source tools:
- **git-bug** (9.7k stars): Custom refs under `refs/bugs/*`, CRDT-based conflict resolution
- **git-appraise** (5.3k stars, Google): Custom notes refs under `refs/notes/devtools/*`, JSONL with `cat_sort_uniq` merging

For beads specifically, the implementation would be a hybrid:
1. Store data under `refs/beads/data` (git-bug's custom ref approach)
2. Use JSONL format with `cat | sort | uniq` merging (git-appraise's merge approach)
3. Auto-configure refspecs during `bunx forge setup` so sync is invisible
4. Wrap in `bd sync` command: reads ref -> merges with local -> writes ref -> push

**The developer experience is:** run `bd sync` (or have it auto-run via hooks), and everyone's beads data is merged. No branches, no checkout switching, no merge conflicts, no conceptual overhead. The data lives in the git object store but never appears in the working tree, `git log`, or PR diffs.

---

## Implementation Sketch (for reference, not for coding now)

```
# One-time setup (automated in `bunx forge setup`):
git config --add remote.origin.fetch '+refs/beads/*:refs/remotes/origin/beads/*'
git config --add remote.origin.push 'refs/beads/data:refs/beads/data'

# bd sync (what happens under the hood):
1. git fetch origin refs/beads/data
2. Extract remote JSONL: git show refs/remotes/origin/beads/data:issues.jsonl
3. Merge: cat local.jsonl remote.jsonl | sort | uniq > merged.jsonl
4. Hash merged content: git hash-object -w merged.jsonl
5. Create tree + commit under refs/beads/data
6. git push origin refs/beads/data

# Conflict resolution: NONE needed
# JSONL + sort + uniq = deterministic, conflict-free merge
# Two developers adding different issues = both lines kept
# Two developers adding same issue = deduplicated
```

---

## Open Questions for Implementation

1. **Auto-sync timing:** Should `bd sync` run automatically on every `git push`/`git pull` (via hooks), or only when explicitly called? Auto-sync is more invisible but adds latency to every push.

2. **Per-issue refs vs single ref:** git-bug uses one ref per bug (`refs/bugs/<id>`). We could use one ref for all beads data (`refs/beads/data`) or one per issue (`refs/beads/issues/<id>`). Single ref is simpler; per-issue allows finer-grained sync but adds complexity.

3. **File-index sync:** `file-index.jsonl` tracks which developer is working on which files. This is inherently ephemeral/real-time data. Should it sync via the same mechanism, or is it better suited to a lightweight approach (e.g., just overwrite with latest on each sync, last-writer-wins)?

4. **Refspec auto-configuration:** How to ensure `git clone` automatically gets the refspec? Options: document in README, add to `.gitconfig` in repo (doesn't auto-apply), or detect on first `bd` command and auto-configure.
