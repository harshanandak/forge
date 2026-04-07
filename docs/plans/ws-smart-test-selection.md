# Smart Test Selection & Efficient Push Strategies

**Date**: 2026-04-06
**Status**: Research
**Goal**: Reduce 2-line review fix cycle from 6-8 min to <1 min locally

---

## 1. The Problem

Current flow for a review fix (e.g., rename a variable, fix a typo):

```
Agent fixes 2 lines
→ forge push (or git push with lefthook)
→ lefthook pre-push:
    1. branch-protection.js         (~1s)
    2. lint.js (full ESLint)        (30-60s)
    3. test.js (full test suite)    (2-4 min)
→ push to remote
→ GitHub Actions CI:
    - full test suite again         (2-4 min)
Total: 6-8 min for 2 lines
```

`forge push --quick` already skips tests (lint-only), but lefthook still runs the full lint. There is no `--review-fix` mode that lints only affected files and runs only affected tests.

---

## 2. Forge's Current State

### forge push (`lib/commands/push.js`)
- `--quick` flag: skips tests entirely, runs full lint, then pushes
- No `--review-fix` or `--affected` flag
- Writes a forge token to skip lefthook hooks (avoids double-gating)

### forge test (`lib/commands/test.js`)
- `--affected` flag exists and works via `getAffectedTestFiles()`
- Uses `git merge-base HEAD <base-branch>` to find changed files
- **Convention-based mapping only**: `lib/foo.js` → `test/foo.test.js`
- Falls back to full suite if no affected tests found
- No import graph analysis, no coverage-based mapping

### lefthook.yml pre-push hooks
- `branch-protection.js` — fast, no issue
- `lint.js` — runs full ESLint (no file filtering)
- `test.js` — runs full test suite (no affected filtering)
- All three skip when forge token is present (forge push bypasses lefthook)

### Key insight
`forge push --quick` already solves the "skip tests" case. The gap is:
1. No affected-only lint (`eslint` supports file args)
2. No affected-only test mode in `forge push`
3. Convention-based test mapping misses indirect dependencies

---

## 3. Smart Test Selection Tools — Research

### 3.1 Nx Affected (`nx affected:test`)

**How it works**: Builds a project dependency graph from `tsconfig.json` paths, ES imports, and `project.json` configs. When files change, it walks the graph to find all affected projects and only runs their tests.

**Pros**: True dependency-aware selection; monorepo-native; caches previous results (Nx Cloud).
**Cons**: Requires Nx workspace setup; heavy for single-package repos; graph build adds overhead on first run (~2-5s).

**Relevance to Forge**: Forge is a single package. Nx's project-level granularity is too coarse — Forge needs file-level granularity.

### 3.2 Jest `--changedSince`

**How it works**: Uses `git diff` to find changed files, then uses Jest's module resolution to find test files that import (directly or transitively) the changed modules. Uses Jest's internal dependency graph built from `require()`/`import` statements.

**Pros**: Import-graph-aware (not just convention); built-in to Jest; no extra setup.
**Cons**: Jest-only; graph resolution adds ~1-3s startup; doesn't help with Bun test.

**Relevance to Forge**: Forge uses Bun test, not Jest. But the algorithm (import graph walking) is the right approach.

### 3.3 Bun Test `--filter`

**How it works**: `bun test --filter "pattern"` runs only test files matching a string/regex pattern against test names or file paths. It is a name filter, not a dependency-aware selector.

**Pros**: Fast (Bun's startup is ~10ms); simple; already available.
**Cons**: No dependency graph — you must know which tests to filter; pattern-based only.

**Relevance to Forge**: Forge already uses this approach — `getAffectedTestFiles()` computes file paths and passes them to `bun run test <files>`. The gap is the mapping logic, not the runner.

### 3.4 Vitest `--changed`

**How it works**: `vitest --changed HEAD~1` uses git diff + Vite's module graph (built from ES imports via Vite's dev server) to find affected test files. Vite already tracks the full import tree for HMR, so the graph is free.

