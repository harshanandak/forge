# Forge-Issues MCP Architecture — Risk Inventory

## 1. GitHub API

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Rate limits (5000/hr REST)** — bulk sync of 500+ issues on session start consumes significant budget | High | Likely | Conditional sync: ETag/If-Modified-Since headers, sync only changed issues. Batch with GraphQL (single query = 1 rate unit for up to 100 nodes). Track remaining budget in `X-RateLimit-Remaining` header; pause queue when < 100. | No — mitigatable |
| **Secondary rate limits (20 mutations/min)** — rapid-fire create/close from agent bursts | High | Likely | Queue with exponential backoff. Coalesce mutations (e.g., batch label changes). Surface "sync pending" status to agent so it doesn't block. | No |
| **API outages / degraded performance** — GitHub status incidents ~2-3x/month | Medium | Possible | Local-first by design — agent never blocks on GitHub. Queue retries with circuit breaker (stop retrying after N failures, resume on next session). Log sync failures visibly. | No |
| **Token expiration / permission changes** | Medium | Possible | Detect 401/403 early, surface clear error: "GitHub token expired, run `gh auth login`". Don't crash the MCP server — degrade to offline mode. | No |
| **GitHub Enterprise vs github.com** — different API base URLs, feature availability | Medium | Possible | Abstract API base URL from `gh` config. Test against GHES. Some features (GraphQL mutations) may differ — need feature detection. | No — but needs testing |
| **Large repos with 1000+ issues** — initial sync is slow and rate-heavy | High | Possible | Paginate with `per_page=100`. Only sync open issues + recently closed (last 30 days). Full sync on explicit command only. Store high-water mark (updated_at) for incremental sync. | No |
| **Pagination limits** — GitHub caps at 1000 results for search, 10 pages for some endpoints | Medium | Possible | Use timeline-based pagination (since/until) instead of offset pagination. For search, use `updated:>YYYY-MM-DD` qualifier. | No |
| **API version changes / deprecation** | Low | Unlikely | Pin to specific API version header (`X-GitHub-Api-Version: 2022-11-28`). Monitor GitHub changelog. Abstract API calls behind adapter layer. | No |

