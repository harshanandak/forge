# Design: Developer Experience Improvements

- **Feature**: dx-improvements
- **Date**: 2026-03-28
- **Status**: draft
- **Epic**: forge-ujq (16 child issues)
- **Branch**: feat/dx-improvements

---

## Purpose

AI agents working with Forge waste significant time fighting tool integration issues instead of doing productive work. During PR #98 and PR #105, agents spent ~40% of push cycles on pre-push hook waits, worktree setup failures, and manual workarounds for beads/git/OS quirks.

Forge is a harness for AI agents. Agents should only know Forge's command surface — never the underlying tools. Every time an agent drops down to raw `bd`, `git worktree`, `mktemp`, or `ln -s`, that's a leaky abstraction Forge should be hiding.

---

## Success Criteria

1. **New forge subcommands**: `forge worktree create`, `forge sync`, `forge test`, `forge push` — agents never call underlying tools directly
2. **Command auto-discovery**: Adding a new command = adding one file to `lib/commands/`. No edits to `bin/forge.js` ever again
3. **Pre-push fast path**: `forge push --quick` completes in <30 seconds (lint-only, no tests)
4. **Zero CRLF warnings**: `.gitattributes` enforces LF on all text files
5. **Subagent verification**: `/dev` verifies commits after each task — no silent failures
6. **Test reliability**: Beads-dependent tests skip gracefully when Dolt is unavailable (no hangs)
7. **All 16 child issues closed**: Every issue in forge-ujq resolved

---

## Out of Scope

- **Beads upstream fixes**: forge-5yz (bare repo) and forge-9pg (Dolt cross-worktree) are beads bugs. We add forge-level workarounds, not beads patches.
- **CLI framework migration**: No yargs/commander adoption. The auto-discovery registry is a lightweight pattern (~50 lines), not a framework.
- **New workflow stages**: No changes to the 7-stage workflow sequence. Only internal improvements to existing stages.
- **CI/CD changes**: No changes to GitHub Actions workflows. Pre-push hooks are local-only.

---

## Approach Selected: A+ (CLI Extension with Auto-Discovery Registry)

### Core Architecture Change

**Before (current):** `bin/forge.js` is 3000+ lines with manual if/else routing, hardcoded help text, regex flag parsing. Adding a command means editing 3 places in one massive file.

**After:** `bin/forge.js` becomes a thin bootstrap (~100 lines) that loads `lib/commands/_registry.js`. The registry auto-discovers command modules from `lib/commands/`. Each command is a self-contained module with standard metadata.

```
bin/forge.js              ← thin bootstrap: load registry, dispatch command
lib/commands/
  _registry.js            ← auto-loader: scan *.js, build routing table + help
  worktree.js             ← NEW: forge worktree create/remove
  test.js                 ← NEW: forge test [--affected]
  push.js                 ← NEW: forge push [--quick]
  sync.js                 ← NEW: forge sync
  dev.js                  ← EXISTING: add metadata exports + commit verification
  validate.js             ← EXISTING: add metadata exports
  ship.js                 ← EXISTING: add metadata exports
  plan.js                 ← EXISTING: add metadata exports
  status.js               ← EXISTING: add metadata exports
  recommend.js            ← EXISTING: add metadata exports
```

### Command Module Interface

Every command exports a standard shape:

```js
module.exports = {
  name: 'worktree',
  description: 'Manage isolated worktrees with Beads integration',
  usage: 'forge worktree <create|remove> <slug>',
  flags: {
    '--branch': 'Custom branch name (default: feat/<slug>)'
  },
  handler: async (args, flags, projectRoot) => {
    // implementation
    return { success: true }
  }
}
```

### New Command: `forge worktree create <slug>`

Solves: forge-5yz (bare repo), forge-9pg (Dolt), forge-g5o (symlinks), forge-m03 (mktemp)

Flow:
1. Detect OS (win32 vs unix)
2. Create worktree: `git worktree add .worktrees/<slug> -b feat/<slug>`
3. Setup Beads:
   - Unix: `ln -s <main>/.beads .worktrees/<slug>/.beads`
   - Windows: `mklink /J .worktrees\<slug>\.beads <main>\.beads` (junction point, no elevation needed)
   - Fallback: copy .beads/ excluding daemon.lock
4. Verify Dolt connectivity from new worktree
5. Install dependencies (`bun install` / `npm install`)

### New Command: `forge sync`

