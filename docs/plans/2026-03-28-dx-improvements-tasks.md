# Task List: DX Improvements (forge-ujq)

- **Design doc**: docs/plans/2026-03-28-dx-improvements-design.md
- **Branch**: feat/dx-improvements
- **Total tasks**: 14
- **Dependency graph**: Wave 1 → Wave 2 → Wave 3 → Wave 4

---

## Wave 1: Foundation (parallel — no dependencies)

These tasks have zero file overlap and can run simultaneously.

### Task 1: Command Registry (Auto-Discovery)
**Issue**: N/A (foundation for all new commands)
**File(s)**: `lib/commands/_registry.js` (NEW)
**OWNS**: `lib/commands/_registry.js`
**What to implement**: Auto-discovery module that scans `lib/commands/` for `.js` files (excluding `_registry.js` and files starting with `_`), loads each module, validates it exports `{ name, description, handler }`, and builds a routing Map. Export `loadCommands(commandsDir)` returning `{ commands: Map, getHelp(): string }`. Handle malformed modules gracefully (skip with warning, continue loading others).
**TDD steps**:
  1. Write test: `test/command-registry.test.js` — assert `loadCommands()` discovers a mock command module, returns it in the Map. Assert malformed module is skipped with console.warn.
  2. Run test: confirm RED — `_registry.js` doesn't exist
  3. Implement: `lib/commands/_registry.js` — `fs.readdirSync()` + `require()` loop with try/catch
  4. Run test: confirm GREEN
  5. Commit: `test: add command registry tests` then `feat: implement command auto-discovery registry`
**Expected output**: `loadCommands()` returns Map with discovered commands; `getHelp()` returns formatted help string

### Task 2: .gitattributes CRLF Fix
**Issue**: forge-2s1
**File(s)**: `.gitattributes`
**OWNS**: `.gitattributes`
**What to implement**: Add `* text=auto eol=lf` and binary rules for image/font files. Preserve existing beads merge driver line. After editing, run `git add --renormalize .` to re-apply line endings to all existing tracked files (without this, only NEW `git add` operations use the new rules — existing index entries keep old CRLF).
**TDD steps**:
  1. Write test: `test/gitattributes.test.js` — assert `.gitattributes` contains `* text=auto eol=lf`, assert it still contains `merge=beads`, assert binary rule exists for png/jpg/gif
  2. Run test: confirm RED — no `eol=lf` line exists
  3. Implement: Edit `.gitattributes` to add the lines
  4. Run `git add --renormalize .` to apply new line endings to all tracked files
  5. Run test: confirm GREEN
  6. Commit: `fix: enforce LF line endings via .gitattributes`
**Expected output**: `git add` produces zero CRLF warnings for text files; `git diff` after renormalize shows line ending changes only

### Task 3: Fix detect-worktree Hardcoded Branch
**Issue**: forge-63e (partial — this specific pre-existing failure)
**File(s)**: `test/detect-worktree.test.js`
**OWNS**: `test/detect-worktree.test.js`
**What to implement**: Replace hardcoded `feat/smart-setup-ux` branch expectation with dynamic detection. The test should assert `result.branch` matches a valid branch pattern (contains `/` separator like `feat/slug` or `fix/slug`), not a specific branch name. Use `expect(result.branch).toMatch(/^[a-z]+\/[a-z0-9-]+$/)` — this is stronger than `toBeTypeOf('string')` (which would pass on garbage like `""` or `undefined` coerced to string) but doesn't hardcode a specific branch.
**TDD steps**:
  1. Read `test/detect-worktree.test.js` to understand current assertion
  2. Edit test: replace `toBe('feat/smart-setup-ux')` with `toMatch(/^[a-z]+\/[a-z0-9-]+$/)`
  3. Run test: confirm GREEN (was RED before fix)
  4. Commit: `fix: remove hardcoded branch name from detect-worktree test`
**Expected output**: detect-worktree tests pass regardless of which worktree branch is active

