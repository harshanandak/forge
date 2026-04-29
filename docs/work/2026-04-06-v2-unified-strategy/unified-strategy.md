# Forge v2 Unified Strategy

**Date**: 2026-04-07 (revised after evaluator synthesis)
**Status**: Right-sized scope, ready for implementation
**Scope**: Consolidated findings from ~30 research agents + 4 separate-context evaluator agents + Anthropic engineering principles

---

## 0. Honest Scope Statement

### Who this is for

**Primary audience**: Developers who care about software engineering discipline (TDD, dependency tracking, structured handoffs, code review, doc updates) and want AI agents to follow it. Inspired by [SuperPowers](https://github.com/obra/superpowers) (100k stars validates this audience exists).

The core insight: **good developers know how they should work, but can't manually enforce it on every AI interaction.** Forge encodes that discipline so the AI agent follows it automatically.

**Not for**: Vibe coders, throwaway prototypes, devs who skip TDD, devs who want pure speed over quality.

### Headline value proposition

**Fast issue capture from inside the workflow** — when you're working on Project A and discover an issue/idea for Project B, capture it without leaving your work. Backend is configurable: git-backed (default beads), Linear, Jira, GitHub Issues. Most issue trackers require context switches; forge doesn't. Once the capture is automatic, the workflow can prioritize, dependency-track, and surface "what to work on next" without manual triage.

This is the unique value Linear/Jira/SuperPowers don't have: **capture without leaving the work**.

### What v2 cuts (vs original 20-week plan)

| Cut | Reason | Saved |
|-----|--------|-------|
| WS3 forge-issues rewrite (8-22w) → thin wrapper (2-3w) | Beads has 50+ commands we'd lose. Original pain solvable in 1-2 weeks. Cloud-agent adapter is the only genuinely new piece. | ~6-19 weeks |
| WS6 (parallel agent teams) | Speed optimization, not load-bearing for the core problem. Defer to v3. | ~6-8 weeks |
| WS9 Phase 3 (cross-agent parity testing infra) | Testing infrastructure, not features. Defer to v3. | ~2 weeks |
| Self-evaluation overlap between WS5 and WS13 | WS13 guardrails handle machine-checkable cases. WS5 evaluator handles judgment cases. Reduce overlap. | ~1 week |
| **Copilot support dropped** (6 agents → 5) | No parallel subagent dispatch, no async/background, no nested trees. Sequential handoffs don't match forge's hybrid orchestrator + parallel wave architecture. Would require a fully separate degraded execution path. Enterprise Copilot users have their own review stack. | ~1-2 weeks + ongoing maintenance |

**Realistic timeline: 12-14 weeks** (down from 20 stated / 30-40 actual).

### What v2 keeps (and why)

| Workstream | Why it stays |
|-----------|--------------|
| All 5 agents (Claude Code, Codex, Cursor, Kilo, OpenCode) | Different subscription realities — Anthropic users → Claude Code, ChatGPT Pro → Codex, open-source models via Kilo Code, multi-model via OpenCode, IDE-first via Cursor. Each represents real users. **Copilot dropped 2026-04-07** — no parallel subagent dispatch, mismatched with forge architecture. |
| Multi-agent generation (WS2) | Cross-agent parity IS user value, not vendor concern. Users distribute across these subscriptions. |
| Hybrid orchestrator pattern (plan + dev) | Anthropic GAN-inspired pattern. Separate-context evaluator prevents self-approval bias. |
| Universal review system (WS10) | Solves real PR review pain across CodeRabbit/Greptile/Qodo/SonarCloud. |
| Doc automation (WS12) | Solves real doc rot. |
| Universal guardrails (WS13) | Verifiable proof of work — agents can't lie about completing stages. |
| Forge CLI abstraction (WS1) | Universal layer for all 5 agents. Tier 1-3 enforcement. |
| Evaluator agent pattern (WS5) | Genuinely novel — separate-context grading prevents self-approval bias. |
| Tech-stack-aware skills via Context7 (WS11) | Evaluator grades against actual project tech stack rules, not generic. |

### Inspiration credit

Plan mode is inspired by SuperPowers' approach to structured AI workflows (100k stars). Dev mode draws from Anthropic's Building Effective Agents and Harness Design articles. Forge adds: agent-agnostic CLI layer, multi-agent generation, separate-context evaluator, universal review system, configurable issue backend.

---

## 1. Vision

Forge v2 transforms from a Claude-Code-centric workflow harness into a **universal agent-agnostic development orchestrator** that works equally well across 5 AI coding agents, applies Anthropic's latest harness engineering patterns, and replaces fragile local-only infrastructure with robust cross-session, cross-machine, cross-agent state management.

### Supported Agents (5)

| Agent | Hooks | Subagents | Skills | Custom Agents | Plugins |
|-------|:-----:|:---------:|:------:|:-------------:|:-------:|
| **Claude Code** | Pre/Post/Stop | Agent tool | `.claude/skills/` | `.claude/agents/` | plugin.json |
| **Codex (OpenAI)** | Yes | Yes | `.codex/skills/` | `.codex/` | Build plugins |
| **Kilo Code** | Rules | Task tool | `.kilocode/skills/` | `.kilo/agents/` | kilo.jsonc |
| **OpenCode** | Event API (JS/TS) | Custom agents | `.opencode/skills/` | `.opencode/agents/` | Full plugin API |
| **Cursor** | Pre/Post/Stop | Async + nested | Marketplace | `.cursor/agents/` | MCP |

> **GitHub Copilot was dropped from v2 support on 2026-04-07.** Copilot has no parallel subagent dispatch, no async/background agents, no nested subagent trees, and uses sequential handoffs instead of true subagent spawning. This fundamentally does not match forge's hybrid orchestrator + parallel waves + separate-context evaluator architecture. Enterprise Copilot users typically have their own review stack (CodeRabbit integrations, SonarCloud) and don't run OSS workflow harnesses on top. Building a second degraded execution path for one agent that can't match the architecture was judged not worth the maintenance cost. If Copilot adds true parallel subagent support in the future, this decision can be revisited.

### Invocation Tier Model

Every improvement must work at Tiers 1-3 minimum. Tiers 4-6 are progressive enhancements.

```
Tier 1: Files on disk (.forge/, AGENTS.md, progress.md)     -> ALL 5 agents
Tier 2: Forge CLI (forge push, forge validate, forge dev)    -> ALL 5 agents
Tier 3: Git hooks (lefthook pre-push, pre-commit)            -> ALL 5 agents
Tier 4: Agent hooks (PreToolUse, event hooks)                -> ALL 5 agents (confirmed)
Tier 5: Subagent spawning (evaluator, parallel workers)      -> ALL 5 agents (confirmed)
Tier 6: Agent-native features (skills, workflows, plugins)   -> Varies per agent
```

---

## 2. Workstreams

### WS1: Forge CLI Abstraction Layer + Smart Status Dashboard

**Problem**: 2,849 raw command references (1,796 bd, 420 gh, 633 git) across 25+ agent instruction files. Agents bypass forge and call raw tools directly.

**Gap Analysis (verified by codebase grep)**:
- 1,796 raw Beads commands — **wrapped by WS3** (`forge issue` thin-wrapper routes to `bd` under the hood, preserving all 50+ beads commands while giving agents a stable forge CLI surface)
- 420 raw GitHub CLI commands — need `forge pr` wrappers
- 633 raw git commands — partially wrapped (forge push/test exist), need `forge info/rebase`
- 9 raw package manager commands — already wrapped (forge test, forge push)

**Remaining forge commands to build** (after WS3 wraps beads):

| Command | Replaces | Complexity | Deep integration |
|---------|----------|------------|-----------------|
| `forge pr create` | `gh pr create` | Medium | Auto-links issues from beads, generates description from progress.md, idempotency check (`gh pr list --head <branch>` before create), adds forge labels |
| `forge pr view/checks/list` | `gh pr view/checks/list` | Light | Formatted output + forge-issues status overlay |
| `forge info --branch/--worktree/--state` | `git branch`, `bd state` | Trivial | Single query interface for all state |
| `forge rebase` | `git rebase` | Medium | Conflict detection, uncommitted changes guard, test-after-rebase |
| `forge audit` | Manual logging | Light | Append-only `.forge/incidents.jsonl` |
| **`forge status`** | `bd ready`, `bd blocked`, `/status`, manual PR checks | Heavy | **Smart personal status** — "what should I work on right now?" Multi-dimensional scoring, 4 contextual groups (Ready / Blocked / Your PRs / PRs awaiting reply), external classifier with label + body hints fallback (see below) |
| **`forge board`** | GitHub Projects v2 board UI checks | Medium | **Project board view** — "what's the state of the sprint/project?" Syncs with GitHub Projects v2 board bidirectionally, shows columns/sprints/custom fields, team-level aggregate view (see below) |
| **Downstream error translator** | Cross-cutting (not a command) | Medium | **Error translation layer** — catches raw tool errors (git/gh/bd/bun/eslint/tsc/vitest/dolt/Lefthook/MCP/GitHub API), translates them into forge terms with actionable recovery steps. Every forge command runs downstream tools through this layer. See dedicated subsection below. |

#### `forge status` — Personal Work Focus

**Question it answers**: "What should I work on right now?"

Replaces `bd ready`, `bd blocked`, the existing `/status`, and manual PR checks. Personal, task-focused, high-frequency (run multiple times per day). Mirrors everything from GitHub Issues, then surfaces what's actually relevant to YOU.

**Multi-dimensional scoring** (each open issue gets a real-time score):

| Dimension | Weight | Signals |
|-----------|:-----:|---------|
| Priority | 25% | P0=4, P1=3, P2=2, P3=1, P4=0 |
| Recency | 15% | exp(-hours_since_activity / 48), smooth decay |
| Activity | 15% | Comments in last 24h, reactions, edits |
| Blocking impact | 20% | Count of issues blocked by this one (transitive) |
| Assignment | 10% | Mine > teammate's > unassigned |
| Stage relevance | 10% | Matches current branch / recent files / active task |
| Age penalty | 5% | Very old issues slightly deprioritized (rot) |

**4 contextual groups** (personal, not project-wide):

| Group | Filter logic |
|-------|-------------|
| **Ready** | tracked + open + not blocked, sorted by score, top N |
| **Blocked** | open + has unresolved dependencies (with `→ waiting on X` annotation) |
| **Your PRs** | open PRs authored by current user, with CI status and review thread count |
| **PRs awaiting your reply** | PRs (yours OR ones you're reviewing) with review comments unresolved by you — **the killer subset GitHub UI handles poorly** |

**External issue classifier** (auto-classify issues without forge metadata — labels first, body hints fallback):
- **Label mapping (primary)**: GitHub labels → forge type/priority
  - `bug`, `defect`, `fix` → type=bug
  - `feature`, `enhancement`, `feat` → type=feature
  - `docs`, `documentation` → type=docs
  - `question` → type=task
  - `p0`, `critical`, `urgent` → P0
  - `p1`, `high` → P1
  - `p2`, `medium` → P2
  - `p3`, `low` → P3
- **Body hints (fallback when labels insufficient)**:
  - Stack trace in body → likely bug
  - "I would like" / "feature request" / "would be nice" → feature
  - Code snippets / "Steps to reproduce" → bug
  - "How do I..." → question
- **Defaults if both fail**: type=task, priority=P2

**Presentation modes** (2 only):
- **default** (compact, one line per issue) — daily use
- **`--json`** — enables scripts and agent integrations

**Role configuration** (config-only, no flag):
```yaml
# .forge/config.yaml
status:
  role: maintainer  # or: contributor
```

- **maintainer**: emphasizes triage queue, community PRs, security issues in scoring
- **contributor**: emphasizes assigned work, your PRs, mentions in scoring
- Set once per project. Forge reads it. No `--role` flag at runtime.

**Example output**:
```bash
$ forge status

Forge — main (clean)
═══════════════════════════════════════════════

▶ READY                                          (3)
  forge-abc    P1 [feature] Implement payment flow     (you, in_progress)
  forge-gh-12  P1 [bug] OAuth broken on Safari         (unassigned)
  forge-def    P2 [task] Refactor auth module          (you)

▶ BLOCKED                                        (2)
  forge-abc.2  P2 → waiting on forge-abc              (yours)
  forge-gh-23  P2 → waiting on forge-gh-12            (Bob)

▶ YOUR PRs                                       (2)
  #45 feat: add OAuth         3 review threads unresolved by you
  #46 fix: race condition     CI green, awaiting review

▶ PRs AWAITING YOUR REPLY                        (1)
  #38 (Bob's PR you reviewed)  Bob replied 2h ago, your turn

═══════════════════════════════════════════════
Showing 8 items across 4 groups
```

**Implementation**: ~900 LOC across `lib/smart-status/{scorer,grouper,relevance,presenter,cache}.js` + `lib/external-issue-classifier.js`. Pure query over mirrored Beads state — no external API calls at command time (daemon handles those).

**Effort**: 2.5 weeks.

**Cuts from original design** (from Pass 4 smart-status evaluation):
- ❌ `--morning` / `--eod` time-aware variants (aspirational ritual, not observed dev behavior)
- ❌ Delta tracking (GitHub notifications already does this — no value duplicating)
- ❌ 6 presentation modes → 2 (default + json only)
- ❌ 8 groups → 4 (dropped "Needs attention", "Recent external", "Stale", "Mentioned you")

---

#### `forge board` — Project State View

**Question it answers**: "What's the state of the sprint / project / team work?"

A separate command from `forge status` because it answers a fundamentally different question. Where `forge status` is personal ("what should I do?"), `forge board` is project-level ("what's the team doing?").

Replaces manual GitHub Projects v2 board UI checks, sprint status meetings, "where are we" questions.

**GitHub Projects v2 Board Sync** (bidirectional):

| GitHub Project Board | ↔ | Forge state |
|---------------------|:-:|------------|
| Column: Backlog | ↔ | tracked + status=open + no in_progress |
| Column: Todo | ↔ | tracked + ready (not blocked) |
| Column: In Progress | ↔ | tracked + status=in_progress |
| Column: Review | ↔ | has open PR |
| Column: Done | ↔ | closed |
| Custom field: Priority | ↔ | forge priority (P0-P4) |
| Custom field: Sprint/Iteration | ↔ | forge iteration tag |
| Custom field: Estimate | ↔ | forge estimate (if set) |

**Pull**: Project board card moves → forge updates issue state
**Push**: Forge issue state changes → moves card on project board

**Views**:
- **`forge board`** (default) — current sprint column view
- **`forge board --sprint=<name>`** — specific sprint
- **`forge board --all`** — all sprints, full backlog
- **`forge board --columns`** — just column counts (quick snapshot)
- **`forge board --json`** — structured output for integrations

**Example output**:
```bash
$ forge board

Project: Forge Core — Sprint 23 (ends in 4 days)
═══════════════════════════════════════════════

BACKLOG (12)                                      TODO (5)
  forge-gh-50  P1 Audit logging                     forge-abc    P1 Payment flow      (you)
  forge-gh-51  P2 Dark mode                          forge-def    P2 Refactor auth     (you)
  forge-gh-52  P2 Mobile layouts                     forge-gh-12  P1 OAuth bug
  ...                                                forge-gh-14  P3 Docs update
                                                     forge-gh-15  P3 Typo fix

IN PROGRESS (3)                                   REVIEW (2)
  forge-abc   P1 Payment flow        @you           #45 OAuth impl       @you (3 threads)
  forge-gh-8  P2 Cache refactor      @Bob           #46 Race condition   @you (CI green)
  forge-gh-9  P2 Log rotation        @Sara

DONE THIS SPRINT (7)                              ✓ 31% complete (7/22)
  forge-gh-1   [feature] Initial auth   (Bob)
  forge-gh-2   [bug] Login redirect      (Sara)
  ...

═══════════════════════════════════════════════
Sprint health: 🟢 on track | Velocity: 7/22 | Days left: 4
```

**Implementation**: 
- GitHub Projects v2 sync: ~400 LOC using GraphQL API (project boards require GraphQL, not REST)
- Board rendering + column layout: ~300 LOC
- Sprint health calculation + velocity: ~150 LOC
- Total: ~850 LOC

**Effort**: 1.5 weeks (added to WS1).

**Why split from `forge status`**:
- Different mental model (personal vs project)
- Different update frequency (many times/day vs daily/weekly)
- Different primary users (every developer vs team leads + standups)
- Different scope (what affects YOU vs what's the overall state)
- Combining them bloats both — splitting keeps each command on-point

**Combined WS1 smart view effort**: 2.5w (status) + 1.5w (board) = **4 weeks** (replaces the earlier combined 3-4w estimate).

**Why this matters**: Combines with WS3's mirror-all approach. `forge status` is your daily command. `forge board` is your sprint command. Both read from the same mirrored state. Neither hits GitHub at command-time — the 30-minute daemon keeps state fresh in the background.


**Critical design requirement: MCP/CLI parity**

Every operation must have identical behavior via MCP tool and CLI command, backed by a shared core function. The core function wraps `bd` (the existing beads CLI) plus the new GitHub sync queue:

```
forge issue create (CLI)  ──┐
                             ├──> issueCore.create() ──> bd create + GitHub sync queue
forge_issue_create (MCP)  ──┘

forge pr create (CLI)  ──┐
                          ├──> prCore.create() ──> gh API + issue linking via bd
forge_pr_create (MCP)  ──┘
```

Single implementation, two interfaces. Tested by one test suite covering both paths. The shared core wraps `bd` for storage operations and adds the GitHub sync queue for cross-machine propagation.

#### Downstream Tool Error Handling (Critical Cross-Cutting Requirement)

Forge wraps a large number of downstream tools. When any of them fails, the user currently sees raw tool output — cryptic, noisy, or unactionable. **Forge must be a translation and recovery layer, not just a dispatcher.** Every wrapped command should catch errors, translate them into forge terms, and offer recovery actions.

**Downstream tools forge wraps**:

| Category | Tools | Failure modes forge must handle |
|----------|-------|-------------------------------|
| **Git** | git, git worktree, git rebase, git push | Conflicts, detached HEAD, no upstream, auth failures, protected branch, LFS issues |
| **GitHub CLI** | gh issue, gh pr, gh api | Auth expired, rate limits (primary + secondary), 404 repo not found, permission denied, network timeout, API deprecation warnings |
| **Beads** | bd create/update/close/dep, bd dolt | Dolt server down, corrupted DB, port conflict, bd binary missing, version mismatch, JSONL parse errors |
| **Dolt** | dolt sql-server, dolt sql | Port in use, permission denied, disk full, schema corruption, lock held by dead process |
| **Package managers** | bun, npm, pnpm, yarn | Lockfile drift, registry unreachable, peer dep conflicts, platform binary mismatch |
| **Linters** | ESLint, Ruff, Clippy, golangci-lint, Biome, Stylelint | Config not found, rule changes between versions, plugin missing, parser errors, binary missing |
| **Formatters** | Prettier, Black, rustfmt, gofmt | Config conflicts, unsupported file type, write errors |
| **Type checkers** | tsc, mypy, Pyright, Flow | Config errors, project references broken, out-of-memory, slow first-run |
| **Test runners** | Vitest, Jest, Bun test, pytest, cargo test, go test | Config not found, test discovery failures, flaky tests, timeout, coverage tool failures |
| **Security scanners** | npm audit, gitleaks, Bandit, gosec | False positives, network errors fetching CVE DB, config errors |
| **Hook managers** | Lefthook, Husky, pre-commit | Config drift, hook binary missing, permission issues, bypass attempts |
| **Review tools** | Greptile, CodeRabbit, Qodo, SonarCloud webhooks | API errors, rate limits, comment parsing failures, bot username drift |
| **MCP servers** | Context7, context-mode, forge-issues | Server not running, protocol version mismatch, tool not found, timeout |
| **External APIs** | GitHub Issues, GitHub Projects v2, Context7 | Network, auth, rate limit, schema changes, pagination edge cases |

**Forge error translation layer** (applies to every forge command):

```javascript
// lib/downstream/error-translator.js (conceptual)
function runWrappedTool(tool, args, context) {
  try {
    return executeTool(tool, args);
  } catch (err) {
    const translated = translate(tool, err, context);
    if (translated.recoverable) {
      // Offer automatic recovery
      promptRecovery(translated);
    } else {
      // Fail with clear forge-level explanation
      throw new ForgeError({
        summary: translated.summary,       // "GitHub auth expired"
        cause: translated.cause,           // The raw tool error
        actions: translated.actions,       // ["Run `gh auth login`", ...]
        docs: translated.docsLink,         // Link to troubleshooting doc
        context: translated.contextLine,   // "While running forge pr create for issue forge-abc"
      });
    }
  }
}
```

**Error message format** (what the user sees):

```
┌─────────────────────────────────────────────────────────┐
│ ✗ forge pr create failed                                │
│                                                          │
│ Problem: GitHub authentication has expired              │
│ Context: Creating PR for forge-abc on branch feat/oauth │
│                                                          │
│ What to do:                                              │
│   1. Run: gh auth login                                  │
│   2. Retry: forge pr create                              │
│                                                          │
│ Technical details (for debugging):                      │
│   gh returned: HTTP 401: Bad credentials                │
│                                                          │
│ Docs: https://forge.dev/troubleshoot/gh-auth             │
└─────────────────────────────────────────────────────────┘
```

Not: `Error: HTTP 401` with no context.

**Error translation registry** — for each downstream tool failure pattern:

| Tool | Raw error pattern | Forge translation | Recovery action |
|------|------------------|-------------------|----------------|
| `gh` | `HTTP 401: Bad credentials` | "GitHub auth expired" | `gh auth login` |
| `gh` | `HTTP 403: rate limit exceeded` | "GitHub rate limit hit. N calls remaining, resets at T" | Wait until reset, or use `GITHUB_TOKEN` with higher limits |
| `gh` | `secondary rate limit` | "GitHub secondary rate limit (mutations) hit" | Automatic backoff, retry with queue |
| `bd` | `dolt: connection refused` | "Beads Dolt server not running" | Auto-restart via `forge setup --repair-beads` |
| `bd` | `bd: command not found` | "Beads CLI not installed" | `forge setup --install-beads` |
| `git` | `could not lock config file` | "Another git operation is holding the lock" | Wait + retry, or check for stuck git processes |
| `git` | `conflict in file X` | "Rebase conflict in file X" | "Resolve via `forge rebase --resolve`, or abort via `forge rebase --abort`" |
| `bun` | `Lockfile has changed` | "Lockfile drift detected" | `bun install` to reconcile |
| `eslint` | `rule X not found` | "ESLint config references a rule that doesn't exist in installed plugins" | Show the offending rule + config file + fix suggestion |
| `tsc` | `Cannot find module X` | "TypeScript can't find module X. Check imports, tsconfig paths, or run `bun install`" | Actionable guidance |
| `vitest` | `test timeout` | "Test X timed out after Ns" | "Increase timeout via test config, or check for hanging async" |
| `lefthook` | `hook failed` | "Pre-push hook failed: <which hook>" | Run the specific failing command directly to see details |
| `dolt` | `port 47000 already in use` | "Another Dolt server is running on port 47000" | Auto-find next free port, or kill stale process |
| `Context7 MCP` | `server not responding` | "Context7 MCP server not running" | Fall back to bundled skills, or install/start Context7 |

**Recovery levels**:

| Level | What forge does | When to use |
|-------|----------------|------------|
| **Auto** | Fix silently, retry once | Recoverable state errors (stale lockfile, stopped server, stale cache) |
| **Prompt** | Ask user "Fix this for you?" | One-step fixes that need consent (install tool, run migration, delete lock file) |
| **Guide** | Explain what's wrong + exact commands to run | User-required actions (auth, permissions, decisions) |
| **Fail** | Clear error, link to docs | Unrecoverable without investigation |

**The golden rule**: **No forge command should ever show a raw tool error without context**. Every downstream tool invocation goes through the error translator. If forge doesn't have a translation for an error, that's a bug — add one.

**Implementation**:

- `lib/downstream/error-translator.js` — central registry (~200 LOC)
- `lib/downstream/patterns/*.js` — per-tool error pattern files (git, gh, bd, bun, eslint, tsc, vitest, dolt, etc.) — each ~50-100 LOC
- `lib/downstream/recovery/*.js` — auto-recovery handlers for recoverable errors
- `lib/forge-error.js` — `ForgeError` class with formatted output
- Tests: each pattern file has fixtures of real raw errors + expected translations

**Effort**: 1 week (adds to WS1). Realistic effort scales with how many error patterns we document — ship with the top 30 most common patterns, add more over time.

**Why this is critical, especially for builds**:

When a build fails in CI, the developer gets a 200-line log of raw tool output. With forge error translation:
- CI output shows the **forge-level summary** first
- The raw tool output is collapsed under "Technical details"
- The suggested fix is right there, not buried in documentation
- If it's a recoverable error (e.g., cache corruption), the forge retry may have already tried the fix before the build failed

This directly addresses the pain point of "2-line review fix → 6-8 minute cycle → fails at CI with unclear error." The error translation layer means when builds fail, users know immediately what to do.

**Out of scope** (pushed to v3+):
- LLM-based error explanation (using an LLM to interpret unknown errors). v2 uses a fixed pattern registry. v3+ can add LLM fallback for unknown errors.
- Auto-filing bug reports to upstream projects for common tool bugs.
- Cross-error correlation ("you hit this error 3 times today, here's the root cause").

#### WS1 Known Limitations & Blockers

*Full risk inventories: [ws1-cli-abstraction-risks.md](ws1-cli-abstraction-risks.md), [ws1-forge-pr-risks.md](ws1-forge-pr-risks.md), [ws1-hook-enforcement-risks.md](ws1-hook-enforcement-risks.md), [ws1-cross-platform-risks.md](ws1-cross-platform-risks.md). Agent migration risks (2,849 raw refs, Codex/Kilo/OpenCode config generators missing, CI validation needed) are captured inline in this section and in the Beads evaluator synthesis report — the originating research agent ran in read-only mode and the standalone ws1-agent-migration-risks.md file was not persisted.*

**7 Blockers (all solvable)**:

| # | Blocker | Severity | Mitigation |
|---|---------|----------|------------|
| 1 | **Hook enforcement only reliably blocks on Claude Code** — 4/5 other agents are advisory-only or use rules instead of blocking hooks | Critical | Don't rely on agent hooks alone. Enforce via Tier 1-3: AGENTS.md instructions + forge CLI validation + git hooks. Agent hooks are bonus enforcement. |
| 2 | **Codex/Kilo/OpenCode have zero config generation** — `agents-config.js` only covers Claude Code + Copilot partially | Critical | Complete `agents-config.js` with `generateCodexConfig()`, `generateKiloConfig()`, `generateOpenCodeConfig()` before migration. Research each agent's config format first. |
| 3 | **Forge's own internal gh/git calls trigger its own hooks** — false positives block legitimate forge operations | Critical | Set `FORGE_INTERNAL=1` env var when forge CLI spawns child processes. Hooks check this var and skip enforcement for internal calls. |
| 4 | **`forge pr create` has no idempotency** — second `/ship` call creates duplicate PR | High | Check `gh pr list --head <branch>` before creating. If PR exists, update it instead. |
| 5 | **WSL + Windows SQLite binary incompatibility** — better-sqlite3 compiled for one OS can't be used by the other | Critical | Bundle via npm (compiled per platform). Detect cross-boundary access and warn. Document single-OS usage. |
| 6 | **2,849 raw command references across 25+ files** — migration is massive, easy to miss | High | CI validation workflow (`grep` for raw bd/gh issue in agent configs). Pre-commit hook blocks new raw references. |
| 7 | **GitHub Issues not synced when `forge pr create` runs** — "Closes #X" references non-existent numbers | High | `forge pr create` checks sync state first. If issues not yet pushed to GitHub, sync them before creating PR. Graceful fallback: create PR without "Closes" if sync fails. |

**High-risk areas (not blockers, but need attention)**:

| Risk | Mitigation |
|------|------------|
| gh CLI not installed or not authenticated | `forge doctor` checks at setup. `forge pr create` gives clear error: "Run `gh auth login` first." |
| gh CLI version differences across machines | Pin minimum version. Use `gh --version` check at startup. |
| Rebase with uncommitted changes | `forge rebase` checks `git status` first, refuses if dirty. |
| PR description contains sensitive data from progress.md | Scan for common secret patterns before including in PR body. |
| Agent ignores forge instructions, calls raw commands | Advisory warning in hook response + log incident. Can't fully prevent — accept as residual risk. |
| `forge evaluate --quick` blocks PR creation on low score | Decouple: run evaluator post-PR as advisory, not as gate. Let user decide. |

#### WS1 Implementation Phases

**Phase 0: Pre-work (1 week)** — Must complete before any migration:

| Task | Effort | Why first |
|------|--------|-----------|
| Research Codex/Kilo/OpenCode config formats | 2 days | Can't migrate what we don't understand |
| Complete `agents-config.js` for all 5 agents | 3 days | Config generation is the migration engine |
| Add CI grep validation (block raw bd/gh issue in agent configs) | 1 day | Prevents regression during migration |
| Add `FORGE_INTERNAL=1` env var isolation for hooks | 0.5 day | Prevents false positive blocks |
| Audit all 2,849 raw command references → create lookup table | 1 day | Migration map |

**Phase 1: Claude Code only (1 week)** — Validate on best-supported agent:

| Task | Effort |
|------|--------|
| Build `forge pr create` with idempotency + issue linking | 3 days |
| Build `forge info` / `forge rebase` | 1 day |
| Build `forge audit` (incident log) | 0.5 day |
| Update `.claude/commands/*.md` — replace all raw refs | 1 day |
| Add PreToolUse hooks (blocking) for Claude Code | 0.5 day |
| MCP/CLI parity test suite | 1 day |

**Phase 2: Expand to Codex + Cursor (1 week)** — Two most different agents:

| Task | Effort |
|------|--------|
| Generate Codex configs (AGENTS.md sections + .codex/) | 2 days |
| Generate Cursor configs (.cursor/agents/ + rules) | 1 day |
| Advisory hooks (warn, don't block) for both | 1 day |
| Cross-agent eval: same task on Claude/Codex/Cursor, verify forge usage | 2 days |

**Phase 3: All 5 agents + hardening (1 week)** — Full parity:

| Task | Effort |
|------|--------|
| Generate Kilo/OpenCode/Copilot configs | 2 days |
| Cross-platform testing matrix (Windows/WSL/macOS/Linux) | 2 days |
| Full parity test suite (MCP = CLI, all 5 agents) | 1 day |
| Migration guide + deprecation warnings on raw commands | 1 day |

**Revised WS1 effort: 5 weeks total**:
- Phase 0 (pre-work): 1w
- Phase 1 (Claude Code): 1w
- Phase 2 (Codex + Cursor): 1w
- Phase 3 (All 5 agents + hardening): 1w
- Phase 4 (Downstream error translation layer): 1w
- Plus smart status (2.5w) and `forge board` (1.5w) — these run in parallel with the phases above by a second engineer, or sequentially for solo work.

For a solo engineer, total WS1 calendar time becomes ~9 weeks (5w phases + 4w smart views). For 2 engineers working in parallel: 5 weeks calendar.

---

### WS2: Commands to Agents Migration

**Problem**: Claude Code is deprecating `.claude/commands/` in favor of `.claude/skills/` and `.claude/agents/`. 10 of 11 commands are stateful orchestrators that can't be skills.

**Design principles**:
- **Agent-agnostic**: Canonical stage definitions describe WHAT, not HOW. Assume frontier models.
- **Model-agnostic**: No model-tier branching, no adaptive behavior. Works on any frontier model (Opus, GPT-5.4, Gemini 2.5 Pro, DeepSeek R1, Qwen 3). If someone runs it on a weak model and it fails, that's on them.
- **Single source of truth**: `.forge/stages/*.yaml` → generated into 6 agent formats.

**Stage consolidation: 7 → 5 stages** (resolves [forge-s0c3](https://github.com/anthropics/claude-code/issues)):

| Current (10 commands, 7 stages) | New (5 stages, 5 agents + 1 skill) | Architecture |
|----------------------|--------------------------|---------------------|
| `/plan` (566 lines) | **plan-agent** (4-phase hybrid orchestrator) | Phase 1: Design intent Q&A → Phase 2: **Parallel research subagents** (web + codebase + OWASP) → Phase 3: Task list + waves → Phase 4: **Plan evaluator subagent** (separate context) |
| `/dev` (345) + `/validate` (288 lines) | **dev-agent** (3-phase hybrid orchestrator) | Phase 1: Implementation (parallel wave subagents) → Phase 2: `forge validate` (CLI, deterministic) → Phase 3: **Code evaluator subagent** (separate context, 5-dim rubric) |
| `/ship` (212) + `/premerge` (186 lines) | **ship-agent** (2-phase) | Phase 1: Doc detection + updates (`forge docs detect/verify` script + agent writes) → Phase 2: `forge pr create` (idempotent) |
| `/review` (448 lines) | **review-agent** (3-layer intelligence) | Layer 1: Pre-flight checks (branch, conflicts, CI, unpushed) → Layer 2: Universal comment parsing (all review tools) → Layer 3: Timing intelligence + reply-and-resolve enforcement |
| `/verify` (269 lines) | **verify-agent** | Post-merge health check, beads close, worktree cleanup |
| `/rollback` (721 lines) | **rollback-agent** | Emergency only. Lazy-loaded — not part of normal flow. |
| `/status` (90 lines) | `forge info` CLI command | Not an agent — state query. |
| `/sonarcloud` (152 lines) | **sonarcloud skill** | Stateless API fetch. |
| `/research` (42 lines) | **Delete** | Deprecated alias. |

**Total**: 3,379 lines across 10 commands → ~1,500 lines across 5 lean agent definitions (55% reduction by stripping non-load-bearing overhead).

**Workflow becomes**: `/plan` → `/dev` (3 phases) → `/ship` (2 phases) → `/review` → `/verify`

#### Why hybrid orchestrator pattern (Anthropic principle: separate generator from evaluator)

Both plan-agent and dev-agent use the same architecture:

```
Main agent (orchestrator)
  ├── Phase 1: Generation work (own context, may spawn parallel workers)
  ├── Phase 2: Mechanical/CLI checks (no AI, deterministic)
  └── Phase 3: Evaluator subagent (SEPARATE CONTEXT — no orchestrator history)
       ├── Receives only artifacts (diff, design doc, test results)
       ├── Grades against rubric
       ├── Returns score JSON
       └── If below threshold → orchestrator revises and re-evaluates
```

The evaluator's separate context is **mandatory** — Anthropic's [Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) documents that models self-evaluate poorly when given their own work to grade. The plan-agent can't grade its own plan, the dev-agent can't grade its own code. Different prompts, different sessions, different context.

**Canonical stage definition format** (`.forge/stages/*.yaml`):

```yaml
# .forge/stages/dev.yaml — agent-agnostic, model-agnostic
name: dev
description: "TDD-first implementation with parallel execution of independent tasks"

purpose: "Implement tasks from plan using TDD, parallelizing where possible"
inputs:
  - ".forge/handoff/plan.json"    # includes parallel wave structure
  - "docs/plans/*-tasks.md"
outputs:
  - ".forge/handoff/dev.json"
  - "Committed code with passing tests"

hard_gates:
  - "Tests must exist BEFORE implementation code (per subagent)"
  - "All tests must pass before wave completes"
  - "`forge evaluate --quick` score >= 0.8"

workflow:
  - "Read task list + parallel waves from .forge/handoff/plan.json"
  - "For each wave:"
  - "  Dispatch independent tasks as parallel subagents (no file overlap)"
  - "  Each subagent: write failing test -> implement -> verify green -> refactor"
  - "  Wait for all subagents in wave to complete"
  - "  Run `forge test` (full suite — catch cross-task integration issues)"
  - "  Proceed to next wave"
  - "Write .forge/handoff/dev.json on completion"

forge_commands:
  - "forge issue update <id> --status=in_progress"
  - "forge test"
  - "forge evaluate --quick"
  - "forge issue close <id>"

# Plan handoff includes wave structure:
# { "waves": [
#     { "parallel": true, "tasks": ["task-1", "task-2", "task-4", "task-5"] },
#     { "parallel": false, "tasks": ["task-3"], "depends_on": ["task-1", "task-2"] }
# ]}
```

No model constraints. No tier logic. Assumes frontier model. Parallel where safe, sequential where dependent. ~Nx faster for ~1.4x cost via prompt caching.

**Generation: canonical → 6 agent formats**:

Different agents have different extension models. Some use agent definitions (files), others use modes (JSON config + file). `forge setup --agents` generates the correct format per agent:

```
.forge/stages/*.yaml (7 canonical definitions)
    │
    │  forge setup --agents
    │
    ├── Claude Code: .claude/agents/forge-<stage>.md
    │     Agent definitions with YAML frontmatter (tools, model, description)
    │
    ├── Cursor: .cursor/agents/forge-<stage>.md
    │     Agent definitions with frontmatter
    │
    ├── Codex: .codex/agents/forge-<stage>.md + AGENTS.md sections
    │     Agent definitions + shared instructions
    │
    ├── Copilot: .github/agents/forge-<stage>.md
    │     GitHub agent format
    │
    ├── Kilo Code: kilo.jsonc mode entries + .kilo/agents/forge-<stage>.md
    │     Custom MODES (not just agents) — user switches to "forge-dev" mode
    │     Mode config defines tools, permissions, groups, agent prompt file
    │
    ├── OpenCode: opencode.json agent entries + .opencode/agents/forge-<stage>.md
    │     Custom AGENTS in JSON config — defines permissions, tools, prompt file
    │
    └── AGENTS.md sections (universal fallback for all agents)
```

**Two types of generation**:

| Agent type | What's generated | Invocation |
|-----------|-----------------|-----------|
| **Agent-file agents** (Claude, Cursor, Codex, Copilot) | Markdown agent definition | User invokes agent by name: `@forge-dev` |
| **Mode-based agents** (Kilo, OpenCode) | JSON config entry + markdown prompt file | User switches mode: `forge-dev mode` then works |

7 canonical YAMLs × 6 templates = 42+ generated files (some agents need config + prompt). Maintained by editing 7 YAMLs + 6 templates (13 source files).

**What stays constant across ALL agents** (in canonical YAML):
- Hard gates, workflow steps, forge commands, inputs/outputs, handoff artifacts

**What varies per agent** (in EJS templates):
- **File format**: markdown frontmatter vs JSON config + markdown prompt
- **Extension model**: agent definition (Claude/Cursor/Codex/Copilot) vs custom mode (Kilo/OpenCode)
- **Tool syntax**: Agent tool (Claude) vs Task tool (Kilo) vs async subagents (Cursor) vs custom agents (OpenCode)
- **Tool permissions**: Each mode/agent declares which tools are available
- **Subagent dispatch**: Native tool per agent for parallel wave execution
- **Hook references**: PreToolUse (Claude/Cursor), event hooks (OpenCode), rules (Kilo)
- **MCP tool names vs CLI command equivalents**

#### Parallel Dispatch: Per-Agent Mechanics

*Full risk inventory: [ws2-dispatch-model-risks.md](ws2-dispatch-model-risks.md) (46 risks, 7 critical blockers)*

**Subagent dispatch matrix** (verified from official docs — 5 supported agents after Copilot was dropped):

| Capability | Claude Code | Codex | Cursor | Kilo Code | OpenCode |
|-----------|:-:|:-:|:-:|:-:|:-:|
| **Spawn tool** | Agent tool | Prompt-triggered | Internal (auto) | Task tool | Task tool |
| **Parallel dispatch** | Multiple Agent() in one turn | "spawn N agents" prompt | Multiple concurrent | Multiple Task() | Multiple Task() in one turn |
| **Async/background** | `run_in_background` | Parent waits | `is_background` (2.5+) | Parent waits | Parent waits |
| **Nested subagents** | Yes | Not documented | Yes (tree hierarchy) | Not documented | Not documented |
| **Custom agent defs** | `.claude/agents/*.md` | `.codex/agents/*.toml` | `.cursor/rules/*.mdc` | `.kilo/agent/*.md` / `kilo.jsonc` | `.opencode/agents/*.md` |
| **Worktree isolation** | Manual | Sandbox | Built-in (`/worktree`) | Agent Manager (UI) | Not built-in |

**Dispatch strategy per entry point** (all 5 supported agents):

| Entry point | Behavior |
|------------|----------|
| Agent as main (interactive) | Native parallel subagent dispatch via the agent's own spawn tool |
| Forge CLI as main (terminal) | `forge dev --parallel` spawns N processes |
| CI/headless | `forge dev --ci --parallel` spawns N processes |

**How forge CLI detects entry point** (prevents circular dispatch):

```
FORGE_INTERNAL=1        → forge is calling internal tools (skip hooks)
FORGE_ORCHESTRATOR=1    → forge CLI is the orchestrator (don't re-dispatch)
CLAUDE_CODE=1           → agent is main, forge returns wave info for native dispatch
CODEX_SANDBOX=1         → agent is main in Codex
CURSOR_TRACE_ID=x       → agent is main in Cursor
(no agent env var)      → terminal user, forge CLI orchestrates
```

**7 critical dispatch blockers** (from risk inventory):

| Blocker | Mitigation |
|---------|------------|
| Shared filesystem race conditions | Worktree isolation is non-negotiable for parallel writes |
| Circular dispatch (agent → forge → agent) | `FORGE_ORCHESTRATOR` env var prevents re-entry |
| IDE-bound agents can't run headless | External dispatch only for CLI-capable agents |
| SQLite contention from N parallel tasks | Orchestrator-only state writes (subagents report via result files) |
| Entry-point ambiguity | Env var detection matrix (above) |
| Result collection from N subagents | File-based contract: `.forge/results/<task-id>.json` |
| Straggler subagent blocks wave completion | Configurable timeout per task, skip straggler + log warning |

#### Efficiency Profiles

**Primary design target: Professional developers** (~65% of users). They know enough to value a structured workflow, are busy enough to want automation, but aren't building their own harness. Everything is optimized for this user first.

| Segment | % of users | Profile | Mindset |
|---------|:----------:|---------|---------|
| Solo dev / learner | ~20% | `efficient` | Learning, cost-sensitive, needs simplicity |
| **Professional dev** | **~65%** | **`balanced`** | **Ships features, wants speed + quality, doesn't want to configure anything** |
| Power user / team lead | ~15% | `performance` | Tweaks everything, burns tokens for max speed, contributes back |

**`balanced` is not just the default — it's the primary optimized path.** Every design decision is evaluated against: "does this help a professional dev ship features faster with confidence?"

```yaml
# .forge/config.yaml
profile: balanced    # efficient | balanced | performance
```

| Setting | Efficient | Balanced (PRIMARY) | Performance |
|---------|:---------:|:---------:|:----------:|
| `parallel_dispatch` | false | **true (up to 4)** | true (up to 8) |
| `evaluator` | skip | **on complex only (> 50 lines changed)** | always, full 5-dimension rubric |
| `context_pruning` | aggressive | **standard** | minimal (keep more context) |
| `subagent_limit` | 0 | **4** | 8 |
| `handoff_detail` | minimal | **standard** | verbose |

| Profile | Tokens per cycle | Relative cost | Speed | Target user |
|---------|:----------------:|:------------:|:-----:|:-----------:|
| Efficient | ~50K | 1x | ~10 min | Cost-constrained, simple tasks |
| **Balanced** | **~80K** | **1.6x** | **~4 min** | **Professional devs (daily driver)** |
| Performance | ~150K | 3x | ~2 min | Critical features, max quality |

**Design principles for balanced (the default experience)**:
- **Zero configuration**: `forge plan` → `forge dev` → `forge validate` → `forge ship` just works
- **Parallel by default**: independent tasks run in parallel waves automatically
- **Quality where it matters**: evaluator runs on complex changes, skips trivial ones
- **Structured handoffs always**: professionals work across sessions/machines — context must survive
- **forge issue / forge pr just work**: no manual sync, no Dolt, no configuration required
- **No knob-turning needed**: a professional dev reads AGENTS.md, runs forge, and ships

**When to switch profiles**:
- `efficient`: hit a cost wall, working on simple bug fixes, learning the workflow
- `performance`: critical feature, complex refactor, pre-release quality gate, team code review

Profiles tune knobs, not architecture. Same pipeline, different settings.

**Implementation phases**:

| Phase | Effort | Deliverable |
|-------|--------|-------------|
| 1: Write 7 canonical YAMLs | 3 days | Strip current commands to essential workflow. Include wave structure spec. |
| 2: Claude Code + Cursor templates | 2 days | Native subagent dispatch syntax. Worktree isolation for Cursor. |
| 3: Codex + Kilo + OpenCode templates | 2 days | Mode-based (Kilo/OpenCode) + prompt-triggered (Codex). |
| 4: External dispatch fallback | 1 day | `forge dev --parallel` for terminal-as-orchestrator pattern (used when not running inside an agent). |
| 5: Profiles + wave-compute | 2 days | `.forge/config.yaml` profile system. `forge wave-compute` from task deps + file overlap. |
| 6: Deprecation + cleanup | 1 day | `.claude/commands/` emits warnings. Delete `/research`. |

**Effort**: 2.5 weeks

---

### WS3: Beads Wrapper + Fix Dual-Database Core Issues (REVISED)

**Revision history**: Original WS3 proposed building forge-issues MCP server from scratch (8-22 weeks). Beads evaluator found this would lose 50+ bd commands, inherit the same WSL/Windows binary problem via better-sqlite3, and break the skill ecosystem. **Right-sized scope: keep beads, fix the dual-database core issues, add a thin wrapper + cloud adapter (4-5 weeks total — initial 2-3 week estimate grew after Component 2 expanded to include real-time bidirectional GitHub sync with daemon, inbound flow, and dep cycle handling).**

**Problem**: Beads has good fundamentals (50+ commands, dependency tracking, FTS5 search, memories, history via Dolt), but specific operational pain:
- Manual `bd dolt push/pull` sync — manual step that gets forgotten
- Per-worktree Dolt servers — N servers, divergent state
- Cross-worktree state divergence (each `.beads/` is a copy)
- WSL/Windows Dolt binary friction
- 5 documented upstream bugs requiring workarounds in `lib/beads-setup.js`

**Critical pain (must be fixed properly)**: The whole forge workflow — file updates, handoff state, evaluator results — depends on beads state being **consistent across worktrees**. Any divergence breaks the workflow. This is the core issue that must not slip.

**Solution**: Thin wrapper + targeted fixes. Keep beads. Add cloud-agent adapter for Codex/Copilot.

#### Component 1: Shared Dolt launcher (2-3 days)

```
Today (broken):
  worktree-1/.beads/  → runs its own Dolt server on port 47000
  worktree-2/.beads/  → runs its own Dolt server on port 47001
  worktree-3/.beads/  → runs its own Dolt server on port 47002
  → Each has independent state. Sync requires manual push/pull.

After fix:
  Main repo: .beads/  → runs ONE Dolt server on port 47000
  worktree-1/.beads/config.yaml  → connects to main repo's port 47000
  worktree-2/.beads/config.yaml  → connects to main repo's port 47000
  worktree-3/.beads/config.yaml  → connects to main repo's port 47000
  → Shared state. Zero divergence. Concurrent access handled by Dolt natively.
```

`forge worktree create` writes a thin config pointing to the main repo's Dolt server instead of calling `copyBeadsDir()`. Dolt handles concurrent connections natively (it's a SQL server).

**Solves**: Per-worktree servers + worktree divergence + the "files updated based on stale state" problem.

#### Component 2: Bidirectional GitHub Issues sync (2-2.5 weeks)

This is the **real-time sync layer** that makes multi-developer and multi-session workflows clean. Beads is the local-fast cache; **GitHub Issues is the cross-machine source of truth**.

**Architecture**:

```
┌─────────────────────────────────────────────┐
│            GitHub Issues                     │
│     (real-time source of truth)              │
└──────▲──────────────────────────▲────────────┘
       │ INBOUND                  │ OUTBOUND
       │ Pull from GitHub:        │ Push to GitHub:
       │ - on every forge cmd     │ - debounced, 1-2s after
       │ - on session start       │   any forge issue change
       │ - on git post-merge      │ - on git pre-push (flush)
       │ - on daemon poll (30min) │ - on forge issues sync
       │ - on webhook (opt-in)    │
       │                          │
       ▼                          │
┌─────────────────────────────────────────────┐
│      Local Beads (shared Dolt server)        │
│      Single cache for all worktrees          │
└──────────────────────────────────────────────┘
```

**Sub-components**:

| Sub | Purpose | Effort |
|-----|---------|--------|
| 2a | `forge issues sync` wrapper (manual flush + git hooks) | 1-2 days |
| 2b | Outbound queue (Beads → GitHub, debounced 1s, background) | 3-4 days |
| 2c | Inbound pull Method 1 (on every forge issue command) | 2-3 days |
| 2d | Inbound pull Method 2 (sync daemon, **30-minute polling**) | 2-3 days |
| 2e | Mapping table + serialization (forge metadata in issue body OR bot comment) | 1-2 days |
| 2f | Conflict resolution (last-write-wins per field, surface true conflicts) | 2-3 days |
| 2g | Inbound webhook (Method 3, opt-in for teams needing real-time) | 3-4 days (optional) |
| 2h | External issue defaults + auto-classification | 1 day |
| 2i | Hooks integration (pre-push, post-merge, session-start) | 1 day |

**Default sync model: Method 1 + Method 2 (30-minute daemon)**:
- **Method 1** — Pull triggered on every forge issue command. Active developers get near-zero latency.
- **Method 2** — Background daemon polls every 30 minutes. Idle developers stay current without command-driven pulls.
- **Method 3 (webhook)** — Opt-in for teams that need true real-time. Requires public URL or tunnel.

**Beads is no longer pushed to git**: GitHub Issues is the cross-machine truth. Local `.beads/dolt/` becomes a regenerable cache. Only `.beads/config.yaml` stays in git. **No more JSONL merge conflicts**.

```gitignore
# .gitignore additions
.beads/dolt/
.beads/issues.jsonl
.beads/team-map.jsonl
.beads/sync-queue.jsonl
.beads/.forge-dolt-server.*
.beads/cache/

# KEEP in git:
# .beads/config.yaml
```

**Inbound flow (handles random external contributors)**:

```
Random contributor opens GitHub issue #99 via web UI
  (never heard of forge, no forge metadata)
  ↓
Daemon polls (within 30 min) OR developer runs forge command
  ↓
gh issue list --since=<last-poll> returns #99
  ↓
External classifier parses title/body/labels → defaults:
  priority=P2 (no forge:Pn label)
  type=bug (label "bug" present) or task
  status=open
  dependencies=none
  ↓
Mirror to local Beads as forge-gh-99 (untracked)
  ↓
Default forge issue ready DOES NOT show it
  ↓
forge status surfaces it in the Ready group (with score-boosted recency for new external issues)
  ↓
Maintainer triages: forge issue track forge-gh-99 --priority=1
  OR auto-tracked when first interacted with (forge issue dep add, forge issue assign)
  ↓
forge:tracked label added on GitHub
  ↓
All developers' next pull see the tracked label, include in workflow
```

**Mirror all + filter on display**:
- All GitHub issues mirrored locally (searchable, full context)
- Default views (`forge issue ready`, `forge status`) filter to tracked issues
- Smart status (WS1) groups external/untracked issues for triage
- Implicit tracking: first interaction (`forge issue dep add`, `forge issue assign`) auto-promotes external → tracked

**Dependency storage on GitHub**: bot comment with fenced metadata block

```
Bot comment on issue #99:
<!-- forge-deps -->
```yaml
depends_on: [#95, #98]
blocks: [#100]
forge_priority: P1
forge_type: bug
forge_state: in_progress
```
<!-- /forge-deps -->

*This comment is managed by Forge. Edit dependencies via `forge issue dep add/remove`.*
```

Bot comment chosen over body metadata block because: (a) less risk of human edits corrupting it, (b) clearly bot-managed, (c) doesn't pollute issue body for non-forge users.

**Cross-machine dependency cycles**: When two developers create cycles offline (A: dep_add #99→#95, B: dep_add #95→#99), forge detects on next sync. Surfaces loudly: "Cycle detected after sync. Resolve manually with `forge issue dep remove`." Doesn't auto-resolve.

**Conflict resolution**: Last-write-wins per field (status, priority, labels). Comments append-only (no conflict). Dependencies use add/remove sets (no conflict). Genuine field conflicts (both edit same field at same time) surface to second-pulling developer with "keep local or remote?" prompt.

**Effort**: 2-2.5 weeks (up from 1-2 days). Component 2g (webhook) is optional and can be deferred.

#### Component 3: Cloud-agent CLI adapter (1 week) — **the only genuinely new piece**

For Codex cloud sandbox, Copilot coding agent, and CI environments where there's no persistent `.git/`:

```
forge issue create "Fix auth bug" --priority=1
  │
  ├── Detects environment:
  │     ├── Has .git/ + beads available?
  │     │     └── Routes to: bd create + sync queue
  │     │
  │     └── No .git/ (cloud agent / CI / ephemeral)?
  │           └── Routes to: gh issue create directly (with forge labels)
  │
  └── Same CLI interface either way — agent doesn't know
```

**Solves**: Codex/Copilot/CI support without local state. The agent always calls `forge issue create` — forge picks the right backend.

#### Component 4: Configurable issue backend interface (future-friendly)

Forge wraps issue operations behind an interface:

```
interface IssueBackend {
  create(title, body, priority, type): Issue
  close(id): void
  ready(): Issue[]
  blocked(): Issue[]
  dep_add(from, to): void
  ...
}

class BeadsBackend implements IssueBackend  // default
class GitHubIssuesBackend implements IssueBackend  // cloud agents
class LinearBackend implements IssueBackend  // future
class JiraBackend implements IssueBackend  // future
```

V2 ships BeadsBackend + GitHubIssuesBackend. Linear/Jira adapters become **community contributions** when the project goes open source. The headline value prop ("fast capture from inside the workflow") becomes more powerful when users can route captures to whatever issue tracker their team uses.

#### Component 5: Fork beads, fix the 5 upstream bugs, file PRs (2-3 weeks, parallel work, deferred to v3 if solo engineer)

The 5 documented upstream bugs (from `2026-03-22-upstream-beads-issues.md`):
1. Empty JSONL fails `bd create` (High) — currently worked around with `preSeedJsonl()`
2. `bd init` overwrites git hooks without asking (High) — worked around with `safeBeadsInit()`
3. `--prefix` flag not persisted (Medium) — worked around with direct config write
4. `bd sync` reports wrong count in no-db mode (Low)
5. Dolt files created even with `no-db: true` (Medium) — worked around with custom .gitignore

Forking beads, fixing these, filing upstream PRs — and using the fork until they merge — eliminates the workaround tax permanently. ~200-500 LOC of Go.

**Pairs with**: a future forge-team pivot research doc (not yet written) — specifically relevant if a Go-experienced contributor is available to maintain the upstream beads fork.

#### What's preserved

ALL beads features stay: ready/blocked/dep/prime/memories/comments/state/search/lint/defer/supersede/stale/orphans/preflight/history/diff/restore/find-duplicates/swarm/refile/gates/kv. The 14+ installed `beads:*` skills continue working. Existing forge code wired to `bd` (8+ files) keeps working unchanged.

#### What's eliminated

- Per-worktree Dolt servers
- Manual `bd dolt push/pull` UX
- Cross-worktree state divergence
- Workaround code in `lib/beads-setup.js` (after upstream PRs merge)

#### Effort

| Component | Effort |
|-----------|--------|
| 1. Shared Dolt launcher | 2-3 days |
| 2. Bidirectional GitHub Issues sync (2a-2i) | 2.5-3.5 weeks (was 2-2.5; expanded after feasibility check flagged 9 sub-components as optimistic for 2-2.5w) |
| 3. Cloud-agent CLI adapter | 1 week |
| 4. Configurable issue backend interface | 2-3 days (interface only; concrete adapters in v3) |
| 5. Fork beads + fix 5 bugs + file PRs | 2-3 weeks (parallel, Go work) |

**Total: 5-6 weeks for components 1-4** (was 4-5w; honest re-baseline after Component 2 grew from 2-2.5w to 2.5-3.5w per feasibility evaluator). Component 5 (fork beads) is parallel Go work, deferred to v3 if solo engineer.

**Down from**: 8-22 weeks for the original rewrite proposal. Still preserves all 50+ beads commands, all skills, all existing forge integration. The expansion from 2-3 weeks (initial estimate) to 4-5 weeks is because Component 2 grew to include real-time bidirectional GitHub sync with daemon + inbound flow + dep cycle handling — which is what makes the multi-developer / multi-session story actually work.

#### Rollback path

If WS3 ships and causes problems for early adopters, the rollback is clean:

1. **Disable shared Dolt launcher**: Worktrees fall back to per-worktree `.beads/` (current behavior). Set `forge config set beads.shared_server=false`.
2. **Disable bidirectional GitHub sync**: `forge config set issues.sync.github=false`. Falls back to manual `bd dolt push/pull` (current behavior).
3. **Re-enable git tracking of `.beads/`**: Remove the new `.gitignore` entries. Beads JSONL goes back into git.
4. **Cloud-agent CLI adapter is additive**: No rollback needed — it only activates when no `.git/` is present.

Each component is independently togglable. No "all or nothing" risk. The wrapper approach means we never throw away beads, so reverting is just disabling the wrapper layer.

---

### WS3-OBSOLETE: Original Event-Sourced MCP Server Proposal (DELETED 2026-04-07)

**This section was the original WS3 proposal to build a forge-issues MCP server from scratch (8-22 weeks). It was rejected after evaluator synthesis identified that it would lose 50+ beads commands, inherit the same WSL/Windows binary problem via better-sqlite3, and break the skill ecosystem. Replaced with the thin-wrapper approach in WS3 above (4-5 weeks).**

**For the historical reasoning, see [v2-evaluator-synthesis.md](v2-evaluator-synthesis.md). The beads-vs-forge-issues honest evaluator ran in read-only mode and its findings are inlined in v2-evaluator-synthesis.md (the "WS3 Bombshell" section) rather than as a standalone file.**

_(deleted — see above)_

_(see WS3 above for the actual approach: thin wrapper around beads, not a rewrite)_


---

### WS4: Context Engineering

**Problem**: 98.7KB of command prompts (~24.7K tokens), zero prompt caching, no context pruning between stages, fragmented stage transitions.

**Improvements (by priority)**:

| Priority | Improvement | Effort | Savings |
|----------|-------------|--------|---------|
| P0 | Structured handoff artifacts (`.forge/handoff/<stage>.json`) | 2-3h | 1,000 tokens/workflow |
| P1 | Context pruning at stage boundaries | 2-3h | 500 tokens/workflow |
| P2 | Prompt decomposition (split plan.md into 3 phases) | 4-5h | 300 tokens/workflow |
| P3 | Cache-friendly prompt ordering (static first, dynamic last) | 3-4h | 500 tokens/workflow |
| P4 | Shared system prompt cache across stages | 4-5h | 1,000 tokens/workflow |

**Handoff artifact format** (written by each stage, read by next):
```json
{
  "schema_version": 1,
  "stage": "dev",
  "completedAt": "2026-04-07T10:30:00Z",
  "issueId": "forge-abc",
  "summary": "Implemented 5/5 tasks from task list",
  "decisions": ["Used SQLite instead of Postgres per design doc"],
  "artifacts": ["src/auth.ts", "test/auth.test.ts"],
  "nextStageContext": "Ready for validate. All tests passing. No known issues.",
  "metrics": {"tasksCompleted": 5, "testsAdded": 12, "linesChanged": 340}
}
```

**Cross-agent**: Handoff files are Tier 1 (files on disk) — work for all 5 agents. Compaction hooks are Tier 4 (agent-specific bonus for Claude Code, Codex, OpenCode).

**Effort**: 2-3 days for P0+P1, 1 week for full set

---

### WS5: Evaluator Agent Pattern

**Problem**: `/validate` does mechanical checks only (type/lint/test/security). No code quality evaluation. `/dev` can self-approve without rigorous review. Anthropic found models are poor self-QA agents.

**Solution**: Separate evaluator with concrete grading criteria.

**5-Dimension Code Quality Rubric**:

| Dimension | Weight | Scores 0/1/2 |
|-----------|--------|---------------|
| Correctness | 40% | Broken / Partial / Complete |
| Maintainability | 25% | Unreadable / Adequate / Clean |
| Security | 20% | Vulnerable / Partial / Hardened |
| Test Coverage | 10% | None / Partial / Comprehensive |
| Performance | 5% | Pathological / Acceptable / Optimized |

**Grading**: Weighted sum -> A (>= 1.6), B (>= 1.2), C (>= 0.8), Fail (< 0.8)

**Integration (by invocation pattern)**:

| Pattern | When | How |
|---------|------|-----|
| Tier 2 (user -> forge) | User runs `forge evaluate` | CLI runs rubric check |
| Tier 3 (git hook) | Pre-push | `forge evaluate --quick` (correctness + security only) |
| Tier 5 (subagent) | After `/dev` completes | Forge spawns evaluator subagent with different prompt |
| Adaptive | Auto-detect | Skip for simple tasks (< 50 lines changed), full eval for complex |

**Evaluator trace logging**: `.forge/eval-traces/<date>-<issue>.json` — enables iterative prompt improvement.

**Cross-agent**: Rubric lives in `.forge/rubric.json` (Tier 1). `forge evaluate` is CLI (Tier 2). Subagent spawning is Tier 5 (all 5 agents support it).

**Effort**: 2-3 weeks

---

### WS6: Parallel Agent Teams

**Problem**: `/dev` runs tasks sequentially. No parallel task dispatch, no concurrent write safety, no agent-team protocol. Beads `parallelTracks` field exists but is never populated.

**Improvements (tiered)**:

| Tier | Feature | Effort |
|------|---------|--------|
| 1 | Parallel task dispatch (file-overlap analysis in /plan, safe groups in /dev) | 2-3 weeks |
| 2 | Concurrent write safety (optimistic locking in Beads) | 1 week |
| 3 | Agent-team protocol (task queue, claim, heartbeat, result reporting) | 2-3 weeks |
| 4 | Test result sharing (cache .test-results.json) | 1 week |

**Prompt caching economics**: N parallel subagents with shared system prompt cost ~1.4x one agent (not Nx), because cached tokens are 10% cost. This makes parallel dispatch economically viable.

**Cross-agent parallel execution**:

| Agent | Internal parallel | External parallel |
|-------|:-:|:-:|
| Claude Code | Subagent tool (spawn N workers) | N terminal instances |
| Codex | Subagents | Background agents (cloud) |
| Kilo Code | Task tool | N terminal instances |
| OpenCode | Custom agents | N terminal instances |
| Cursor | Async subagents + background agents | N terminal instances |
| Copilot | Runtime subagents | GitHub Actions CI |

**Effort**: 6-8 weeks total (phased)

---

### WS7: Safety & Auto Mode

**Problem**: No secret detection, no incident logging, no action classifier. Only git hooks (Lefthook) and forge CLI provide safety. 4 of 5 agents lack agent-level safety rules.

**Proposed unified safety layer**:

| Layer | Mechanism | Coverage |
|-------|-----------|----------|
| 1. Git hooks | Lefthook pre-commit/pre-push | All 5 agents |
| 2. Forge CLI gates | `forge push`, `forge test` enforce checks | All 5 agents |
| 3. Secret detection | Scan staged files for credentials, tokens, keys | All 5 agents |
| 4. Dangerous ops registry | `.forge/safety/dangerous-operations.yml` | All 5 agents |
| 5. Agent hooks | PreToolUse blocks on dangerous patterns | All 5 agents |
| 6. Incident log | `.forge/incidents.jsonl` — append-only audit trail | All 5 agents |

**Modes**:
- `--safe` (default): All gates active, blocks risky operations
- `--yolo` (opt-in): Skip non-critical gates, log everything, require explicit acknowledgment

**Effort**: 2-3 weeks

---

### WS8: Long-Running Harness

**Problem**: No explicit initializer agent, no auto session recovery, handoff artifacts are advisory-only (not enforced), no autonomous loop.

**Improvements**:

| Feature | Tier | Description |
|---------|------|-------------|
| Initializer check | Tier 2 | `forge init-session` — reads .forge/progress.md, runs bd prime, loads handoff artifacts |
| Progress file | Tier 1 | Auto-written `.forge/progress.md` at every stage exit |
| Session handoff | Tier 1 | `.forge/SESSION_HANDOFF.md` — structured summary for next session |
| HARD-GATE enforcement | Tier 2 | `/validate` and `/ship` gates reject if handoff fields missing |
| Autonomous loop | Tier 2 | `forge loop` — runs /dev -> /validate cycle until all tasks complete |

**Cross-agent session recovery**:

| Agent | Recovery mechanism |
|-------|-------------------|
| Claude Code | `bd prime` + `.forge/progress.md` + compaction hooks |
| Codex | `.forge/progress.md` + AGENTS.md instructions |
| Kilo Code | `.forge/progress.md` + workflow state |
| OpenCode | `.forge/progress.md` + compaction plugin hook |
| Cursor | `.forge/progress.md` + rules |
| Copilot | `.forge/progress.md` + instructions |

**Effort**: 2-3 weeks

---

### WS10: Universal Review System

**Problem**: Current `/review` is Greptile-centric. Modern PR review involves Greptile + CodeRabbit + Qodo + SonarCloud + GitHub Actions + Codex + human reviewers, each with different comment formats. Agents often miss outside-diff comments, ignore branch state, fail to reply/resolve threads, and run review tools on broken code.

**Resolves beads**: forge-m0fw (universal review system), forge-r6u3 (validate naming overload).

#### Three-layer review-agent architecture

**Layer 1: Pre-flight checks (mandatory before any review work)**

| Check | Action if fails |
|-------|----------------|
| Branch behind base? | Use rebase-decision skill to choose: auto-rebase, ask user, or stop |
| Merge conflicts predicted? | Stop, surface conflicts to user |
| Unpushed local commits? | Push first |
| CI green on latest commit? | If CI failing → fix CI failures BEFORE handling review comments |
| Tests passing? | Same — tests > review comments. Fix tests first. |

**Layer 2: Universal comment parsing**

One unified `NormalizedComment` interface for all review tools (no separate skill per tool — 80% duplication avoided):

```typescript
interface NormalizedComment {
  source: 'greptile' | 'coderabbit' | 'qodo' | 'sonarcloud' | 'gh-actions' | 'codex' | 'human';
  type: 'inline' | 'summary' | 'outside-diff' | 'check-annotation' | 'suggestion' | 'general';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  confidence: number;       // 0-1, when tool provides it
  file: string | null;
  line: number | null;
  message: string;
  suggestion: string | null;
  fixPrompt: string | null; // AI fix prompt if tool provides one
  threadId: string;
  isResolved: boolean;
}
```

**Source detection by bot username**: greptile-apps, coderabbitai, qodo-merge-pro, sonarcloud, github-actions, codex, etc. Pluggable parser modules in `lib/review/parsers/`.

**Actionability scoring**: `severity×3 + confidence×2 + effort_inverse + scope`

**Priority order**: security > correctness > quality > style

**Layer 3: Timing intelligence + reply-and-resolve enforcement**

**Timing detection** (no heuristic guessing — check actual state):
```
For each review bot:
  ├── Query GitHub for comments by bot since last push timestamp
  ├── Query GitHub for check runs by bot since last push
  ├── If neither exists → tool is still processing
  └── If either exists → tool has responded
```

**Push strategy decision**:
- **Test fix** → push immediately (don't wait for review tools)
- **Review fix bundle** → check if review tools have responded; if all done, bundle and push; if some still processing, push the test fix and wait for them
- **Multiple review fixes** → batch into single commit/push to trigger single re-review cycle

**Mandatory reply-and-resolve enforcement** (the accountability mechanism):

For EVERY review comment (inline, summary, outside-diff):
```
1. Read and understand the issue
2. Decide: actionable or not actionable
3a. If actionable:
    - Fix the code
    - Commit the fix
    - Reply to thread: "Fixed in <commit-sha>: <what was changed>"
    - Resolve the thread (GraphQL resolveReviewThread)
3b. If not actionable (false positive or wrong):
    - Reply to thread: "Not applicable: <reason>"
    - Resolve the thread
4. NEVER skip a comment silently — every thread must have a reply + be resolved
```

**Why this is the verification mechanism**: Auditors can verify "did the agent address all 12 review comments?" → query GitHub, count threads with replies + isResolved=true. Branch protection blocks merge if any thread unresolved.

#### Best practice: review tools run AFTER tests pass

`forge setup` configures the workflow so review tools (CodeRabbit, Greptile, etc.) only run after tests/lint/typecheck gates pass. No grading broken code.

```yaml
# Forge configures CI in this order:
1. Tests pass         ← gate
2. Lint passes        ← gate
3. Type check passes  ← gate
4. Then: review tools run (CodeRabbit, Greptile, Qodo, SonarCloud)
```

#### Skills used by review-agent

| Skill | Purpose |
|-------|---------|
| `rebase-decision` | When to auto-rebase vs ask vs stop. Includes recovery via reset to pre-rebase commit. |
| `pr-comment-handling` | Universal parser logic, actionability scoring, reply templates |
| `push-strategy` | When to push immediately vs batch vs wait for review tools |
| `tech-stack-skills` | Tech docs (via Context7) loaded for context-aware fix decisions |

**Effort**: 2-3 weeks

---

### WS11: Tech-Stack-Aware Skills (via Context7 MCP)

**Problem**: Generic evaluators grade code against outdated rules. A React 19 valid pattern may be flagged because the evaluator remembers React 17. Tests use different frameworks (Vitest, Jest, pytest, cargo test). Linting tools differ per stack (ESLint vs Ruff vs Clippy).

**Solution**: Auto-detect tech stack, fetch current docs via Context7 MCP, generate focused skills the evaluator and dev-agent use.

#### How it works (Context7 Skill Wizard pattern)

Context7 has `ctx7 skills generate` — an interactive AI flow that:
1. Searches Context7's indexed library DB
2. Asks clarifying questions to scope the skill
3. Pulls only relevant doc snippets (not full docs)
4. Generates focused SKILL.md with citations

Forge applies the same pattern:

```
forge tech-stack init
  ├── Auto-detect from manifests: package.json, requirements.txt, Cargo.toml, etc.
  ├── For each detected tech, calls Context7 MCP:
  │     resolve-library-id("React") → /facebook/react
  │     get-library-docs("/facebook/react", topic="hooks rules + patterns", tokens=5000)
  │
  ├── Generates focused skills (rules and patterns, not full docs):
  │     .forge/tech-skills/react-19-rules/SKILL.md
  │     .forge/tech-skills/typescript-5.4-strict/SKILL.md
  │     .forge/tech-skills/vitest-2.1-patterns/SKILL.md
  │
  └── Skills include citations: which Context7 doc each rule came from
```

#### Refresh triggers (all three)

| Trigger | When | Purpose |
|---------|------|---------|
| `forge plan` start | Every plan run | Plan-agent has fresh tech context for design decisions |
| Manifest change detection | `package.json` / `Cargo.toml` modified | Smart refresh on version bumps |
| Manual `forge tech-stack refresh` | User-initiated | Force refresh, override cache |

#### Fallback when Context7 unavailable

Forge ships with a **bundled curated skills library** for popular stacks:
- `.forge/bundled-skills/react/SKILL.md`
- `.forge/bundled-skills/typescript/SKILL.md`
- etc.

Used when Context7 MCP not installed or offline. Less current than Context7 but always available.

#### Test runner abstraction (bun is a layer, not the framework)

`forge test` detects the actual test framework from manifest:

| Language | Frameworks | Detection |
|----------|-----------|-----------|
| JS/TS | Vitest, Jest, Bun test, Mocha, Playwright | `package.json` `scripts.test` |
| Python | pytest, unittest, nose2 | `pyproject.toml` `tool.pytest` |
| Rust | cargo test, nextest | `Cargo.toml` |
| Go | go test, ginkgo | `go.mod` |
| Ruby | rspec, minitest | `Gemfile` |
| Java | JUnit, TestNG | `pom.xml` / `build.gradle` |

`forge test --affected` translates to the right framework command (vitest --changed, jest --changedSince, pytest --picked, cargo nextest --filter, etc.).

#### Linting tools per tech stack (~40+ tools, CodeRabbit-equivalent)

| Stack | Linters | Formatters | Type/Security |
|-------|---------|-----------|--------------|
| **JS/TS** | ESLint, Biome, JSHint | Prettier, Biome | tsc, Flow, npm audit, Snyk |
| **Python** | Ruff, Pylint, Flake8 | Black, Ruff format, isort | mypy, Pyright, Bandit, pip-audit |
| **Rust** | Clippy | rustfmt | cargo audit, cargo deny |
| **Go** | golangci-lint, staticcheck, vet | gofmt, goimports | gosec, govulncheck |
| **Ruby** | RuboCop, Standard | RuboCop | Brakeman, bundler-audit |
| **Java/Kotlin** | Checkstyle, PMD, SpotBugs, ktlint, detekt | google-java-format, ktfmt | OWASP dependency-check |
| **CSS/HTML** | Stylelint, htmlhint | Prettier | — |
| **Infra** | ShellCheck, yamllint, hadolint, tflint, tfsec, markdownlint | shfmt, prettier | — |
| **Universal** | gitleaks, trufflehog, detect-secrets | — | license-checker, Snyk |

`forge lint` auto-detects stack and runs the appropriate set. User can override:
```yaml
# .forge/lint.yaml
auto_detect: true
enabled: [eslint, prettier, tsc, gitleaks, hadolint]
disabled: [stylelint]  # no CSS in this project
```

**Effort**: 2 weeks

---

### WS12: Doc Automation (script + agent split)

**Problem**: Docs go stale. CHANGELOG forgotten. README sections referencing renamed functions. Design docs not updated. Currently manual.

**Solution**: Scripts detect what needs updating (deterministic), agent writes the updates (creative).

#### `forge docs detect` (script)

```
forge docs detect
  ├── Parses git diff against base branch
  ├── Parses recent commit messages (conventional commits)
  ├── Cross-references: which docs mention changed code?
  ├── Checks: CHANGELOG entry exists for this PR?
  ├── Checks: README sections referencing renamed/deleted functions?
  ├── Checks: API docs out of sync with current API?
  └── Outputs: .forge/results/docs-detect.json
       {
         "stale": ["docs/api.md (line 42)"],
         "missing": ["CHANGELOG entry for this PR"],
         "broken_refs": ["README mentions getUserById, renamed to fetchUser"]
       }
```

#### `forge docs verify` (script — gate)

```
forge docs verify
  ├── Runs detection
  ├── Exit 0 if no stale/missing/broken
  ├── Exit 1 if any required docs incomplete
  └── ship-agent uses this as gate before forge pr create
```

#### Agent role

Ship-agent reads detection output and writes the updates:
- Adds CHANGELOG entry with conventional commit context
- Updates README sections with new code references
- Updates API docs with current signatures
- Updates design docs if implementation diverged from plan

#### Document organization (research vs plans)

```
docs/
  plans/
    YYYY-MM-DD-<slug>-design.md       # Design intent + decisions
    YYYY-MM-DD-<slug>-tasks.md        # Task list with waves
    YYYY-MM-DD-<slug>-decisions.md    # Decision log
    YYYY-MM-DD-<slug>-results.md      # Evaluation scores (NEW)
    INDEX.md                          # Auto-generated index
  research/                            # NEW — separate from plans
    YYYY-MM-DD-<slug>-research.md     # Web research, exploration
    YYYY-MM-DD-<slug>-owasp.md        # Security analysis
```

**YAML frontmatter on every doc**:
```yaml
---
type: design | research | tasks | decisions | results
derived_from: <parent-slug or "user-request">
beads_id: forge-xxx
success_score: null  # filled by plan/dev evaluator
status: draft | approved | implemented | superseded
---
```

**Naming improvements** (beyond date):
- Type prefix: `feat-`, `fix-`, `epic-`, `refactor-`
- Example: `2026-04-07-feat-auth-design.md` instead of `2026-04-07-auth-design.md`

**Effort**: 1 week

---

### WS13: Universal Guardrails (Defense in Depth)

**Problem**: Agents can lie about completing stages. "Tests passed" without running them. "All comments resolved" without checking. Need verifiable proof at every stage.

**Solution**: Each stage has machine-checkable guardrails. Built into commands AND verified by next stage. Two layers — can't be bypassed.

#### Guardrails per stage

**plan-agent guardrails**:
- Design doc exists at `docs/plans/<slug>-design.md` with required sections
- Research doc exists at `docs/research/<slug>-research.md` (if research needed)
- `.forge/handoff/plan.json` has `waves` field with valid structure
- Each task has `files[]` and `depends_on[]`
- Plan evaluator score >= 0.8 (`.forge/results/plan-eval.json`)
- Beads issue created and linked

**dev-agent Phase 1 guardrails**:
- Each task has test commit BEFORE impl commit (`git log` ordering)
- All tasks closed in beads
- Test files exist for new source files

**dev-agent Phase 2 guardrails**:
- `forge lint` exit code 0, output saved to `.forge/results/lint.json`
- `forge typecheck` exit code 0, output saved
- `forge test` exit code 0, output saved with test count
- `forge security` exit code 0, output saved

**dev-agent Phase 3 guardrails**:
- `.forge/results/dev-eval.json` exists with score >= 0.8
- Trace log shows evaluator ran in separate session

**ship-agent guardrails**:
- `forge docs detect` ran and output saved
- `forge docs verify` exit code 0
- CHANGELOG entry exists for this PR
- PR exists (idempotent: `gh pr view <branch>` returns valid PR)
- PR body contains `Closes forge-xxx` for linked issues

**review-agent guardrails**:
- All pre-flight checks passed (branch up to date, CI green, no unpushed)
- For every review comment: thread has agent reply AND isResolved=true
- Test fixes committed before review fixes (ordering check)
- CI workflow order: tests → review tools (configured by forge setup)

**verify-agent guardrails**:
- PR merged (`gh pr view --json state` = MERGED)
- Main branch CI green
- Beads issue closed
- Worktree cleaned up

#### Enforcement mechanism (Option C: defense in depth)

```
Layer 1: Built into commands
  forge dev runs guardrails at end of each phase
  forge ship runs guardrails before creating PR
  forge review runs guardrails before declaring complete
  → Implicit, agent doesn't need to know

Layer 2: Next stage verifies previous stage's guardrails
  forge ship refuses to start until forge dev guardrails passed
  forge review refuses to start until forge ship guardrails passed
  → Even if agent skips a command, next stage catches it
```

#### Guardrail results format

Every stage writes `.forge/results/<stage>-guardrails.json`:
```json
{
  "stage": "dev",
  "completedAt": "2026-04-07T10:30:00Z",
  "checks": [
    {"name": "tests_pass", "passed": true, "evidence": ".forge/results/test.json"},
    {"name": "lint_pass", "passed": true, "evidence": ".forge/results/lint.json"},
    {"name": "evaluator_score", "passed": true, "score": 0.87, "threshold": 0.8}
  ],
  "all_passed": true
}
```

**Effort**: 1-2 weeks (mostly integration into existing commands)

---

### WS9: Eval Infrastructure

> **Note on workstream ordering**: WS9 appears at the end of the workstream list because it was added after WS10-WS13 during planning. Logically it groups with WS5 (evaluator) since both deal with measurement. The numbering is preserved to keep cross-doc references stable, but the conceptual order is: WS1 → WS2 → WS3 → WS4 → WS5 → WS9 → WS10 → WS11 → WS12 → WS13 (WS6, WS7, WS8 are cross-cutting; WS6 deferred to v3).

**Problem**: No workflow-level metrics, no A/B testing, no cross-agent parity testing. Can measure if individual commands succeed but not if the 7-stage workflow improves code quality.

**Improvements**:

| Phase | Feature | Effort |
|-------|---------|--------|
| 1 | Metrics observatory (`.forge/stage-metrics/`) | 1 week |
| 2 | A/B testing framework (variant eval runner) | 2 weeks |
| 3 | Cross-agent parity testing (nightly CI) | 2 weeks |

**Core metrics**:
- Command success rate (target: >95%)
- Hard-gate enforcement rate (target: 100%)
- Artifact compliance rate (target: 100%)
- Stage cycle time (target: <2min for validate)
- Flaky rate (target: 0%)
- Harness overhead (target: <20% of total time)

**Cross-agent parity**: Unified eval set (`.forge/eval-sets/core-workflow.json`), per-agent runners, comparison dashboard.

**Effort**: 5 weeks total (phased)

---

## 3. Prioritized Implementation Roadmap

### Right-sized roadmap: 12-14 weeks (revised)

**Reordering rationale** (per evaluator findings):
- WS4 (handoff schema) FIRST — foundation everything depends on
- WS3 (beads wrapper, NOT rewrite) early — fixes core dual-database issue before agents touch state
- WS13 (guardrails) BEFORE WS2 — verifies migration as it happens
- WS11 (Context7 skills) BEFORE WS5 — evaluator is context-aware day 1
- WS6 and WS9-P3 deferred to v3

### Phase 1: Foundation (Weeks 1-4)

| Week | Workstream | Deliverable | Impact |
|------|-----------|-------------|--------|
| 1 | WS4 (Context) | Handoff schema FROZEN — `.forge/handoff/<stage>.json` format + context pruning | Foundation for all consumers; schema versioning policy |
| 1 | WS3 (Beads wrapper) | Shared Dolt launcher + `forge issues sync` wrapper + git hooks | Solves per-worktree servers + divergence + manual sync (the core dual-database issue) |
| 2 | WS3 (Beads wrapper) | Cloud-agent CLI adapter (`forge issue` routes to `gh` for Codex/Copilot/CI) + configurable backend interface | Cloud agent support; future Linear/Jira adapters |
| 2 | WS1 (Pre-work) | Complete `agents-config.js` for all 5 agents + CI grep validation + `FORGE_INTERNAL` env var isolation | Unblocks all migration work |
| 3 | WS13 (Guardrails) | Per-stage guardrail checks + 2-layer enforcement (built-in + next-stage verification) | Migration is verifiable from day 1 |
| 3 | WS7 (Safety) | Secret detection + incident log + dangerous ops registry | Critical security gaps closed |
| 4 | WS11 (Tech-stack skills) | Context7 MCP integration + auto-detect from manifests + bundled fallback library | Evaluator gets context-aware skills before WS5 ships |
| 4 | WS8 (Long-running) | `.forge/progress.md` + `SESSION_HANDOFF.md` auto-write + session recovery | Cross-session continuity |

### Phase 2: Core Workflow (Weeks 5-8)

| Week | Workstream | Deliverable | Impact |
|------|-----------|-------------|--------|
| 5 | WS5 (Evaluator) | 5-dimension rubric + separate-context subagent + trace logging | Code quality evaluation with WS11 tech-aware skills |
| 5 | WS1 (Claude Code) | `forge pr create` (idempotent) + `forge info` + `forge rebase` + `forge audit` + MCP/CLI parity tests | Claude Code fully abstracted |
| 6 | WS2 (Claude Code) | Canonical YAMLs + Claude Code agent templates + dev-agent hybrid orchestrator (3 phases) + plan-agent (4 phases) | First agent fully on canonical workflow |
| 6 | WS1 (Codex + Cursor) | Generate configs for Codex + Cursor + advisory hooks | 3 of 5 agents using forge CLI |
| 7 | WS2 (All agents) | Generate agent templates for Codex, Kilo, OpenCode, Cursor | All 5 agents use the canonical workflow |
| 7 | WS1 (All 5 agents) | Kilo/OpenCode configs + cross-platform testing | All 5 agents migrated |
| 8 | WS7 (Safety) | `--safe`/`--yolo` modes + unified safety layer + dangerous-operations.yml | Safety across all agents |
| 8 | WS9 (Eval) | Metrics observatory (`.forge/stage-metrics/`) + per-stage measurement | Workflow-level visibility |

### Phase 3: Quality + Reach (Weeks 9-12)

| Week | Workstream | Deliverable | Impact |
|------|-----------|-------------|--------|
| 9 | WS10 (Review) | Universal NormalizedComment parser + 3-layer review-agent + bot detection by username | All review tools handled uniformly |
| 9 | WS10 (Review) | Pre-flight checks (branch state, conflicts, CI status, unpushed commits) | Branch state issues caught before review work |
| 10 | WS10 (Review) | Reply-and-resolve enforcement + timing intelligence + push strategy decision | Verifiable accountability + efficient pushes |
| 10 | WS12 (Doc automation) | `forge docs detect/verify` scripts + research/plans separation + INDEX.md generation | Automated doc updates |
| 11 | WS12 (Doc automation) | YAML frontmatter on all plan/research docs + naming conventions + ship-agent integration | Doc rot eliminated |
| 11 | WS9 (Eval) | A/B testing framework (variant eval runner) | Harness optimization |
| 12 | WS3 (Hardening) | Fork beads + fix 5 upstream bugs + file PRs (parallel work, can extend into Phase 4) | Eliminates workaround tax |
| 12 | WS1 (Enforcement) | PreToolUse hooks enforce forge-only usage | Abstraction enforcement (where supported) |

### Phase 4 (v2): Hardening + Polish (Weeks 13-14)

| Week | Workstream | Deliverable | Impact |
|------|-----------|-------------|--------|
| 13 | Cross-platform | Windows/WSL/macOS/Linux test matrix | Cross-platform reliability |
| 13 | Documentation | User guide, AGENTS.md update, migration guide from v1 | Adoption-ready |
| 14 | WS4 (Context) | Full prompt decomposition + cache-friendly ordering (P2-P4 of original WS4) | Token efficiency |
| 14 | Buffer | Schedule buffer for slips | Realistic timeline |

### Deferred to v3

| Workstream | Reason |
|-----------|--------|
| **WS6 (Parallel agent teams)** | Speed optimization, not load-bearing for the core problem. Complex coordination across 5 agents. |
| **WS9 Phase 3 (Cross-agent parity testing infra)** | Testing infrastructure, not features. Defer until v2 stable. |
| **Linear/Jira/Bitbucket issue backend adapters** | Community contribution opportunity once open source. |
| **Multi-tenant / team mode** | v3 territory. v2 is single-developer focused. |
| **Self-hosted model support** | v3. Requires different orchestration model. |
| **Web/dashboard UI for non-CLI users** | v3. Adds significant scope. |

### Phase 5 (post-v2): Harness Audit (Ongoing)

Per Anthropic's principle: "When a new model lands, re-examine the harness, stripping away pieces that are no longer load-bearing."

- Quarterly: Test if per-task subagent dispatch still needed (may not be with newer models)
- Quarterly: Test if evaluator is still load-bearing for routine tasks
- Quarterly: Test if HARD-GATE enforcement can be relaxed for trusted agents
- Monthly: Review eval traces for evaluator prompt improvement

---

## 4. Beads Evolution: Detailed Decision

### Why "Wrap Beads" (not replace, not rewrite)

| Option | Effort | Worktree divergence | Preserves bd features | Maintenance | Cross-agent |
|--------|--------|:-------------------:|:--------------------:|:-----------:|:-----------:|
| A: Fork Beads (SQLite replacement) | 5-7w | Still diverges (per-worktree copies) | Yes (if reimplemented) | High (own all bugs) | No (bd CLI only) |
| B: GitHub Issues primary (no local) | 2-3w | No divergence | **No** (loses memories, gates, history, etc.) | Low | Yes (gh CLI) |
| C: Hybrid hidden refs | 3-4w | Still diverges (per-worktree JSONL) | Yes | Medium | No (bd CLI only) |
| D: Forge-issues MCP rewrite (ORIGINAL WS3) | 8-22w | No divergence | **No** (loses 50+ commands) | Very high (reimplement everything) | Yes |
| **E: Wrap beads + shared Dolt + GitHub sync** | **4-5w** | **No divergence** | **Yes (all 50+ preserved)** | **Low** | **Yes via cloud adapter** |

**Option E (chosen)** is the only approach that solves the operational pain (per-worktree servers, manual sync, divergence) without losing beads features or accumulating maintenance burden. The decisive insight from the beads honest evaluator: **building forge-issues from scratch would lose 50+ bd commands and inherit the same WSL/Windows binary problems via better-sqlite3 that it claimed to fix**.

### What "Wrap" Means in Practice

The 5 components of WS3 (full details in WS3 section above):

1. **Shared Dolt launcher** — One Dolt server in main repo, all worktrees connect via TCP. Eliminates per-worktree servers and divergence. (2-3 days)
2. **Bidirectional GitHub Issues sync** — Background queue (Beads → GitHub), polling daemon (GitHub → Beads, 30-min interval), Method 1 pull on every forge issue command. (2-2.5 weeks)
3. **Cloud-agent CLI adapter** — `forge issue` routes to `gh` directly when no `.git/` is present, for Codex/Copilot/CI. (1 week)
4. **Configurable backend interface** — Plugin architecture so v3 can add Linear/Jira/GitLab adapters as community contributions. (2-3 days)
5. **Fork beads + fix 5 upstream bugs** — Eliminate workaround tax permanently. Parallel work, 2-3 weeks of Go. (Component 5 deferred to v3 for solo-engineer timeline.)

### What bd Features Are Preserved (all of them)

| Feature | Status |
|---------|--------|
| `bd ready` / `bd blocked` | ✓ Untouched |
| `bd dep add/remove/tree/cycles` | ✓ Untouched |
| `bd graph` (visualization) | ✓ Untouched |
| `bd prime` (session recovery) | ✓ Untouched |
| `bd memories` / `recall` / `forget` | ✓ Untouched |
| `bd comments add/list` | ✓ Untouched |
| `bd set-state` / `bd state` | ✓ Untouched |
| `bd search` (FTS) | ✓ Untouched |
| `bd export/import` JSONL | ✓ Untouched |
| `bd lint` (template validation) | ✓ Untouched |
| `bd defer/supersede/stale/orphans` | ✓ Untouched |
| `bd preflight` | ✓ Untouched |
| `bd history/diff/restore` (Dolt versioning) | ✓ Untouched (the actual unique beads capability) |
| `bd find-duplicates`, `bd swarm`, `bd refile` | ✓ Untouched |
| 14+ installed `beads:*` skills | ✓ Continue working unchanged |
| 11 forge lib files wired to `bd` | ✓ Continue working unchanged |

### What Changes for Users

| Before WS3 | After WS3 |
|-----------|-----------|
| `bd dolt push` / `bd dolt pull` (manual) | Automatic via git pre-push / post-merge hooks |
| Each worktree has own Dolt server | One shared Dolt server in main repo |
| Each worktree has independent state | All worktrees see same state |
| Beads JSONL pushed to git (merge conflicts) | Beads not in git — GitHub Issues is the cross-machine truth |
| New external GitHub issue invisible until manual sync | Visible within 30 min via daemon, instant on next forge command |
| Cloud agents (Codex/Copilot) can't use beads | `forge issue` CLI routes to `gh` directly |
| Random contributor opens issue → forgotten | Auto-mirrored, surfaced in `forge status`, smart-classified |

### Limitations & Risk Mitigations

Full inventory: **[forge-issues-risk-inventory.md](forge-issues-risk-inventory.md)** (note: this inventory was written for the ORIGINAL rewrite proposal — many risks no longer apply since we're wrapping beads, not replacing it).

**Risks that still apply to the wrapper approach**:
- **Shared Dolt launcher is a Single Point of Failure** → all worktrees connect to one server. If it crashes, all forge issue commands fail across all worktrees. Mitigations: (a) auto-restart watchdog on every forge command, (b) PID + port file recovery, (c) graceful error: "Dolt server unreachable, retrying..." instead of corrupted writes, (d) state survives crash (Dolt files on disk are crash-safe). **Document this as the most important new failure mode introduced by WS3.**
- GitHub secondary rate limit (20 mutations/min) → background queue with backoff + GraphQL batching
- WSL + Windows simultaneous Dolt server access → detect and warn, document one-OS-at-a-time
- Dependency metadata in bot comments fragile if humans edit → detect tampering via timestamp + hash, restore on next sync
- Non-GitHub platforms (GitLab/Bitbucket/Linear/Jira) → configurable backend interface ships in v2; concrete adapters in v3

**Risks that DISAPPEAR with the wrapper approach** (vs original rewrite):
- ~~SQLite WAL corruption~~ — Dolt handles its own storage
- ~~JSONL concurrent writes~~ — not the write path
- ~~better-sqlite3 cross-platform binary issues~~ — using existing Dolt binary
- ~~Schema migrations~~ — beads owns the schema
- ~~Loss of bd features~~ — all preserved
- ~~Skill ecosystem break~~ — beads:* skills continue working

---

## 4.5. The Evaluator Agent Pattern (Used Throughout This Plan)

This entire strategy was built using the Anthropic GAN-inspired evaluator pattern from [Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps). It is not a coincidence that the same pattern is also baked into the v2 architecture (plan-agent Phase 4, dev-agent Phase 3 — separate-context evaluators that grade their own orchestrator's work).

### How the pattern was used during planning

During the planning conversation that produced this doc, evaluator agents were spawned with **fresh context** (no conversation history) to grade the plan. They produced consistently brutal feedback because they couldn't be persuaded by the orchestrator's reasoning chain.

| Evaluator pass | Score | Grade | Key finding |
|---------------|:-----:|:-----:|------------|
| Initial v2 (after first research) | 0.80/2.00 | C (40%) | Scope discipline failure: WS3 over-scoped 5-10x, wrong workstream ordering, "stop doing" not applied |
| External value evaluator | 3/10 | — | "Internal tool dressed up as a product" — recommended pivot to single-feature `forge evaluate` |
| Beads vs forge-issues evaluator | — | — | Decisive: keep beads, build wrapper. Original WS3 would lose 50+ commands, inherit WSL/Windows binary problems via better-sqlite3 |
| After right-sizing | 1.45/2.00 | B (72.5%) | Scope discipline applied, ordering fixed, honest staffing |
| External value re-eval | 5.5/10 | — | "Mostly addresses concerns but smart status over-engineered" |
| Smart status focused eval | 5/10 → 7/10 MVP | — | Recommended cuts: 8 groups → 4, 6 modes → 2, drop morning/eod, drop delta tracking |
| Implementation feasibility | "optimistic by 50%" | — | Concrete codebase findings: smart-status.sh already 819 LOC, 9 plugin.json files exist |
| Final evaluation (after cleanup) | 1.725/2.00 | B+ (86%) | Ready to execute with minor revisions |

### Why fresh-context evaluators worked

The orchestrator (the long planning conversation) became invested in its own ideas. Twenty research agents agreeing was not validation — they all shared the same orchestrator's framing. Four fresh-context evaluators independently converging on "scope is wrong" was much stronger signal.

This is exactly Anthropic's finding from their harness design article applied recursively: **the planner cannot grade its own plan**. Forge's plan-agent Phase 4 and dev-agent Phase 3 both implement this pattern. So does forge's overall strategy doc — graded by the same pattern that the doc itself describes.

### How the pattern should be used during implementation

Every major implementation milestone should be graded by a separate-context evaluator before declaring done:

| Milestone | Evaluator question | Output |
|-----------|-------------------|--------|
| WS3 Component 1 (shared Dolt launcher) ships | "Does this actually solve worktree divergence under real concurrent load?" | Pass/fail with concrete test scenarios |
| WS3 Component 2 (GitHub sync) ships | "Are conflicts handled correctly when 2 developers edit offline simultaneously?" | Multi-developer scenario validation |
| WS1 (forge CLI + smart status) ships | "Are all 5 agents actually using forge commands or bypassing them? Is smart status useful daily?" | Cross-agent compliance check + dogfood log |
| WS2 (commands → agents) ships | "Does the canonical YAML → 6 agent format generation produce equivalent behavior?" | Cross-format diff |
| WS5 (evaluator) ships | "Is the rubric catching real issues or generating false alarms?" | Trace log review |
| WS10 (review system) ships | "Do all review tool comments get parsed correctly and resolved properly?" | Real PR validation |
| WS13 (guardrails) ships | "Can the agent bypass any guardrail by skipping a command?" | Adversarial test |

**Rule**: Every workstream's "done" must include passing a separate-context evaluator review. The evaluator gets only the code + tests + rubric, NOT the conversation that built it.

### Plan-vs-implementation calibration

If the implementation evaluator score drops below the planning evaluator score by more than 1 point, that's a signal that:
- The implementation diverged from the plan
- The plan was wrong about something
- The implementation has hidden problems the planner didn't see

In any case, pause and investigate before continuing. Don't ship "we'll fix it in v3" workarounds without explicit acknowledgment in the doc.

### Anti-pattern: Evaluator as rubber stamp

If the evaluator always agrees with the implementer, the evaluator is broken. Symptoms:
- Same evaluator instance reused across rounds (context contamination)
- Evaluator given the implementer's reasoning (not just the artifacts)
- Evaluator prompt biased toward "find what is good" instead of "find what is wrong"

Mitigation: rotate evaluator personas, never give the evaluator the implementer's chain-of-thought, write the rubric to ask "what would break this?" not "is this good?"

### The recursive proof

The plan you are reading is itself proof that the pattern works. Three score increases (C → B → B+) happened because three separate-context evaluators independently challenged the plan's assumptions. None of the improvements would have happened if the planner had only graded its own work.

**Forge v2 ships this pattern as a feature. The proof is the document that ships it.**

---

## 4.6. v3+ Vision: Autonomous Workflows and Self-Improvement

> ### ⚠️ SCOPE MARKER — READ BEFORE THIS SECTION
>
> **This entire section (4.6) is NOT v2 scope. Nothing here is committed. Nothing here is planned.**
>
> - No work in this section is on the v2 roadmap.
> - No timeline in this section applies to v2.
> - No effort estimate here affects the 13-15w / 22-26w v2 numbers.
> - No decision in this section can be used to add scope to v2.
>
> **Why this section exists**: to ensure v2 architecture decisions don't accidentally foreclose a v3+ path the team cares about. If a reviewer reads a v2 decision and thinks "but that prevents X later," this section is where X is documented.
>
> **How to use this section** (especially for agents reading the doc during implementation):
> - ✅ Check "does my v2 decision preserve this v3+ path?" before committing to an architecture change
> - ✅ Add to the "v2 decisions preserve v3+ optionality" table if you make a new load-bearing decision
> - ❌ Do NOT implement anything described here as part of v2
> - ❌ Do NOT treat any estimate, number, or claim here as validated
> - ❌ Do NOT quote value estimates (e.g., "~15% quality improvement") as if they were measured — they are speculative

**The big picture**: Forge v2 is a workflow harness. The v3+ vision is **running that workflow autonomously on any LLM, inside any runtime, driven by messaging or scripts instead of humans**. OpenClaw integration + open-source model support + Karpathy-style auto-research loops are the three pillars of that vision.

### Why commands → agents is the real unlock

The stated v2 benefit is "Claude Code is deprecating commands." The real reason is deeper: **commands are human-invoked, agents are invokable by anything**. Converting the 5-stage workflow from commands to canonical YAML + agent templates makes the workflow programmatically callable — by other agents, by scripts, by CI loops, by cron jobs, by external tools. This is the foundation for everything in v3+.

A human running `/plan` then `/dev` then `/ship` is one execution model. The agent architecture unlocks:
- **Continuous loops**: A script calls `forge plan` → `forge dev` → `forge ship` → loop. No human in the loop.
- **Conditional flows**: External event → forge runs the relevant stage → writes handoff → next trigger picks it up.
- **Swarm execution**: N agents running the workflow in parallel on N different features.
- **Self-invocation**: The evaluator scores the output, the planner reads the score, the next iteration adjusts.

v2 builds the foundation. v3+ builds on it.

### v3+ Goal 1: Open-source model support (OpenCode / Kilo / GLM-5 / Kimi K2.5 / Qwen 3 / DeepSeek R1)

Frontier models (Opus, GPT-5.4, Gemini 2.5 Pro) cost real money. A single dev running v2 on frontier models could burn $50-200/day in API costs. That prices out the open-source community and students entirely.

Open-source frontier models now hit **~80% of frontier performance** on coding tasks:
- GLM-5 — Zhipu's model, strong on long-horizon tasks
- Kimi K2.5 — Moonshot AI, excellent at reasoning and code
- Qwen 3 — Alibaba, best multilingual code model as of 2026
- DeepSeek R1 — reasoning-focused, cheap inference
- Llama 4 / Gemma 3 — Meta / Google open weights

**The 20% gap**: these models are slightly worse at multi-step planning, recovering from mistakes, and maintaining coherence across long tasks. **Forge's workflow structure closes the 20% gap through scaffolding**:
- Plan-agent's explicit phases compensate for weaker spontaneous planning
- Dev-agent's hard gates compensate for weaker error recovery
- Evaluator's separate context compensates for weaker self-assessment
- Structured handoffs compensate for weaker context management across stages

**v3+ delivery**:
- Forge agent templates ship with per-model tuning (open-source models get slightly more verbose prompts, stricter gates, more frequent checkpoints)
- Benchmark suite that runs the same workflow on frontier vs open-source models and measures the delta
- Cost estimator: "this feature would cost $X on Opus, $Y on Kimi K2.5, $Z on GLM-5"
- Graceful degradation: start with open-source, escalate to frontier only for tasks the open-source model fails on

### v3+ Goal 2: Karpathy-style auto-research / self-improvement loops

Andrej Karpathy described a pattern where the model iterates on its own work: runs it, measures it, learns what didn't work, tries again. This is "auto-research" — the model doing research on its own behavior and improving it without human tuning. Applied to forge, this is the biggest long-term value multiplier because **it makes the workflow get better the more you use it, without any manual prompt engineering**.

**Three levels of auto-research for forge**:

#### Level 1: Per-execution refinement (one loop)

```
v2 workflow (human-driven, single-shot):
  Human → /plan → /dev → /validate → /ship → human reviews

v3+ Level 1 (self-refining, single task):
  Goal stated once → forge plan-agent generates N candidate plans (N=3-5)
                  → forge dev-agent implements each in parallel worktrees
                  → forge evaluator scores all N
                  → best-scoring plan becomes the winner, merged
                  → losers are analyzed: "why did this plan fail?"
                  → insights written to .forge/learnings/<date>-<slug>.md
                  → next task's plan-agent reads recent learnings
```

This is what Anthropic's "[Building a C compiler with parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)" article demonstrated: 16 parallel Claude instances building a C compiler via a Ralph-loop pattern, learning from failures, converging on a working solution.

Forge's architecture (canonical YAMLs + separate-context evaluators + parallel worktree dispatch) is **already the foundation** for this. The only missing piece is the learning feedback loop.

#### Level 2: Cross-execution learning (accumulated memory)

Over time, the forge workflow learns which patterns work for which contexts. Stored in a growing "learnings" corpus that plan-agent consults before each run.

```
Auto-research corpus (grows over time):
  .forge/learnings/
    ├── patterns/
    │   ├── auth-flows-that-work.md
    │   ├── database-migration-gotchas.md
    │   ├── test-patterns-for-async-code.md
    │   └── ...
    ├── anti-patterns/
    │   ├── overly-granular-task-decomposition.md
    │   ├── premature-mocking.md
    │   └── ...
    └── rubric-calibration/
        ├── what-really-matters-in-this-codebase.md
        └── ...
```

Each new task's plan-agent gets these as additional context. The more tasks the team runs through forge, the smarter it becomes at planning tasks for THIS specific codebase. This is **project-specific fine-tuning without actually fine-tuning the model** — just accumulating structured learnings.

**Specific v3+ possibilities at Level 2**:

- **Prompt library evolution**: The plan-agent's prompt is itself refined by running N variations on the same task, measuring which produces higher-scoring plans, keeping the best, discarding the rest. Over 100 tasks, the plan-agent prompt converges toward what actually works in this codebase.
- **Rubric auto-calibration**: The evaluator rubric weights (correctness 40%, maintainability 25%, etc.) are auto-tuned based on which issues actually caused bugs in shipped code. If the rubric scored something 0.9 but it caused a production bug 2 weeks later, that signal flows back — the weight for that dimension increases next time.
- **Task decomposition learning**: Over time, plan-agent learns which decompositions work for which domains. "Auth features decompose into these 5 steps. Database migrations decompose into these 3 steps. UI features decompose differently depending on whether state management is involved."
- **Cross-project learning**: Memories from past projects inform future planning (already partially supported by `bd memories`). In v3+, this becomes structured: each project exports its learnings corpus, and a new project can import baseline learnings from similar projects.
- **Hard-gate calibration**: Which hard gates actually catch real bugs vs which are ceremony? Auto-measured. Gates that never fire for 6 months get demoted to warnings. Gates that catch real issues stay hard.

#### Level 3: Meta-workflow improvement (forge improves itself)

The ultimate Karpathy-style loop: **forge runs on itself to improve forge**.

```
Meta-loop:
  ├── forge auto-research --target=forge
  ├── Analyzes: which forge v2 workflow stages produce the most rework?
  ├── Analyzes: which evaluator scores correlate with shipped quality?
  ├── Analyzes: where do developers bypass forge and go manual?
  ├── Generates hypotheses: "plan-agent's Phase 2 research is too shallow for X"
  ├── A/B tests the hypotheses: runs N tasks with current vs proposed workflow
  ├── Measures: did the proposed change actually improve outcomes?
  └── Ships winning changes to the forge canonical YAMLs
```

This is the Karpathy point taken to its conclusion: **the tool that builds software uses itself to build itself better**. Forge v2 architecture enables this because:
- Canonical YAMLs are data, not code — a loop can edit them
- Evaluator provides objective scoring
- Eval infrastructure (WS9) provides the measurement layer
- Git tracks everything, so reverting bad changes is cheap
- A/B testing is just running the same task with two canonical YAMLs

**Estimated value (SPECULATIVE — do not quote as measured)**:

> ⚠️ The numbers below are order-of-magnitude guesses extrapolated loosely from Anthropic's [Building a C compiler with parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler) article and general auto-research literature. They are NOT benchmarks, NOT measurements, NOT validated by forge-specific testing. Do not cite them in external communication. They exist only to sketch the rough shape of the potential upside.

- Level 1 (per-execution refinement): possibly ~15% quality improvement on hard tasks (speculative)
- Level 2 (accumulated learning): possibly ~30% over 6 months of use on the same codebase (speculative)
- Level 3 (meta-workflow improvement): potentially compounding if the feedback loop converges (speculative — could also diverge or hit a local optimum)

**What would make these numbers real**: ship v2, run forge on real projects for 3-6 months, measure quality metrics pre- and post-learning-loop. That's v3+ research work, not v2 scope.

This is why Goal 2 matters: **it's the path from "forge is a workflow harness" to "forge is a workflow harness that gets better on its own"**. Combined with Goal 1 (open-source models) and Goal 4 (OpenClaw runtime), the end state is: a free, local, self-improving AI software engineering workflow that any developer can run on their laptop.

**Why v2 preserves this path**:
- WS9 eval infrastructure ships the measurement layer auto-research needs
- WS5 separate-context evaluator provides objective scoring
- Canonical YAMLs are editable data, not hardcoded logic
- Structured handoff artifacts + result files create the audit trail auto-research analyzes
- Parallel worktree dispatch (WS6, deferred to v3) is the execution layer for N-candidate runs

**Why v2 does NOT build this yet**:
- We need real usage data before we know which learnings matter
- Premature auto-research loops risk converging on local optima
- Level 1 is tractable in v2.5 once v2 has real users
- Level 2 needs 3-6 months of accumulated data to be useful
- Level 3 is research-grade work, not v2 scope

The rule: **don't build auto-research in v2, but don't ship v2 in a way that prevents it either**. Every v2 decision should preserve the data/structure auto-research will need later.

### v3+ Goal 3: Autonomous long-running sessions

Anthropic's "Effective harnesses for long-running agents" article showed Opus 4.5 running for hours autonomously. Applied to forge:

```
forge autonomous start --goal "Add OAuth flow to the app"
  ├── Runs plan-agent (no human Q&A — infers from codebase)
  ├── Generates task list with waves
  ├── Runs dev-agent on each wave in parallel
  ├── Runs evaluator after each wave
  ├── On failure: auto-rolls back, tries alternative approach
  ├── On success: runs ship-agent, creates PR
  ├── Waits for review, handles review comments via review-agent
  └── Either merges (if authorized) or notifies human
  
Total human involvement: 1 goal statement.
Total time: hours to days.
Cost: whatever the model's API bill comes to.
```

**v2 ships the pieces. v3+ composes them into autonomous loops.**

### v3+ Goal 4: OpenClaw integration (autonomous agent runtime)

**[OpenClaw](https://openclaw.ai/)** ([GitHub](https://github.com/openclaw/openclaw), [Wikipedia](https://en.wikipedia.org/wiki/OpenClaw), [KDnuggets explainer](https://www.kdnuggets.com/openclaw-explained-the-free-ai-agent-tool-going-viral-already-in-2026)) is an open-source autonomous AI agent runtime by Peter Steinberger. According to public reporting [as of Feb 2026](https://www.kdnuggets.com/openclaw-explained-the-free-ai-agent-tool-going-viral-already-in-2026), the repository hit 100k GitHub stars within 3 months of launch and was described as a fast-growing OSS project. It runs agents locally, connects to any LLM (Claude, GPT, DeepSeek, and in principle open-source models like Kimi K2.5, GLM-5, Qwen 3 — forge would need to validate model compatibility), exposes itself via messaging platforms (Signal, Telegram, Discord, WhatsApp), and ships 100+ built-in skills.

> **Note**: Star counts and ecosystem claims above are from public reporting and may be out of date. Before committing to OpenClaw integration work in v3+, re-validate: (a) current star count and maintenance activity, (b) licensing compatibility with forge, (c) whether forge's open-source target models are actually supported by OpenClaw at that time.

**Why this matters for forge**: OpenClaw is the **runtime**, forge is the **workflow**. If forge v2's canonical YAML agent definitions can run inside OpenClaw, then:

- Any developer with OpenClaw installed gets the forge 5-stage TDD workflow "for free"
- Trigger forge stages via Signal/Telegram messages ("Forge: plan a new OAuth feature")
- Run forge autonomously on the user's machine (not cloud-dependent)
- Use any LLM the user prefers — frontier or open-source
- Inherits OpenClaw's 100+ skills (file ops, browser, email, calendar, system tools) alongside forge's workflow skills

**Technical integration path**:
1. Forge v2 ships canonical YAML stage definitions that are agent-runtime-agnostic
2. Write an adapter: `forge/runtime/openclaw.js` that translates forge stage YAML → OpenClaw skill format
3. OpenClaw users install a single `forge` OpenClaw skill that wraps the adapter
4. Invocation: "Forge: ship feature X" in Signal → OpenClaw routes to forge workflow → forge runs plan → dev → ship → review → verify → reports back to Signal

**Why forge v2's architecture makes this possible**:
- Canonical YAMLs (not Claude-Code-specific agent files) are portable to any runtime
- Forge CLI is the universal entry point — OpenClaw's skill wrapper just calls `forge plan`, `forge dev`, etc.
- `.forge/handoff/*.json` structured artifacts are runtime-agnostic
- MCP/CLI parity means OpenClaw can use either interface
- Model-agnostic stage definitions mean any LLM OpenClaw supports will work

**The 20% gap closer (HYPOTHESIS, not measured)**: OpenClaw users typically run on open-source models (cost-sensitive). Forge's workflow structure + hard gates + separate-context evaluator are exactly the scaffolding that SHOULD close the frontier-vs-open-source performance gap. The hypothesis we'd want to test in v3+: **forge + OpenClaw + a frontier open-source model might approach forge + Claude Code + Opus on routine tasks at a fraction of the API cost**.

> **Do not cite this as a measured result**: the cost/quality claim above is a hypothesis motivating v3+ research, not a benchmarked finding. Actual numbers depend on (a) which specific open-source model, (b) which task types, (c) how much of forge's workflow actually compensates for model weakness vs adds latency. v3+ Goal 2 (auto-research) is exactly how we'd validate this claim.

**What OpenClaw brings that forge doesn't (and shouldn't)**:
- Messaging platform interfaces (Signal, Telegram, Discord, WhatsApp) — forge doesn't need to build this
- System-level skills (email, calendar, browser, file ops) — forge shouldn't duplicate
- Local-first runtime — forge inherits this for free
- Cross-platform installer — OpenClaw handles it

**What forge brings that OpenClaw doesn't**:
- Software engineering discipline (TDD, dependency tracking, structured reviews)
- Multi-stage workflow with handoff artifacts
- Separate-context evaluator pattern
- Forge-specific skills (plan, dev, review, ship, verify)
- Git-native integration

**The combination is stronger than either alone.** OpenClaw is the autonomous runtime. Forge is the disciplined workflow. Integration is the v3+ killer app.

### v3+ Goal 5: Backend adapters beyond issue tracking

The configurable backend interface (WS3 Component 4) already supports plugin adapters for issue tracking. v3+ extends the pattern:

- **Plan backends**: Plan-agent's design doc could be stored in Notion, Obsidian, or a custom wiki instead of `docs/plans/`
- **Review backends**: The review-agent's NormalizedComment interface already abstracts review tools — v3+ adds GitLab/Gitea/Bitbucket adapters
- **Handoff backends**: The `.forge/handoff/*.json` artifacts could be stored in a shared team DB for multi-dev orchestration
- **Model backends**: Same agent definition, swap Opus ↔ Kimi K2.5 ↔ Qwen 3 via config
- **Runtime backends**: Forge workflow runs inside Claude Code, Cursor, Codex, or **OpenClaw** via adapters

The pattern is: v2 ships the interface. v3+ ships the adapters via community contributions.

### Why v2 decisions preserve v3+ optionality

Several v2 design choices seem unnecessary in v2 isolation but are **load-bearing for v3+**:

| v2 decision | v3+ rationale |
|-------------|--------------|
| Canonical YAML + templates for 5 agents | v3+ adds open-source model support by adding new templates, not rewriting agents |
| Separate-context evaluator (plan Phase 4, dev Phase 3) | v3+ auto-research loops require objective scoring the orchestrator can't game |
| Configurable issue backend interface | v3+ adds Linear/Jira/plan-storage adapters via plugins |
| Forge CLI as universal layer | v3+ autonomous loops call forge commands from scripts, not from agents |
| `.forge/handoff/*.json` with schema_version | v3+ cross-session / cross-machine orchestration reads handoff files |
| Multi-dimensional scoring in smart status | v3+ "what to work on" decision for autonomous agents (higher score → agent picks it) |
| Model-agnostic canonical stage definitions | v3+ runs the same workflow on open-source models with no code changes |
| Runtime-agnostic canonical YAMLs (not Claude-specific) | v3+ forge workflow runs inside OpenClaw via a single adapter |
| Structured handoff artifacts | v3+ passes context across agent invocations without conversation memory |

**Rule**: Any v2 design decision that would foreclose v3+ autonomous loops or open-source model support should be flagged and reconsidered. Examples of decisions we've explicitly avoided:
- Hardcoding Opus / GPT-5.4 assumptions in prompts
- Requiring MCP (we added CLI fallback)
- Requiring Claude Code hooks (we enforce via Tier 1-3)
- Single-agent assumptions (we built for parallel dispatch from day 1)

### What's NOT v2 scope

- Autonomous loop runner (`forge autonomous start`)
- Open-source model benchmarking suite
- Cost estimator
- Auto-research iteration loop
- Karpathy-style self-improvement
- External tool adapters beyond beads + GitHub

These are all **v3+** and will be planned separately when v2 ships and we have real usage data to inform the design.

### Why this section exists in the v2 doc

Not to commit to any of it. To make sure v2 architecture decisions don't accidentally make any of it impossible. Every v2 reviewer should ask: "does this v2 decision close off a v3+ path I care about?" If yes, reconsider.

---

## 5. Cross-Cutting Principles

### From Anthropic Engineering Research

1. **"Use what it already knows"** — Build on bash + text editor, not custom tools. Forge CLI should be callable via bash.
2. **"Ask what you can stop doing"** — Quarterly harness audit. Strip scaffolding that newer models handle natively.
3. **"Set boundaries carefully"** — Static first, dynamic last. Don't switch models mid-session. Use tool search over tool loading.
4. **Separate generator from evaluator** — Different prompts, concrete grading criteria, trace logging.
5. **Context resets > compaction** for long-running work — Fresh agent + structured handoff file.
6. **Tests are THE supervision mechanism** — For parallel agent teams, tests keep agents on track without human oversight.
7. **Prompt caching makes parallelism cheap** — N agents with shared prefix cost ~1.4x (not Nx).
8. **Planner is load-bearing** — Without spec, generator under-scopes. Keep /plan. Focus on product context, not granular technical detail.

### Universal Design Rules

1. Every feature must work at Tier 1-3 (files + CLI + git hooks) for all 5 agents
2. Forge CLI is the single enforcement authority — agents are thin adapters
3. File-based state (`.forge/`) is the universal handoff mechanism
4. Agent-native features (hooks, subagents, skills) are progressive enhancements
5. No improvement should be Claude-Code-only. If it can't work for all 5, rethink it.
6. **No forge command shows a raw downstream tool error without context.** Every invocation of git, gh, bd, bun, eslint, tsc, test runners, Dolt, Lefthook, Context7 MCP, or the GitHub API goes through the error translation layer (WS1 Phase 4). Errors must be translated to forge-level language, given context ("while running X for Y"), and paired with actionable recovery steps. Builds and review cycles especially depend on this — a 2-line review fix failing at CI with cryptic output is the exact pain point v2 must solve. Unknown error patterns are bugs to fix, not acceptable outputs.
7. **Forge owns the whole round-trip**, not just the happy path. When a wrapped tool fails, forge must: (a) catch the error, (b) explain what went wrong in forge terms, (c) offer recovery (auto/prompt/guide/fail per severity), (d) log the incident for audit via `forge audit`, and (e) link to docs for deep troubleshooting. A forge command that propagates a raw downstream error is incomplete.

---

## 6. Source Documents

| # | Document | Key Finding |
|---|----------|-------------|
| 1 | forge-abstraction-layer | 42 raw commands need forge wrappers; 5 missing forge commands |
| 2 | commands-to-skills-migration | 1/11 -> skill, 10/11 -> agents. Delete /research. |
| 3 | beads-evolution-strategy | (SUPERSEDED by beads-vs-forge-issues-honest-eval — original Option C/E was rejected) |
| 4 | forge-agent-architecture | Don't create plugin agents for enforcement. Hooks + CLI instead. |
| 5 | context-engineering-improvements | 98.7KB prompts, zero caching. 13% reduction with handoffs + pruning. |
| 6 | parallel-agent-teams | (Workstream DEFERRED to v3 — not in v2 scope) Worktrees work, but no parallel dispatch/protocol. |
| 7 | safety-auto-mode | No secrets, no incident log, no classifier. Unified layer proposed. |
| 8 | evaluator-agent-pattern | No code quality eval. 5-dimension rubric + separate evaluator. |
| 9 | long-running-harness | No initializer, no auto recovery. progress.md + SESSION_HANDOFF.md. |
| 10 | eval-infrastructure | No workflow metrics, no A/B testing, no parity testing. 5-week phased. |
| 11 | agent-extension-matrix | All 6 agents support hooks + subagents (Cursor confirmed 2.4+). _Historical — Copilot later dropped from v2 support on 2026-04-07._ |
| 12 | forge-issues-risk-inventory | 68 risks, 3 blockers (MCP-only, JSONL concurrency, cloud agents). All solved. |
| 13 | ws1-cli-abstraction-risks | 20 risks. Hooks Claude-only, gh CLI no hard gates, 60+ files to migrate. |
| 14 | ws1-forge-pr-risks | 69 failure modes across 7-step PR flow. Idempotency, CI blindness, link-back fragility. |
| 15 | ws1-agent-migration-risks | 2,849 raw refs, Codex/Kilo/OpenCode zero config infra. CI validation needed. |
| 16 | ws1-hook-enforcement-risks | False positives (forge's own calls), advisory-only on 5/6 agents (original 6-agent research). Env var isolation. |
| 17 | ws1-cross-platform-risks | 20 risks. WSL/Windows SQLite locking, gh auth per-shell, native compilation. |
| 18 | ws2-dispatch-model-risks | 46 risks, 7 critical blockers. Filesystem isolation, circular dispatch, IDE-bound agents. |
| 19 | ws-stage-consolidation | dev-agent as 3-phase hybrid orchestrator. Phase 3 (evaluator) MUST be separate context. plan-agent parallel structure. |
| 20 | ws-code-review-research | CodeRabbit (50 linters), Greptile (graph + memory), Qodo (open-source), SonarCloud (rules-based). Common patterns. |
| 21 | ws-pr-review-handling | NormalizedComment interface. ONE unified review skill with pluggable parsers. forge push --review. |
| 22 | ws-beads-issues-v2-impact | 50 open beads classified: 16 SOLVED, 11 INCORPORATE, 14 UNCHANGED, 9 OBSOLETE. |
| 23 | ws-doc-automation | forge docs detect/verify scripts + agent writes. Research/plans separation. INDEX.md generation. |
| 24 | ws-smart-test-selection | Affected-only lint saves ~25 min per review cycle. Trust CI for full tests on review fixes. |
| 25 | v2-evaluator-synthesis | Synthesis of 4 separate-context evaluator agents. Convergent finding: scope discipline failure. Drove the right-sizing to 12-14 weeks. |

---

## 7. Total Effort Estimate

| Phase | Weeks | Workstreams |
|-------|-------|-------------|
| Phase 1: Foundation | 4 | WS4 (schema freeze), WS3 (beads wrapper + cloud adapter), WS1 (pre-work), WS13 (guardrails), WS7 (safety), WS11 (Context7 skills), WS8 (long-running) |
| Phase 2: Core Workflow | 4 | WS5 (evaluator with WS11 context), WS1 (Claude→all 5 agents), WS2 (canonical YAMLs + all agent templates), WS7 (modes), WS9 (metrics) |
| Phase 3: Quality + Reach | 4 | WS10 (universal review system + reply-and-resolve), WS12 (doc automation), WS9 (A/B testing), WS3 (beads upstream PRs), WS1 (enforcement hooks) |
| Phase 4: Hardening | 2 | Cross-platform tests, docs, WS4 (full context decomposition), buffer |
| **Deferred to v3** | — | WS6 (parallel teams), WS9 P3 (cross-agent testing), Linear/Jira adapters, multi-tenant, web UI |

**Total: 13-15 weeks to full v2 with 2 engineers, OR 22-26 weeks for 1 engineer.** Honest staffing assumption — sum of person-weeks across all workstreams is **~24-32**, compressed by parallel work where possible.

**Person-week math** (sum of individual workstream estimates):
- WS1 (CLI + smart status): 5w
- WS2 (commands → agents, all 5 agents): 2-3w
- WS3 (beads wrapper, components 1-4): 5-6w
- WS4 (context engineering, P0-P1): 1w
- WS5 (evaluator pattern): 1-2w
- WS7 (safety + auto mode): 2-3w
- WS8 (long-running harness): 2-3w
- WS9 (eval infrastructure, Phases 1-2 only): 1-2w
- WS10 (universal review system): 2-3w
- WS11 (Context7 tech-stack skills): 1-2w
- WS12 (doc automation): 1w
- WS13 (universal guardrails): 1-2w
- **Sum: 24-32 person-weeks**

With 2 engineers running parallel-safe workstreams: 13-15 calendar weeks.
With 1 engineer: 22-26 calendar weeks (parallel work becomes sequential).
With 1 engineer in 3 sequenced releases: 16-19 calendar weeks total but ships value at 4-5 week intervals.

Down from the original 20-week scope after evaluator synthesis identified scope creep, wrong workstream ordering, and the 5-10x over-scoped WS3 rewrite.

### Staffing reality

The 13-15 week timeline assumes:
- **2 engineers working in parallel** on independent workstreams
- One on WS3 (beads wrapper + GitHub sync), one on WS1+WS2 (CLI + agents)
- Both converging on WS5/WS10/WS11/WS13 in the second half
- WS3 Component 5 (fork beads bug fixes in Go) and Component 2g (webhook receiver) deferred to v3 to fit the timeline

For **1 engineer**, honest re-baseline is **22-26 weeks**. The plan stays the same but the calendar stretches because work that could be parallel becomes sequential. No shortcut around this.

If 1 engineer is the reality, the recommended approach is **3 sequenced releases**:
- **v2.0 (4-5 weeks)**: WS3 (wrapper + GitHub sync) + smart status MVP + Claude Code only — ships the killer demo first
- **v2.1 (5-6 weeks)**: WS1 complete + WS10 (review system) + WS12 (doc automation)
- **v2.2 (6-8 weeks)**: WS2 (all agents) + WS5 (evaluator) + WS11 (Context7) + WS13 (guardrails)

Each release ships value, gets feedback, informs the next. Total calendar: ~16-19 weeks, but with usable releases at 4-5 week intervals.

### The killer demo (60-second story)

Build v2.0 around making this demo work:

> External contributor opens a GitHub issue → 60 seconds later it appears in `forge status` with smart prioritization → forge plan picks it up and the workflow continues automatically

This is the single demo that justifies v2. Every Phase 1 deliverable is judged against: does it make this demo faster, smoother, or more reliable?

### Beads Issues Incorporated

11 existing beads issues directly map to v2 workstreams (full mapping in [ws-beads-issues-v2-impact.md](ws-beads-issues-v2-impact.md)):

| Issue | Maps to | Status |
|-------|---------|:------:|
| forge-s0c3 | WS2 (stage consolidation 7→5) | Primary tracking |
| forge-f3lx | WS3 (beads wrapper + GitHub-backed coordination) | Primary tracking |
| forge-m0fw | WS10 (universal review system) | Incorporated |
| forge-r6u3 | WS2 + WS10 (validate naming overload) | Incorporated |
| forge-hwjq | WS2 (validate contract mismatches) | Incorporated |
| forge-4nvf | WS12 (docs/research separation) | Incorporated |
| forge-dq8j (epic) | WS1 + WS7 (setup hardening) | Incorporated |
| forge-m1n8 family (except m1n8.7 which was Roo/Cline, now closed) | WS2 (agent parity adapters — 5 agents only, Copilot dropped) | Incorporated |
| forge-fjbh | WS11 (extension system, plugin architecture) | Incorporated |

**16 beads issues will be SOLVED by v2** (close when shipping): all Beads/Dolt-related issues, validate contract issues, workflow enforcement issues.

**9 beads issues are OBSOLETE** (close as superseded): Roo/Cline parity (dropped agents), command override layer (commands → agents), beads test issues.

**14 beads issues are UNCHANGED** (remain as independent work): pure bug fixes, CI/CD, npm packaging, test runner migration, coverage gaps.

### Risk-Adjusted Timeline

| Risk | Impact if it materializes | Schedule buffer |
|------|---------------------------|-----------------|
| WSL/Windows SQLite issues worse than expected | +1 week WS3 hardening | Built into Phase 2 Week 8 |
| GitHub API changes during development | +1 week sync adapter | Isolated behind IssueSync interface |
| beads migration data loss | +1 week migration testing | Run parallel (old beads + new forge-issues) for 2 sprints |
| Agent-specific MCP incompatibilities | +1 week per agent | CLI fallback always works — MCP issues don't block agents |
| Cross-platform test failures | +1 week | Dedicated Windows/WSL/macOS CI matrix in Phase 2 |