Solves: forge-6ck (bd sync doesn't exist)

Flow:
1. Check if Beads is available
2. Run `bd dolt pull` (fetch latest)
3. Run `bd dolt push` (push local changes)
4. Report sync status

### New Command: `forge test [--affected]`

Solves: forge-hq5 (timeout), forge-63e (pre-existing failures), forge-9qu (Dolt hang)

Flow:
1. Read timeout from package.json or default to 15000ms
2. If `--affected`: detect changed files, map to test files, run only those
3. Before running: check Dolt connectivity (if beads tests exist)
   - If Dolt unavailable: set `BEADS_SKIP_TESTS=1` env var so tests skip gracefully
4. Run tests via `bun run test` (not `bun test` — inherits package.json config)
5. Report results with clear pass/fail/skip counts

### New Command: `forge push [--quick]`

Solves: forge-due (full suite every push), forge-9ih (trivial fix CI cost)

Flow:
1. Run branch protection check (always)
2. Run lint (always — fast, ~15 seconds)
3. If `--quick`: skip tests, print "Tests skipped — CI will run full suite"
4. If no flag: run full test suite via `forge test`
5. Execute `git push`

Note: This replaces lefthook pre-push hooks. Forge becomes the push orchestrator.

### Internal Fix: /dev Commit Verification

Solves: forge-3zu (agents don't commit), forge-oou (ambiguous status)

After each subagent task returns:
1. `git status` — uncommitted changes?
   - YES → auto-commit with `feat(task-N): <task-title>`
   - NO → check git log
2. `git log -1` — commit related to this task?
   - YES → task verified
   - NO → flag "Agent returned complete but made no changes"
3. `bun test` — tests still passing?
   - YES → next task
   - NO → flag "Agent broke tests"

### Internal Fix: /plan File Ownership

Solves: forge-nor (parallel agent file conflicts)

Task list format adds explicit file ownership per wave:

```
## Wave 1 (parallel)
Task 1: [title] — OWNS: lib/commands/worktree.js
Task 2: [title] — OWNS: lib/commands/sync.js
Task 3: [title] — OWNS: lib/commands/test.js

## Wave 2 (parallel, after Wave 1)
Task 4: [title] — OWNS: lib/commands/push.js
```

No two tasks in the same wave own the same file.

### Internal Fix: Validate/Ship Freshness Token

Solves: forge-7ys (redundant rebase cycles)

After `/validate` completes successfully, write a freshness token:
```
.forge-freshness → { timestamp, branch, baseCommit }
```

`/ship` reads this token. If base commit hasn't changed, skip freshness check. If it has (new merge on main), require re-validation.

### Internal Fix: Greptile Batch Resolution

Solves: forge-cdh (manual thread resolution)

Enhance `greptile-resolve.sh resolve-all` to:
1. List all unresolved threads
2. For each, check if the flagged file/line was modified in recent commits
3. Auto-generate reply: "Fixed in commit <sha>"
4. Resolve only threads with matching commits
5. Report: "Resolved N/M threads. K threads need manual review."

### Config Fix: .gitattributes

Solves: forge-2s1 (CRLF warnings)

```
* text=auto eol=lf
*.{png,jpg,gif,ico,woff,woff2,ttf,eot} binary
```

Force LF on all text files. Every modern Windows editor handles LF.

---

## Constraints

- **No CLI framework**: The registry is a lightweight pattern, not a dependency
- **Backward compatible**: Existing `forge setup`, `forge recommend` continue to work
- **No hook bypass**: `forge push` replaces lefthook pre-push, but never uses `--no-verify` or `LEFTHOOK=0`
- **Windows + Unix**: All new commands must work on both platforms
- **No beads patches**: Workarounds only — beads is an external dependency

---

## Edge Cases

1. **Worktree already exists**: `forge worktree create` detects existing worktree and offers to reuse or remove
2. **Dolt server dead**: `forge test` sets skip env var; `forge worktree create` falls back to copy
3. **No beads installed**: All forge commands degrade gracefully — beads is optional
4. **Push with uncommitted changes**: `forge push` refuses (like git) — must commit first
5. **`--quick` on first push**: Allowed — CI is the safety net. But prints warning: "First push to this branch — consider `forge push` (full suite)"
6. **Registry fails to load a command**: Skip the broken module, log warning, load remaining commands

---

## Ambiguity Policy

Use 7-dimension rubric scoring per /dev decision gate:
- >= 80% confidence: proceed and document
- < 80% confidence: stop and ask user

---

## OWASP Top 10 Analysis

| Category | Applies? | Mitigation |
|----------|----------|------------|
| A01: Broken Access Control | No | CLI tool, no auth surface |
| A02: Cryptographic Failures | No | No secrets handling |
| A03: Injection | **Yes** | All commands use `execFileSync` (not `exec`). No shell interpolation. Args passed as arrays. |
| A04: Insecure Design | No | Local-only tool |
| A05: Security Misconfiguration | **Yes** | `forge push --quick` skips tests — mitigated by CI running full suite. Warning printed. |
| A06: Vulnerable Components | No | No new dependencies added |
| A07: Auth Failures | No | No auth surface |
| A08: Data Integrity | **Yes** | Auto-commit in /dev verification could commit broken code — mitigated by test check before commit |
| A09: Logging Failures | **Yes** | All forge commands should log actions for audit. Beads audit trail covers issue operations. |
| A10: SSRF | No | No network requests in new commands |

---

## Technical Research

### DRY Check Results — EXTEND, Don't Create

| Pattern | Existing File | Action |
|---------|---------------|--------|
| Command auto-discovery | `lib/plugin-manager.js` | EXTEND — has agent auto-discovery via `fs.readdirSync()`, adapt for commands |
| Worktree creation | `scripts/lib/eval-runner.js` | REUSE — already does `git worktree add -b` cross-platform |
| Symlink/copy fallback | `lib/symlink-utils.js` | REUSE — `createSymlinkOrCopy()` handles Windows gracefully |
| Test skip guards | `scripts/beads-context.test.js` | REUSE — `isBdAvailable()` pattern, extend with Dolt connectivity |
| Push / branch protection | `scripts/branch-protection.js` | EXTEND — add `--quick` flag path |
| Test runner | `scripts/test.js` | EXTEND — add timeout + BEADS_SKIP env var |
| Sync foundation | `scripts/sync-utils.sh` | BUILD ON — identity validation + config reading is solid |
| Freshness token | `lib/file-hash.js` | EXTEND — file hash module exists in dx-improvements branch |

### bin/forge.js Current Structure (4,613 lines)

- **Command routing** (lines 4121-4191): 3 commands — setup, recommend, rollback
- **parseFlags()** (lines 2505-2599): 20 flags, 4 helper parsers, ~95 lines
- **showHelp()** (lines 2714-2770): hardcoded text, ~57 lines
- **Setup command**: complex inline logic with 4 sub-flows (dry-run, quick, agent-specified, interactive)
- **Recommend**: already delegates to `lib/commands/recommend` — the target pattern
- **Rollback**: delegates to `showRollbackMenu()`
- **Shared utilities**: `secureExecFileSync()`, validation functions, `SetupActionLog` class

**Migration strategy**: Recommend command is already modular. Setup + rollback have complex inline logic — migrate last. New commands (worktree, test, push, sync) start with the registry pattern from day one.

### Existing Infrastructure

- **scripts/test.js**: No timeout set, runs `<pkgManager> test` with no args, `shell: isWindows`
- **lefthook.yml pre-push**: branch-protection → lint → tests (3 sequential hooks)
- **.gitattributes**: Only beads merge driver, zero CRLF configuration
- **lib/commands/dev.js**: Exports utility functions (detectTDDPhase, runTests, etc.), no task loop — orchestration is in the /dev command prompt

### TDD Test Scenarios

1. **Registry auto-discovery**: Drop `lib/commands/hello.js` → appears in `forge --help` output
2. **Registry bad module**: Malformed export in `lib/commands/broken.js` → skipped with warning, other commands load
3. **Worktree happy path**: `forge worktree create my-feature` → worktree exists + .beads accessible
4. **Worktree Dolt dead**: Dolt server unavailable → falls back to .beads copy, prints warning
5. **Worktree Windows**: On win32 → uses junction point (mklink /J), not ln -s
6. **Push quick**: `forge push --quick` → lint runs, tests skipped, push succeeds
7. **Push full**: `forge push` → lint + full tests + push
8. **Test with BEADS_SKIP**: Dolt unavailable + BEADS_SKIP=1 → beads tests skip, others run
9. **Test timeout**: Long-running test → respects package.json timeout (15000ms)
10. **Sync happy**: `forge sync` → bd dolt pull + push succeeds
11. **Sync no beads**: Beads not installed → graceful "beads not available" message
12. **Commit verification**: Subagent returns without committing → auto-commit fires
13. **CRLF fix**: After .gitattributes update → zero CRLF warnings on `git add`