### Task 4: Forge Sync Command
**Issue**: forge-6ck
**File(s)**: `lib/commands/sync.js` (NEW)
**OWNS**: `lib/commands/sync.js`
**What to implement**: New command module exporting `{ name: 'sync', description, handler }`. Handler checks if `bd` binary exists (using `execFileSync('bd', ['--version'])`). If yes, runs `bd dolt pull` then `bd dolt push`. If no, prints "Beads not installed — nothing to sync". Returns `{ success, synced, error? }`.
**TDD steps**:
  1. Write test: `test/forge-sync.test.js` — mock `execFileSync` to test: (a) happy path returns `{ success: true, synced: true }`, (b) bd not found returns `{ success: true, synced: false }`, (c) dolt pull fails returns `{ success: false, error }`
  2. Run test: confirm RED
  3. Implement: `lib/commands/sync.js`
  4. Run test: confirm GREEN
  5. Commit: `test: add forge sync command tests` then `feat: implement forge sync command`
**Expected output**: `forge sync` runs bd dolt pull/push or gracefully skips

---

## Wave 2: New Commands (parallel — depends on Wave 1 Task 1 for registry pattern)

### Task 5: Forge Worktree Command
**Issue**: forge-5yz, forge-9pg, forge-g5o, forge-m03
**File(s)**: `lib/commands/worktree.js` (NEW)
**OWNS**: `lib/commands/worktree.js`
**What to implement**: Command with subcommands `create` and `remove`.
- `create <slug>`: (1) `fs.mkdirSync('.worktrees', { recursive: true })` — ensure parent dir exists, (2) `git worktree add .worktrees/<slug> -b feat/<slug>`, (3) OS detection via `process.platform`, (4) Beads setup: Windows → `fs.symlinkSync(target, link, 'junction')` for directory junction (no elevation needed, unlike regular symlinks), Unix → `fs.symlinkSync(target, link)`, Fallback → recursive copy of `.beads/` excluding `daemon.lock`, (5) Verify beads accessibility via `execFileSync('bd', ['--version'], { cwd: worktreePath })`, (6) Run `bun install` in worktree.
- Do NOT use `lib/symlink-utils.js` — it's designed for individual files with content-copy fallback. We need directory-level symlink/junction, which requires different logic.
- `remove <slug>`: `git worktree remove .worktrees/<slug>`.
- Use `path.resolve()` for all paths (no `mktemp -d`).
- Handle edge cases: worktree already exists (offer reuse/remove), `.beads/` doesn't exist (beads not installed — skip beads setup with warning), branch already exists (use existing branch).
**TDD steps**:
  1. Write test: `test/forge-worktree.test.js` — test create flow with mocked git/fs calls. Assert: worktree dir created, beads setup attempted (symlink or copy based on platform), install runs. Test remove flow. Test error handling (worktree already exists, .beads missing).
  2. Run test: confirm RED
  3. Implement: `lib/commands/worktree.js`
  4. Run test: confirm GREEN
  5. Commit: `test: add forge worktree command tests` then `feat: implement forge worktree command`
**Expected output**: `forge worktree create my-feature` creates worktree with beads setup on any OS

### Task 6: Forge Test Command
**Issue**: forge-hq5, forge-63e, forge-9qu
**File(s)**: `lib/commands/test.js` (NEW)
**OWNS**: `lib/commands/test.js`
**What to implement**: Command that wraps test execution with smart defaults.
- Read timeout from `package.json` scripts.test args or default to 15000ms
- Detect package manager (reuse pattern from `scripts/test.js`)
- Before running: check Dolt connectivity via `execFileSync('bd', ['--version'])` with timeout 3000ms. If fails, set `BEADS_SKIP_TESTS=1` in env.
- Run tests via `spawnSync(pkgManager, ['run', 'test'], { env: { ...process.env, BEADS_SKIP_TESTS }, timeout })` — uses `run test` not `test` so package.json flags are inherited.
- `--affected` flag: detect changed files via `git diff --name-only $(git merge-base HEAD main)...HEAD` (all changes on branch vs main, not just uncommitted). Fall back to `git diff --name-only HEAD` if merge-base fails (e.g., initial commit). Map changed files to test files via `identifyFilePairs()` from dev.js (safe to import — pure function, no side effects, no heavy deps), run only those.
- Return `{ success, passed, failed, skipped }`.
**TDD steps**:
  1. Write test: `test/forge-test.test.js` — test: (a) default timeout is 15000ms, (b) BEADS_SKIP_TESTS set when bd unavailable, (c) uses `run test` not `test`, (d) --affected maps changed files to test files
  2. Run test: confirm RED
  3. Implement: `lib/commands/test.js`
  4. Run test: confirm GREEN
  5. Commit: `test: add forge test command tests` then `feat: implement forge test command`
**Expected output**: `forge test` runs tests with correct timeout; `forge test --affected` runs subset