**Pros**: True import-graph analysis; fast (reuses Vite's graph); `--changed` flag is built-in.
**Cons**: Vitest/Vite-only; requires Vite's module graph (not available for non-Vite projects).

**Relevance to Forge**: Forge doesn't use Vite. But Vitest's approach — reusing an existing module graph — is the ideal. Forge could build a lightweight import graph with a static analysis pass.

### 3.5 Trunk.io Test Selection

**How it works**: Cloud service that records test-to-file coverage mappings from CI runs. On PR, it queries the coverage database to select only tests that cover changed lines. Uses runtime coverage data (Istanbul/c8), not static analysis.

**Pros**: Highly accurate (runtime data); catches indirect dependencies; learns over time.
**Cons**: SaaS dependency; requires coverage collection in CI; cold-start problem (needs history); paid service.

**Relevance to Forge**: Overkill for Forge's current scale. The coverage-mapping concept is sound for large projects.

### 3.6 Launchable ML-Based Test Selection

**How it works**: ML model trained on historical test results + code changes. Predicts which tests are likely to fail for a given diff and prioritizes those. Can run "top N% most likely to fail" tests first.

**Pros**: Catches non-obvious correlations; gets smarter over time; reduces test time by 50-80% in practice.
**Cons**: Requires months of CI history for training; SaaS dependency; ML prediction can miss regressions; paid service.

**Relevance to Forge**: Too heavy for current scale. Interesting for large enterprise projects with 10k+ tests.

### 3.7 Microsoft Test Impact Analysis (TIA)

**How it works**: Instruments test runs to record which methods/lines each test covers. On code change, maps changed lines → covered tests. Built into Azure DevOps and Visual Studio.

**Pros**: Line-level precision; catches indirect dependencies; well-integrated with Azure ecosystem.
**Cons**: .NET/Visual Studio ecosystem; instrumentation overhead; not available for JS/TS.

**Relevance to Forge**: Not directly applicable (wrong ecosystem). The line-level coverage mapping concept is the same as Trunk.io's approach.

### Summary Matrix

| Tool | Approach | Accuracy | Setup Cost | Forge Fit |
|------|----------|----------|------------|-----------|
| Nx affected | Project dependency graph | High (project-level) | High | Low (single package) |
| Jest --changedSince | Import graph | High (file-level) | Low (Jest users) | Medium (wrong runner) |
| Bun --filter | Name/path pattern | Low (no graph) | Zero | Already used |
| Vitest --changed | Vite module graph | High (file-level) | Low (Vite users) | Medium (wrong bundler) |
| Trunk.io | Runtime coverage DB | Very high | Medium (SaaS) | Low (overkill) |
| Launchable | ML on CI history | High (probabilistic) | High (SaaS + history) | Low (overkill) |
| MS TIA | Line-level coverage | Very high | High (.NET only) | None |

---

## 4. File-to-Test Mapping Strategies

### 4.1 Convention-Based (Current Forge Approach)

```
lib/commands/push.js  →  test/commands/push.test.js
lib/utils/foo.js      →  test/utils/foo.test.js
```

**Forge's implementation** (`getAffectedTestFiles()` in `lib/commands/test.js`):
- Only maps `lib/*.js` → `test/*.test.js`
- Misses: changes to `bin/`, `scripts/`, shared utilities imported by many files
- Does NOT check if the mapped test file actually exists

**Gaps**:
- If `lib/utils/detect-pkg-manager.js` changes, only `test/utils/detect-pkg-manager.test.js` runs — but `test/commands/push.test.js` and `test/commands/test.test.js` also import it transitively
- Changes to non-`lib/` files (e.g., `scripts/lint.js`) map to nothing

### 4.2 Static Import Graph Analysis

Build a dependency graph by parsing `require()` / `import` statements:

```
lib/commands/push.js
  └── imports lib/utils/detect-pkg-manager.js
  └── imports lib/utils/forge-token.js

test/commands/push.test.js
  └── imports lib/commands/push.js
      └── imports lib/utils/detect-pkg-manager.js
```

If `detect-pkg-manager.js` changes → walk reverse graph → find `push.js` → find `push.test.js` → run it.

**Implementation options**:
1. **Node.js `require.resolve` + AST parsing** — Use `acorn` or `@babel/parser` to extract imports. ~200 lines of code.
2. **Madge** (`npm install madge`) — Existing tool that builds dependency graphs from JS/TS files. `madge --depends-on lib/utils/foo.js` returns all files that import it.
3. **dependency-cruiser** — More powerful graph analyzer with rule engine. Can output JSON dependency graphs.
4. **Custom lightweight parser** — Regex-based `require('...')` extraction. Fast but misses dynamic imports.

**Recommended for Forge**: Option 4 (custom regex) for speed, with option 2 (madge) as a validation tool. Forge's codebase is CommonJS with simple `require()` calls — regex is sufficient.

### 4.3 Runtime Coverage Mapping

Run tests once with coverage instrumentation (`c8` or `istanbul`), save a mapping file:

```json
{
  "test/commands/push.test.js": [
    "lib/commands/push.js",
    "lib/utils/detect-pkg-manager.js",
    "lib/utils/forge-token.js"
  ]
}
```

On subsequent runs, look up changed files in the map to find which tests to run.

**Pros**: Most accurate — catches dynamic `require()`, conditional imports, monkey-patching.
**Cons**: Requires a "full run" to build the map; map becomes stale when imports change; coverage instrumentation slows test run by 10-30%.

**Recommended for Forge**: Generate coverage map in CI (where time is less critical), cache in `.forge/test-coverage-map.json`, use locally for selection. Rebuild on lockfile or major structural changes.

### 4.4 Hybrid Approach (Recommended)

```
1. Convention mapping (instant, always available)     — baseline
2. Static import graph (fast, no prior run needed)    — upgrade
3. Coverage map from CI (most accurate, cached)       — gold standard
```

Fall through: try coverage map → try import graph → fall back to convention.

---

## 5. Push Efficiency — Proposed Modes

### Current

| Command | Lint | Tests | Use Case |
|---------|------|-------|----------|
| `forge push` | Full | Full | First push, major changes |
| `forge push --quick` | Full | Skip | Review-cycle pushes |
| `git push` (lefthook) | Full | Full | Manual push (lefthook gates) |

### Proposed

| Command | Lint | Tests | Use Case |
|---------|------|-------|----------|
| `forge push` | Full | Full | First push of PR, major changes |
| `forge push --quick` | **Affected only** | Skip | Review fixes (rename, typo, style) |
| `forge push --affected` | **Affected only** | **Affected only** | Medium confidence changes |
| `forge push --full` | Full | Full | Explicit full gate (same as current default) |

### Time estimates (Forge codebase, ~50 test files)

| Mode | Lint | Tests | Push | Total |
|------|------|-------|------|-------|
| `--full` | 30-60s | 120-240s | 3-5s | **2.5-5 min** |
| `--quick` (current) | 30-60s | 0 | 3-5s | **35-65s** |
| `--quick` (proposed) | 3-5s | 0 | 3-5s | **6-10s** |
| `--affected` | 3-5s | 5-30s | 3-5s | **11-40s** |

### Implementation sketch for `--quick` affected-only lint

```javascript
// In forge push handler, when quickMode:
const changedFiles = execFileSync('git', ['diff', '--name-only', 'HEAD~1'])
  .toString().trim().split('\n').filter(f => f.match(/\.(js|ts|jsx|tsx)$/));

if (changedFiles.length > 0 && changedFiles.length <= 20) {
  // Lint only changed files
  spawnSync(pkgManager, ['run', 'eslint', ...changedFiles]);
} else {
  // Too many files or no JS files — full lint
  spawnSync(pkgManager, ['run', 'lint']);
}
```

---

## 6. When to Trust CI vs Test Locally

### Industry Standard

Most mature teams follow a **tiered trust model**:

| Change Type | Local Gates | CI Gates | Rationale |
|-------------|------------|----------|-----------|
| New feature (first push) | Full lint + full tests | Full suite + integration | Catch issues early, save CI time |
| Review fix (typo, rename) | Lint affected files only | Full suite | Low risk, CI is safety net |
| Refactor (many files) | Full lint + affected tests | Full suite | Medium risk, need some local confidence |
| Config/CI changes | None needed locally | Full suite | Can't test locally anyway |

### Recommendation for Forge

1. **`forge push --quick` should be the DEFAULT for review fixes** when the agent is in `/review` stage
   - The agent already knows it's fixing review comments (context is clear)
   - CI runs full suite as safety net
   - Risk: broken push → CI fails → extra 3-4 min roundtrip
   - Mitigation: affected-only lint catches 90% of syntax errors

2. **`forge push` (full) should remain default for `/ship` (first PR push)**
   - First push should be clean — full local validation
   - Catches issues before reviewers see them

3. **Never skip lint entirely** — lint catches syntax errors that would definitely fail CI

### Risk Analysis: Pushing Without Full Local Tests

| Scenario | Probability | Cost if CI Catches | Cost if Missed |
|----------|------------|-------------------|----------------|
| Review fix breaks unrelated test | ~5% | +4 min (CI fail + fix + re-push) | N/A (CI catches) |
| Review fix breaks related test | ~2% | +4 min | N/A (CI catches) |
| Net time saved per push | 95% | -3 min saved | — |

**Expected value**: 0.95 × 3 min saved - 0.07 × 4 min penalty = **2.57 min saved per push**.
Over 10 review fixes: **25 min saved**.

---

## 7. Batch Review Fixes

### Current Flow (Per Fix)

```
Fix comment 1 → commit → push → wait for CI (4 min)
Fix comment 2 → commit → push → wait for CI (4 min)
Fix comment 3 → commit → push → wait for CI (4 min)
Total: 12 min + 3 CI runs
```

### Batched Flow

```
Fix comment 1 → commit
Fix comment 2 → commit
Fix comment 3 → commit
→ single push → wait for CI (4 min)
Total: 4 min + 1 CI run
```

### Implementation in `/review` Stage

The `/review` command should instruct the agent to:
1. List all review comments (Greptile, GitHub Actions, SonarCloud)
2. Fix ALL comments in sequence, committing each separately (for clear git history)
3. Push ONCE at the end with `forge push --quick`
4. Reply to review threads referencing commit SHAs

### Tradeoffs

| Approach | Pros | Cons |
|----------|------|------|
| Push per fix | Reviewer sees progress; each fix isolated | 6-8 min per fix; CI queue |
| Batch all fixes | One push cycle; one CI run | Reviewer waits longer; merge conflicts if base moves |
| Batch + push --quick | ~10s local + one CI run | Small risk of CI failure on batch |

**Recommendation**: Batch all fixes + `forge push --quick`. The `/review` stage already processes all comments in one session. Pushing once at the end is natural.

---

## 8. Implementation Roadmap

### Phase 1: Quick Wins (1-2 hours)

1. **Affected-only lint in `forge push --quick`**
   - Get changed files from `git diff --name-only HEAD~1`
   - Pass file list to `eslint` directly (skip `npm run lint`)
   - Saves 25-55s per quick push

2. **Batch push guidance in `/review` command**
   - Update `.claude/commands/review.md` to instruct: "fix all, commit each, push once"
   - No code changes needed — just workflow guidance

### Phase 2: Import Graph Test Selection (4-8 hours)

3. **Build lightweight import graph**
   - Parse `require()` statements from `lib/**/*.js`
   - Build reverse dependency map
   - Enhance `getAffectedTestFiles()` to walk the graph

4. **Wire into `forge push --affected`**
   - New flag that runs affected lint + affected tests
   - Middle ground between `--quick` (no tests) and full (all tests)

### Phase 3: Coverage-Based Selection (future)

5. **Generate coverage map in CI**
   - Run tests with `c8` coverage in CI
   - Extract file-to-test mapping from coverage report
   - Cache as `.forge/test-coverage-map.json`

6. **Use coverage map in `getAffectedTestFiles()`**
   - Prefer coverage map over import graph
   - Fall back to import graph → convention

---

## 9. Decision Points for Implementation

| Question | Options | Recommendation |
|----------|---------|----------------|
| Should `--quick` lint affected-only? | Yes / No (full lint) | **Yes** — 90% of value, minimal risk |
| Should `--quick` be default in `/review`? | Yes / Auto-detect / Manual | **Auto-detect** in `/review` stage |
| Import graph: regex or AST? | Regex / Acorn / Madge | **Regex** first, upgrade if needed |
| Coverage map: generate where? | CI only / Local + CI | **CI only** (local coverage slows tests) |
| Batch pushes: enforce or suggest? | Hard rule / Suggestion | **Suggestion** in `/review` docs |