## 2. Local Storage

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **SQLite WAL mode + multiple processes** — two worktrees writing simultaneously | Critical | Certain | SQLite handles this natively with WAL mode + busy_timeout (set to 5000ms). But .git/ is on network drives for some setups — SQLite on NFS/SMB is unsafe. **Document: .git must be on local disk.** | No — with WAL + local disk requirement |
| **events.jsonl growing unbounded** — months of append-only writes | Medium | Certain | Compact/rotate: after state.db rebuild, archive events older than 90 days to `events.jsonl.1.gz`. Keep current file lean. Add `forge issues compact` command. | No |
| **SQLite corruption (power loss, force kill)** — WAL not flushed | High | Possible | WAL mode + `PRAGMA synchronous=NORMAL` gives crash safety (WAL survives, DB may lose last transaction). events.jsonl is the source of truth — rebuild state.db from it with `forge issues rebuild`. Test recovery path. | No — if rebuild works |
| **Disk space on CI/cloud agents** — ephemeral environments | Medium | Likely | state.db for ~1000 issues is < 1MB. events.jsonl with compaction stays < 5MB. Negligible. Real risk is CI not having .git/forge/ at all (see §7). | No |
| **.git directory size bloat** — events.jsonl + state.db in .git/ | Low | Unlikely | Combined < 10MB even for large projects. Not transferred on clone/fetch (it's in .git/, not tracked). | No |
| **git gc** — does it affect .git/forge/? | Low | Unlikely | No. `git gc` only touches objects/refs/pack. Custom directories under .git/ are untouched. Verified behavior. | No |
| **Shallow clone (--depth=1)** — .git/ exists but is minimal | Medium | Likely | .git/forge/ won't exist on fresh shallow clone. Must detect and run initial sync. Shallow clones are common in CI — need graceful handling. | No |

## 3. Concurrency

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Two worktrees writing events.jsonl simultaneously** | Critical | Certain | **Do NOT append directly to JSONL from multiple processes.** Route all writes through SQLite (single WAL-mode DB handles concurrent writers). JSONL becomes an export/backup format, not the hot write path. OR: use SQLite as the sole store, drop JSONL as primary. | **Blocker if JSONL is primary write path** |
| **Two agents in same worktree** | High | Possible | SQLite busy_timeout handles this. But two MCP server instances = two event loops = potential duplicate syncs. Use PID file or advisory lock to ensure single sync process. | No — with lock |
| **Race: local create + GitHub sync + remote create** | High | Possible | Local IDs are UUIDs (no collision). GitHub number assigned on push. Mapping table: `local_uuid → github_number`. If two machines create issues offline, both get unique UUIDs, both sync to different GitHub numbers. No conflict. | No — if UUIDs used |
| **SQLite busy timeout with parallel agents** | Medium | Possible | Set `busy_timeout=5000`. If still failing, increase to 30s. Log contention events. In practice, issue operations are fast (< 10ms) — contention window is tiny. | No |
| **MCP server crash mid-write** | High | Possible | SQLite transactions are atomic — partial writes roll back. For JSONL, use write-then-rename (append to temp, rename). MCP server should use `process.on('exit')` for cleanup. | No — with transactions |

## 4. Data Model

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **GitHub Issues labels: 50 char limit per label** | Low | Unlikely | Forge labels are short (`forge:blocked`, `forge:ready`). Enforce max length on create. | No |
| **GitHub Issues body: 65536 char limit** | Medium | Possible | Dependencies stored as structured block in body (e.g., YAML front matter). Keep dependency section compact — just issue numbers. If body is user-authored and long, dependency metadata could push over limit. Store deps in a comment instead. | No |
| **Parsing fragility — deps in body/comments** | High | Likely | Use fenced code block with machine-readable format: ` ```forge-meta\n{deps: [1,2,3]}\n``` `. Regex/parser must be robust to user edits around it. **Better: use GitHub sub-issues (beta) or a dedicated label scheme.** | No — but needs careful design |
| **No native dependency graph in GitHub Issues** | Medium | Certain | This is a known limitation. Dependencies exist only in local state.db + serialized in issue body. If someone edits the body on GitHub web UI and removes the metadata block, deps are lost on next sync. **Mitigation: store deps in a comment by the bot, not in body.** | No — but fragile |
| **Local IDs vs GitHub numbers** | High | Certain | Use UUIDs locally. Mapping table in state.db. Display format: `#42` (GitHub) or `forge-abc123` (local, pre-sync). After sync, always prefer GitHub number. Never expose raw UUIDs to users. | No |
| **Beads features not in GitHub Issues** — memories, state machine, prime docs | High | Certain | **Memories**: store in `.git/forge/memories/` files (local only, no GitHub sync). **State machine**: map to GitHub Issues labels (`status:in_progress`, `status:blocked`). **Prime docs**: these are design docs — store in `docs/plans/` (already tracked in git). Some beads features will be dropped — document what's lost. | No — but needs feature parity audit |

## 5. Migration

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Migrating from beads/Dolt** — existing issue data | High | Certain | Write `forge migrate-from-beads` command. Read Dolt tables, create events in JSONL, sync to GitHub Issues. One-time operation. Test with forge's own beads data. | No |
| **Projects with existing GitHub Issues** — different conventions | Medium | Likely | On first `forge issues init`, scan existing issues. Don't overwrite. Use `forge:managed` label to distinguish forge-created issues. Respect existing issues — read-only unless explicitly linked. | No |
| **Backward compatibility with `bd` CLI** | Medium | Certain | During transition: `bd` commands emit deprecation warning pointing to `forge issues`. Support both for 2 releases. `forge` commands are the future — `bd` is not maintained. | No |
| **Non-GitHub platforms (GitLab, Bitbucket, self-hosted)** | High | Possible | **Phase 1: GitHub-only.** Abstract the sync layer behind an interface (`IssueSync`). Phase 2: GitLab adapter. Phase 3: Bitbucket. If no remote, local-only mode works fine (just no sync). Don't over-engineer — GitHub covers 90%+ of users. | No — but limits adoption |

## 6. Cross-Platform

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Windows file locking** — more aggressive than Unix; SQLite can fail if antivirus locks DB | High | Likely | Use `PRAGMA locking_mode=NORMAL` (not EXCLUSIVE). Add retry logic on `SQLITE_BUSY`. Test on Windows with Defender real-time scanning. May need to add .git/forge/ to Defender exclusions (document this). | No — but needs Windows testing |
| **WSL + Windows accessing .git/ simultaneously** — two OS file-locking semantics on same files | Critical | Possible | **This is genuinely dangerous.** WSL2 uses 9P filesystem to access Windows files — SQLite locking may not work correctly across the boundary. **Mitigation: detect WSL vs Windows and warn if both are active. Document: use one or the other, not both simultaneously.** | No — but must document clearly |
| **macOS vs Linux SQLite versions** — system SQLite varies (3.31 on older Ubuntu, 3.43 on macOS 14) | Medium | Possible | Bundle SQLite via `better-sqlite3` npm package (compiled, consistent version). Don't rely on system SQLite. | No |
| **Windows 260-char path limit** — `.git/forge/state.db` is short, but worktree paths can be long | Low | Possible | `.git/forge/` paths are short. Main risk is worktree paths. Already handled by forge worktree logic. | No |
| **CRLF in events.jsonl** — git autocrlf could corrupt JSON lines | Medium | Possible | events.jsonl is in .git/ (not tracked by git), so autocrlf doesn't apply. But if any tool opens it in text mode on Windows, line endings could be wrong. **Use binary/explicit `\n` writes.** | No |

## 7. Agent-Specific

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Codex (cloud sandbox)** — no persistent .git/, ephemeral environment | Critical | Certain | Codex cannot use local .git/forge/. **Fallback: direct GitHub Issues API via `gh` CLI.** Forge detects Codex environment (env var or no .git/) and falls back to API-only mode. No local caching. | **Blocker without fallback** |
| **Cursor background agents (remote Ubuntu)** — separate .git | High | Likely | Remote has its own .git/forge/. Session start sync pulls from GitHub. Works correctly IF the remote has `gh` authenticated. May need to forward GitHub token. | No — if auth works |
| **GitHub Copilot coding agent** — runs on GitHub servers, no persistent local state | Critical | Certain | Same as Codex — needs API-only fallback. Copilot agent may not support MCP at all (as of mid-2025). **Fallback: forge CLI commands (non-MCP) that call `gh` directly.** | **Blocker without fallback** |
| **CI/CD environments** — ephemeral, shallow clone, no auth sometimes | High | Certain | CI doesn't need to manage issues typically. If it does (auto-close on merge), use `gh` CLI with `GITHUB_TOKEN`. Don't require .git/forge/ in CI. | No |
| **MCP support across agents** — not all 6 agents support MCP | Critical | Certain | As of 2025: Claude Code, Cline, Cursor support MCP. Codex, Copilot, Windsurf — partial/none. **MUST have non-MCP fallback: `forge issue create`, `forge issue list` CLI commands that work without MCP.** MCP is enhancement, not requirement. | **Blocker if MCP-only** |

## 8. MCP Server Lifecycle

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Cold start time** — MCP server loads SQLite, replays events | Medium | Likely | For < 1000 issues, startup is < 100ms. Use state.db (pre-materialized) — don't replay events on start. Replay only for rebuild. | No |
| **Memory usage with large issue sets** | Low | Unlikely | 10,000 issues × 1KB each = 10MB in memory. SQLite itself uses minimal RAM (pages loaded on demand). | No |
| **Agent doesn't support MCP — fallback?** | Critical | Certain | See §7. CLI fallback is mandatory. MCP tools are convenience wrappers around `forge issue *` CLI commands. | **Blocker if no CLI fallback** |
| **Multiple MCP servers competing** — forge-issues + other plugins | Medium | Possible | Use unique tool name prefix (`forge_issue_*`). MCP protocol handles multiple servers natively. No port conflicts (stdio transport). | No |
| **MCP protocol version compatibility** | Low | Possible | Pin to MCP 1.0 (stable). Protocol is simple (JSON-RPC over stdio). Unlikely to break. | No |

## 9. Security

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **GitHub token accessible by MCP server** | Medium | Certain | MCP server uses `gh` CLI (token managed by gh, not stored by forge). Never store tokens in .git/forge/. | No |
| **Sensitive data in .git/forge/** — issue descriptions may contain secrets | High | Possible | .git/ is not pushed to remote (it's local). But it persists on disk. Same risk as git reflog containing sensitive commits. **Document: .git/forge/ contains issue data. Treat like .git/ itself.** | No — same as existing git risk |
| **.git/forge/ not gitignored** — it's inside .git/, so it's automatically excluded from tracking | Low | Unlikely | Non-issue. Files inside .git/ are never tracked by git. No gitignore needed. | No |
| **Malicious MCP tool calls** | Low | Unlikely | MCP tools validate inputs. SQL injection prevented by parameterized queries (better-sqlite3). GitHub API calls are scoped to authenticated user's permissions. | No |

## 10. Performance

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Event replay on large projects (10000+ events)** | Medium | Possible | Don't replay on startup — use state.db. Replay only for explicit rebuild. With compaction (§2), event log stays manageable. | No |
| **State.db rebuild time** | Low | Unlikely | 10,000 events replay in < 1 second with SQLite. Not a concern. | No |
| **GitHub API latency for initial sync** | Medium | Likely | First sync of 500 issues ≈ 5 API calls × 500ms = 2.5 seconds. Acceptable. Run async — don't block agent. | No |
| **Memory footprint** | Low | Unlikely | better-sqlite3 is ~5MB. Event processing is streaming. Total < 20MB. | No |

## 11. Offline / Disconnected

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **Queue grows unbounded while offline** | Medium | Possible | Cap queue at 1000 pending operations. Warn at 500. In practice, even heavy use produces < 50 ops/day. | No |
| **Conflict resolution after days offline** | High | Possible | **Last-write-wins for simple fields** (title, status, labels). For body edits, detect conflict (compare `updated_at`) and surface to user: "Issue #42 was modified on GitHub while offline. Keep local or remote?" Auto-resolve status changes (closed beats open if both changed). | No — but needs conflict UX |
| **Offline events reference closed issues** | Medium | Possible | Queue processes events in order. If `add_dep(#42, #43)` but #43 was closed online, sync detects this and warns: "Dependency #43 is closed." Don't silently fail. | No |
| **Two offline machines, same local IDs** | Low | Unlikely | UUIDs prevent collision (see §3). Both sync independently. | No |

## 12. Git-Specific

| Risk | Severity | Likelihood | Mitigation | Blocker? |
|------|----------|------------|------------|----------|
| **git stash** — affects .git/forge/? | Low | Unlikely | No. `git stash` only affects working tree and index. .git/ internals untouched. | No |
| **git reset --hard** — wipes .git/forge/? | Low | Unlikely | No. `git reset --hard` affects working tree and HEAD. .git/ internals untouched. | No |
| **git worktree remove** — cleanup of shared state? | Medium | Likely | Worktrees share .git/ (via .git file pointing to main repo's .git/worktrees/). Removing a worktree doesn't affect .git/forge/. But if a worktree-specific MCP server is running, it should detect removal and shut down gracefully. | No |
| **Submodules — .git is a file, not directory** | High | Possible | In submodules, `.git` is a file containing `gitdir: ../.git/modules/<name>`. Must resolve this indirection to find the actual .git directory. Use `git rev-parse --git-dir` instead of assuming `.git/` is a directory. | No — if using git rev-parse |
| **Bare repos (CI)** — no working tree | Medium | Likely | `.git/forge/` is inside the git dir, so it exists in bare repos. But CI typically uses `actions/checkout` which creates a normal repo. For bare repos, detect with `git rev-parse --is-bare-repository` and operate in read-only/API-only mode. | No |

---

## Summary: Blockers

Only **3 true blockers** identified, all in the same category:

1. **MCP-only design** — agents that don't support MCP (Codex, Copilot) are completely locked out. **Fix: CLI fallback is mandatory. MCP is an enhancement layer, not the only interface.**

2. **JSONL as primary concurrent write path** — multiple worktrees/agents appending to the same file is unsafe without coordination. **Fix: Use SQLite as the sole write path. JSONL becomes an export/audit format.**

3. **Cloud/ephemeral agents** (Codex, Copilot coding agent) have no persistent .git/. **Fix: API-only fallback mode that operates directly against GitHub Issues without local state.**

All three blockers have clear mitigations. No architectural showstoppers — but the design MUST include CLI fallback and API-only mode from day one, not as afterthoughts.