### Task 7: Forge Push Command
**Issue**: forge-due, forge-9ih
**File(s)**: `lib/commands/push.js` (NEW)
**OWNS**: `lib/commands/push.js`
**What to implement**: Command that replaces lefthook pre-push hooks with forge-managed push.
- Always run: branch protection check via `execFileSync('node', ['scripts/branch-protection.js'])` as subprocess (NOT `require()` — branch-protection.js calls `main()` at module level and uses `process.exit()`, so importing would trigger execution and kill the process)
- Always run: lint via `spawnSync(pkgManager, ['run', 'lint'])`
- If `--quick` flag: skip tests, print "Tests skipped (--quick) — CI will run full suite". If first push to this branch (check `git rev-list --count origin/feat/... 2>/dev/null` fails), print additional warning.
- If no flag: run full test suite via the forge test handler or `spawnSync(pkgManager, ['run', 'test'], { timeout: 120000 })`
- On all checks pass: `execFileSync('git', ['push', ...args])` — pass through any extra git push args (e.g., `-u origin feat/slug`)
- Return `{ success, quickMode, lintPassed, testsPassed?, pushed }`.
**TDD steps**:
  1. Write test: `test/forge-push.test.js` — test: (a) --quick skips tests but runs lint, (b) full mode runs lint + tests, (c) push blocked if lint fails, (d) push blocked if tests fail (full mode), (e) git push called with passthrough args
  2. Run test: confirm RED
  3. Implement: `lib/commands/push.js`
  4. Run test: confirm GREEN
  5. Commit: `test: add forge push command tests` then `feat: implement forge push command`
**Expected output**: `forge push --quick` completes in <30s; `forge push` runs full suite

---

## Wave 3: Internal Fixes (parallel — no file overlap)

### Task 8: isBdAvailable Dolt Connectivity Check
**Issue**: forge-9qu
**File(s)**: `test/beads-context.test.js` (or shared test utility)
**OWNS**: `test/beads-context.test.js`, test utility if extracted
**What to implement**: Enhance `isBdAvailable()` to check not just that `bd` binary exists but that Dolt database is reachable. Add `execFileSync('bd', ['list', '--limit=1'], { timeout })` — if this times out or errors, return false. Timeout should be configurable via `BD_TIMEOUT` env var (default 3000ms) to handle slow CI environments. This prevents tests from hanging when Dolt is dead.
**TDD steps**:
  1. Write test: assert `isBdAvailable()` returns false when bd exists but Dolt is unreachable (mock execFileSync to throw ETIMEDOUT on `bd list`). Assert BD_TIMEOUT env var overrides default.
  2. Run test: confirm RED (current isBdAvailable only checks `bd --version`)
  3. Implement: Add Dolt connectivity check to isBdAvailable with configurable timeout
  4. Run test: confirm GREEN
  5. Commit: `fix: isBdAvailable checks Dolt connectivity, not just binary existence`
**Expected output**: Tests skip gracefully instead of hanging when Dolt server is dead

### Task 9: Validate/Ship Freshness Token
**Issue**: forge-7ys
**File(s)**: `lib/freshness-token.js` (NEW)
**OWNS**: `lib/freshness-token.js`
**What to implement**: Module with `writeFreshnessToken(branch)` and `readFreshnessToken(branch)`. Token is a JSON file at `.forge-freshness` containing `{ timestamp, branch, baseCommit: git merge-base HEAD main }`. `isStale(token)` returns true if `git merge-base HEAD main` differs from `token.baseCommit` (meaning main moved). `/validate` calls `writeFreshnessToken()` after success. `/ship` calls `readFreshnessToken()` — if not stale, skip freshness check. Also add `.forge-freshness` to `.gitignore` (ephemeral state, not part of project). Handle edge cases: corrupted/non-JSON token file → return null (treat as stale), `git merge-base` fails (no common ancestor) → skip token entirely.
**TDD steps**:
  1. Write test: `test/freshness-token.test.js` — test write/read roundtrip, test isStale returns false when base unchanged, test isStale returns true when base differs, test missing token returns null
  2. Run test: confirm RED
  3. Implement: `lib/freshness-token.js`
  4. Run test: confirm GREEN
  5. Commit: `test: add freshness token tests` then `feat: implement validate/ship freshness token`
**Expected output**: Token persists between /validate and /ship; /ship skips redundant freshness check

### Task 10: Dev Commit Verification
**Issue**: forge-3zu, forge-oou
**File(s)**: `lib/commands/dev.js`
**OWNS**: `lib/commands/dev.js`
**What to implement**: Add `verifyTaskCompletion(taskTitle, ownedFiles)` function. After subagent returns:
1. `execFileSync('git', ['status', '--porcelain'])` — if output non-empty, auto-stage using ONLY the task's owned files: `execFileSync('git', ['add', ...ownedFiles])` — NEVER use `git add -A` (could add .env, node_modules, secrets, or unrelated files). If `ownedFiles` is empty/undefined, stage only files matching `git diff --name-only` (tracked modified files only, no untracked).
2. `execFileSync('git', ['log', '-1', '--oneline'])` — parse to verify commit exists
3. Return `{ committed: bool, autoCommitted: bool, commitSha, hasChanges }`.
Export this function so /dev command prompt can call it.
**TDD steps**:
  1. Write test: `test/dev-commit-verify.test.js` — test: (a) clean working dir returns `{ committed: false, autoCommitted: false }`, (b) dirty working dir triggers auto-commit with only owned files staged, (c) auto-commit uses correct message format, (d) untracked files outside OWNS list are NOT staged
  2. Run test: confirm RED
  3. Implement: Add `verifyTaskCompletion()` to `lib/commands/dev.js`
  4. Run test: confirm GREEN
  5. Commit: `test: add dev commit verification tests` then `feat: add post-task commit verification to /dev`
**Expected output**: Subagent forgetting to commit → /dev catches and auto-commits

### Task 11: Greptile Batch Resolution Enhancement
**Issue**: forge-cdh
**File(s)**: `.claude/scripts/greptile-resolve.sh`
**OWNS**: `.claude/scripts/greptile-resolve.sh`
**What to implement**: Enhance `resolve-all` subcommand to be smarter:
1. List all unresolved threads (existing logic)
2. For each thread, get the flagged file path and line range
3. Check `git log --oneline --follow -- <file>` for recent commits since PR creation
4. If file was modified in recent commits: auto-generate reply "Fixed in commit <sha>" and resolve
5. If file was NOT modified: skip with message "Thread needs manual review"
6. Report summary: "Auto-resolved N/M threads. K threads need manual review: [list]"
**Implementation note**: Extract the thread-to-commit matching logic into a Node.js helper (`lib/greptile-match.js`) that the shell script calls. Testing bash functions from Node is fragile (shell escaping, path differences, Windows/Unix). The Node helper is easily testable; the shell script becomes a thin wrapper.
**TDD steps**:
  1. Write test: `test/greptile-resolve.test.js` — test the Node helper `matchThreadsToCommits(threads, recentCommits)`. Assert: modified file → returns { resolved: true, sha }, unmodified file → returns { resolved: false, reason: 'no matching commit' }, renamed file → matches via `--follow`
  2. Run test: confirm RED
  3. Implement: Enhance resolve-all in greptile-resolve.sh
  4. Run test: confirm GREEN
  5. Commit: `test: add greptile batch resolution tests` then `feat: smart resolve-all detects fixed threads`
**Expected output**: `greptile-resolve.sh resolve-all 42` auto-resolves threads with matching commits

---

## Wave 4: Integration + Wiring (sequential — depends on Waves 1-3)

### Task 12: Wire Registry into bin/forge.js
**Issue**: N/A (integration)
**File(s)**: `bin/forge.js`
**OWNS**: `bin/forge.js`
**What to implement**: Import `_registry.js` at the top. In the command routing section, before the existing if/else chain, add: `const registry = loadCommands(path.join(__dirname, '..', 'lib', 'commands'))`. Check `if (registry.commands.has(command))` → call `registry.commands.get(command).handler(args, flags, projectRoot)`. Existing setup/recommend/rollback routing stays as-is for now (migration happens in a future PR). Update `showHelp()` to append registry-discovered commands.
**TDD steps**:
  1. Write test: `test/forge-cli-registry.test.js` — test that `forge worktree --help` shows worktree description, `forge sync --help` shows sync description, `forge --help` includes all discovered commands
  2. Run test: confirm RED (registry not wired yet)
  3. Implement: Wire registry into bin/forge.js
  4. Run test: confirm GREEN
  5. Commit: `test: add CLI registry integration tests` then `feat: wire command registry into bin/forge.js`
**Expected output**: `forge worktree create slug` routes to worktree.js handler; `forge --help` shows all commands

### Task 13: Update Lefthook for Forge Push
**Issue**: forge-due, forge-9ih
**File(s)**: `lefthook.yml`
**OWNS**: `lefthook.yml`
**What to implement**: Since `forge push` now handles branch-protection + lint + tests internally, the lefthook pre-push hooks become redundant when using `forge push`. Approach: Keep lefthook hooks as safety net for raw `git push`. Use a **one-time nonce token** (not an env var) to coordinate:
- `forge push` writes a random UUID to `.forge-push-token` after all checks pass
- Lefthook pre-push hooks read `.forge-push-token`, validate it was written within last 30 seconds (prevents stale tokens), then delete it and skip hooks
- If token missing or stale → lefthook runs hooks normally (raw `git push` path)
- Token is auto-deleted after use — cannot be replayed or pre-set to bypass hooks
- **SECURITY**: A simple `FORGE_PUSH=1` env var would be equivalent to `LEFTHOOK=0` — anyone could set it to bypass hooks. The nonce approach requires forge push to have actually run.
**TDD steps**:
  1. Write test: `test/lefthook-forge-push.test.js` — test: (a) forge push writes token before git push, (b) token contains UUID + timestamp, (c) token older than 30s is rejected, (d) token is deleted after use, (e) raw `git push` without token → hooks run normally
  2. Run test: confirm RED
  3. Implement: Token write in push.js, token check script (e.g., `scripts/check-forge-token.js`), update lefthook.yml to call token check
  4. Run test: confirm GREEN
  5. Commit: `test: add forge push nonce token tests` then `feat: secure lefthook skip via one-time nonce token`
**Expected output**: `forge push` → runs checks → writes nonce → git push → lefthook reads+deletes nonce → skips. Raw `git push` → no nonce → lefthook runs full hooks.

### Task 14: File Ownership in /plan Task List Format
**Issue**: forge-nor
**File(s)**: `.claude/commands/plan.md`
**OWNS**: `.claude/commands/plan.md`
**What to implement**: In the Phase 3 Step 5 task list format section, add explicit file ownership rules:
- Each task MUST include an `OWNS:` line listing files it will modify
- No two tasks in the same wave can own the same file
- The /dev command should verify ownership before dispatching parallel agents
- Add example showing wave structure with OWNS lines
**TDD steps**:
  1. Write test: `test/plan-file-ownership.test.js` — parse a sample task list markdown, extract OWNS per task per wave, assert no duplicates within same wave
  2. Run test: confirm RED
  3. Implement: Add ownership validation function + update plan.md format
  4. Run test: confirm GREEN
  5. Commit: `test: add task file ownership validation` then `feat: add OWNS file ownership to /plan task format`
**Expected output**: Task lists include OWNS lines; validation catches duplicate ownership in same wave

---

## Dependency Graph

```
Wave 1 (parallel, no deps):
  Task 1: Registry         ──┐
  Task 2: .gitattributes     │  (independent)
  Task 3: detect-worktree    │  (independent)
  Task 4: forge sync         │  (independent)
                              │
Wave 2 (parallel, needs Task 1):
  Task 5: forge worktree   ──┤  (needs registry pattern)
  Task 6: forge test        ──┤  (needs registry pattern)
  Task 7: forge push        ──┘  (needs registry pattern)
                              │
Wave 3 (parallel, no file overlap with Wave 2):
  Task 8: isBdAvailable    ──┐  (independent)
  Task 9: freshness token    │  (independent)
  Task 10: dev commit verify │  (independent)
  Task 11: greptile resolve  │  (independent)
                              │
Wave 4 (sequential, needs Waves 1-3):
  Task 12: Wire registry   ──┤  (needs Tasks 1, 4-7)
  Task 13: Lefthook update ──┤  (needs Task 7)
  Task 14: Plan ownership  ──┘  (needs nothing, but last for polish)
```

## Issues → Tasks Mapping

| Issue | Task(s) | Priority |
|-------|---------|----------|
| forge-6ck (bd sync missing) | Task 4 | P1 |
| forge-5yz (bare repo) | Task 5 | P2 |
| forge-9pg (Dolt cross-worktree) | Task 5 | P2 |
| forge-g5o (Windows symlinks) | Task 5 | P2 |
| forge-m03 (mktemp paths) | Task 5 | P2 |
| forge-hq5 (test timeout) | Task 6 | P2 |
| forge-63e (pre-existing failures) | Tasks 3, 6 | P2 |
| forge-9qu (Dolt hang) | Tasks 6, 8 | P2 |
| forge-due (full suite every push) | Tasks 7, 13 | P2 |
| forge-9ih (trivial fix CI) | Tasks 7, 13 | P3 |
| forge-7ys (validate/ship freshness) | Task 9 | P2 |
| forge-3zu (agents don't commit) | Task 10 | P2 |
| forge-oou (ambiguous status) | Task 10 | P2 |
| forge-cdh (greptile batch) | Task 11 | P3 |
| forge-nor (parallel file conflicts) | Task 14 | P2 |
| forge-2s1 (CRLF warnings) | Task 2 | P3 |
| forge-ujq.1 (Dolt cleanup locks) | Tasks 15, 5 (remove) | P2 |

---

## Wave 5: Dolt Cleanup (added mid-dev — depends on Task 5)

### Task 15: Forge Clean Command + Worktree Remove Dolt Stop
**Issue**: forge-ujq.1
**File(s)**: `lib/commands/worktree.js` (update remove), `lib/commands/clean.js` (NEW)
**OWNS**: `lib/commands/clean.js`, `lib/commands/worktree.js` (remove subcommand only)
**What to implement**:

**Part A — Enhance `forge worktree remove` (in worktree.js)**:
Before `git worktree remove`, stop the Dolt server:
1. Try `execFileSync('bd', ['dolt', 'stop'], { cwd: worktreePath, timeout: 5000 })`
2. If bd not available or fails, try reading PID from `.beads/dolt-server.lock` or `.beads/dolt/.dolt/noms/LOCK` and kill that specific process (NOT all Dolt processes)
3. Windows: `execFileSync('taskkill', ['/F', '/PID', pid])`, Unix: `process.kill(pid, 'SIGTERM')`
4. Wait briefly (500ms) for file locks to release
5. Then proceed with `git worktree remove`

**Part B — New `forge clean` command**:
Scans `.worktrees/` for worktrees whose branches have been merged:
1. List dirs in `.worktrees/`
2. For each, check if branch is merged: `git branch --merged main` includes the branch
3. For merged ones: stop Dolt (same logic as Part A), then remove worktree
4. Report: "Cleaned N worktrees. K active worktrees remaining."

**TDD steps**:
1. Write test: `test/forge-clean.test.js` — test clean command module shape, Dolt stop before remove, PID fallback kill, merged branch detection, skip active branches
2. Update `test/forge-worktree.test.js` — add test for remove stopping Dolt first
3. Run tests: confirm RED
4. Implement
5. Run tests: confirm GREEN
6. Commit: `test: add forge clean + dolt stop tests` then `feat: forge clean + dolt stop on worktree remove`

---

## Quality Review Fixes Applied

Issues caught during pre-dev quality review and incorporated into task descriptions above:

| # | Issue | Severity | Task | Fix |
|---|-------|----------|------|-----|
| 1 | `git add -A` in commit verification could add secrets/junk | Critical | 10 | Use OWNS file list for targeted `git add` |
| 2 | `FORGE_PUSH=1` env var is equivalent to `LEFTHOOK=0` bypass | Critical | 13 | Replace with one-time nonce token |
| 3 | `branch-protection.js` calls `main()` on `require()` | Important | 7 | Call as subprocess, not import |
| 4 | `.gitattributes` needs `git add --renormalize` | Important | 2 | Added renormalize step |
| 5 | `.forge-freshness` not in `.gitignore` | Important | 9 | Add to .gitignore |
| 6 | `toBeTypeOf('string')` assertion too weak | Important | 3 | Use regex pattern match |
| 7 | `--affected` uses wrong git diff base | Important | 6 | Use merge-base, not HEAD |
| 8 | `.worktrees/` dir may not exist on first use | Important | 5 | Add `mkdirSync` with recursive |
| 9 | `symlink-utils.js` is for files, not directories | Important | 5 | Use `fs.symlinkSync` with 'junction' type directly |
| 10 | `isBdAvailable` timeout not configurable for slow CI | Minor | 8 | Add BD_TIMEOUT env var |
| 11 | Greptile shell tests fragile cross-platform | Minor | 11 | Extract matching logic to Node helper |
| 12 | Worktree edge cases missing (exists, no .beads, branch exists) | Minor | 5 | Added to edge case list |
