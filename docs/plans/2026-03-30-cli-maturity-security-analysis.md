# CLI Maturity Refactor — OWASP Top 10 & Blast Radius Analysis

**Date**: 2026-03-30
**Scope**: Security implications of extracting code from `bin/forge.js` (4766 lines) into `lib/commands/*.js` modules

---

## Task 1: OWASP Top 10 Analysis

| # | Category | Applies? | Risk | Evidence | Mitigation |
|---|----------|----------|------|----------|------------|
| A01 | **Broken Access Control** | LOW | Path traversal checks in `validatePathInput` (L209-214) and `validateDirectoryPathInput` (L218+) verify paths stay within `projectRoot`. `_checkWritePermission` (L267+) checks fs write access. | `validateUserInput` is only called at L2631 (`directory_path` type) within the `setup` command. If extracted functions lose access to `projectRoot` closure variable, path validation breaks. | Ensure `projectRoot` is passed explicitly to all extracted validation functions. Add test asserting path traversal rejection after extraction. |
| A02 | **Cryptographic Failures** | NONE | No crypto operations. `fileMatchesContent` (imported from `lib/file-hash` at L69) is content hashing for cache, not security crypto. `validateHashInput` (L253+) validates git commit hash format only. | N/A | N/A |
| A03 | **Injection** | **HIGH** | `secureExecFileSync` (L102-125) resolves command paths via `which`/`where.exe` before execution. `validateCommonSecurity` (L169-186) blocks shell metacharacters `;|&$\`()<>\r\n`, URL-encoded traversal (`%2e`, `%2f`, `%5c`), and non-ASCII. **15 raw `execSync`/`execFileSync` calls exist outside `secureExecFileSync`** (L309, L2902-2903, L4511, L4531, L4542, L4546, L4554, L4558, L4561, L4575, L4577, L4586, L4590, L4603, L4604). Several use template literals with `${target}` (L4542, L4546, L4554, L4558, L4561, L4586, L4590). | **Critical**: `secureExecFileSync` MUST be extracted to a shared utility (e.g., `lib/secure-exec.js`), not duplicated. All raw `execSync` calls with interpolated variables (the rollback functions at L4500+) must continue using `validateHashInput` before execution. Verify every call site post-extraction. |
| A04 | **Insecure Design** | **MEDIUM** | The registry (`_registry.js` L59-104) auto-discovers `.js` files from `commandsDir` via `readdirSync`, requires them via `require(filePath)` (L79). Files starting with `_` are excluded (L71). No path validation on `commandsDir` beyond `existsSync` check. | `commandsDir` is always constructed as `path.join(__dirname, '..', 'lib', 'commands')` at L2787 and L4141 — hardcoded relative to package. Not user-controllable. Risk is LOW as long as the registry is never called with user-supplied paths. | Add a guard in `loadCommands` asserting `commandsDir` is within the package directory. Document that registry must never accept user input as directory. |
| A05 | **Security Misconfiguration** | **MEDIUM** | The registry loads ALL `.js` files from the commands directory. If an attacker can write a file to `lib/commands/`, it auto-executes. Dynamic requires at L45-65 use `path.join(packageDir, ...)` — `packageDir` is `__dirname/..`, not user-controllable. | npm package `"files"` field (package.json L75-101) includes `lib/` — any file in `lib/commands/` ships with the package. A supply-chain attack adding a malicious command module would auto-register. | This is inherent to auto-discovery. Mitigate with: (1) npm `files` whitelist is already scoped, (2) integrity checks via npm provenance, (3) no change needed from refactor itself — this risk exists today. |
| A06 | **Vulnerable Components** | NONE | No new dependencies added by this refactor. Existing deps: `@babel/parser`, `fastest-levenshtein` (production); `eslint`, `lefthook`, `c8`, etc. (dev). | N/A | N/A |
| A07 | **Auth Failures** | NONE | No authentication logic in affected code. `gh auth status` check (L380) is a prerequisite check only — it doesn't handle credentials. `writeEnvTokens` (L637+) writes tool tokens (SonarCloud, Parallel AI) to `.env` but doesn't authenticate. | N/A | Ensure `.env` writing stays in setup flow, never in extracted command modules. |
| A08 | **Data Integrity** | LOW | npm package includes `bin/` and `lib/` (package.json `files` field). Extracted modules ship as part of the package. No code signing. | Standard npm supply-chain risk — unchanged by refactor. | Use npm provenance (already standard practice). No additional action. |
| A09 | **Logging Failures** | LOW | `console.log`/`console.warn`/`console.error` used throughout for command output. Registry warns on malformed modules (L81, L87, L93). No structured audit logging exists. | Refactor preserves existing logging patterns since each command module has its own logging. No audit trail exists to lose. | Consider adding structured logging as a future enhancement, not blocking for this refactor. |
| A10 | **SSRF** | NONE | No network calls in affected code. All URLs in `bin/forge.js` are hardcoded informational strings (install URLs, documentation links). No `fetch()`, `http.request()`, or outbound connections. | N/A | N/A |

### Summary of Security-Critical Items

1. **`secureExecFileSync` (L102-125)**: Must be extracted to a shared utility, never duplicated. All 15+ call sites must continue using it.
2. **`validateCommonSecurity` / `validateUserInput` (L169-206)**: Must be extracted alongside command code. Currently only called at L2631 (setup command).
3. **Raw `execSync` with `${target}` interpolation (L4542-4604)**: These are in rollback functions. If extracted, must maintain `validateHashInput` gate.
4. **Registry dynamic `require` (L79 in `_registry.js`)**: Already exists, not introduced by refactor. Path is hardcoded from `__dirname`.

---

## Task 2: Blast Radius Inventory

### Category 1: Direct Code Imports of `lib/commands/*.js`

| File | Line(s) | What it references | Breaks? | Fix needed |
|------|---------|-------------------|---------|------------|
| `bin/forge.js` | L54 | `require('../lib/commands/_registry')` — `loadCommands` | No | Path unchanged — `_registry.js` stays in `lib/commands/` |
| `bin/forge.js` | L4218 | `require('../lib/commands/recommend')` — lazy require | No | Path unchanged |
| `bin/forge.js` | L4325 | `require('../lib/commands/team.js')` — lazy require | No | Path unchanged |
| `bin/forge-cmd.js` | L13-17 | `require('../lib/commands/status')`, `plan`, `dev`, `validate`, `ship` | **Maybe** | If command module exports change (e.g., handler signature), this breaks. Verify export contracts match. |
| `test/commands/clean.test.js` | L13,23,40,89,126,163,200,216 | `require('../../lib/commands/clean')` | No | Path unchanged |
| `test/commands/dev.test.js` | L12 | `require('../../lib/commands/dev.js')` | No | Path unchanged |
| `test/commands/plan.phases.test.js` | L44,566,603 | `require('../../lib/commands/plan.js')` — imports `detectDRYViolation`, `applyYAGNIFilter` | **Maybe** | If internal helpers are reorganized, named exports must be preserved |
| `test/commands/plan.test.js` | L10 | `require('../../lib/commands/plan.js')` | No | Path unchanged |
| `test/commands/push.test.js` | L14 | `require('../../lib/commands/push.js')` | No | Path unchanged |
| `test/commands/recommend.test.js` | L5 | `require('../../lib/commands/recommend')` | No | Path unchanged |
| `test/commands/ship.test.js` | L9 | `require('../../lib/commands/ship.js')` | No | Path unchanged |
| `test/commands/status.test.js` | L10 | `require('../../lib/commands/status.js')` | No | Path unchanged |
| `test/commands/sync.test.js` | L12,22,35,52,68 | `require('../../lib/commands/sync')` | No | Path unchanged |
| `test/commands/team.test.js` | L11 | `require('../../lib/commands/team.js')` | No | Path unchanged |
| `test/commands/test.test.js` | L15 | `require('../../lib/commands/test.js')` | No | Path unchanged |
| `test/commands/validate.test.js` | L9,166 | `require('../../lib/commands/validate.js')` — imports `executeValidate` | **Maybe** | If validate internals are refactored, named exports must be preserved |
| `test/commands/worktree.test.js` | L12 | `require('../../lib/commands/worktree')` | No | Path unchanged |

### Category 2: Direct Code Imports of `bin/forge.js`

| File | Line(s) | What it references | Breaks? | Fix needed |
|------|---------|-------------------|---------|------------|
| `test/forge-commands.test.js` | L15 | `require('../bin/forge.js')` — imports `getWorkflowCommands` | **Yes if moved** | `module.exports` at L4765 exports `{ getWorkflowCommands, ensureDirWithNote }`. If these move to a lib module, update this import. |
| `test/lazy-dirs.test.js` | L63,75 | `require('../bin/forge.js')` — imports `ensureDirWithNote` | **Yes if moved** | Same as above. |
| `test/cli/forge-cmd.test.js` | L10 | `require('../../bin/forge-cmd.js')` | No | Different file, not being refactored |

### Category 3: Inter-Command Dependencies

| File | Requires | Breaks? | Fix needed |
|------|----------|---------|------------|
| `lib/commands/clean.js` L6 | `require('./worktree')` — imports `stopDolt` | No | Internal to `lib/commands/`, path stays same |
| `lib/commands/push.js` | `require('node:child_process')`, `require('node:fs')` | No | Standard node modules |
| `lib/commands/ship.js` | `require('node:child_process')`, `require('node:fs')`, `require('node:path')` | No | Standard node modules |
| All command files | `require('node:child_process')` — `execFileSync` | No | Standard, but note: commands use raw `execFileSync`, NOT `secureExecFileSync` |

### Category 4: `package.json`

| Field | Value | Breaks? | Fix needed |
|-------|-------|---------|------------|
| `bin.forge` | `"bin/forge.js"` | No | Entry point unchanged |
| `bin.forge-preflight` | `"bin/forge-preflight.js"` | No | Not affected |
| `scripts.setup` | `"node ./bin/forge.js setup"` | No | Entry point unchanged |
| `scripts.help` | `"node ./bin/forge.js --help"` | No | Entry point unchanged |
| `files` | Includes `"bin/"`, `"lib/"`, `"scripts/"` | No | All directories already included |

### Category 5: Lefthook Hooks (`lefthook.yml`)

| Hook | Command | Breaks? | Fix needed |
|------|---------|---------|------------|
| `commit-msg` | `node scripts/commitlint.js {1}` | No | Not affected |
| `pre-commit` | `node .forge/hooks/check-tdd.js` | No | Not affected |
| `pre-push: branch-protection` | `node scripts/branch-protection.js` | **Maybe** | If `branch-protection.js` gains a `require.main` guard (per beads issue forge-ezno), the lefthook invocation still works because it IS the main module |
| `pre-push: lint` | `node scripts/lint.js` | No | Already has `require.main` guard |
| `pre-push: tests` | `node scripts/test.js` | No | Already has `require.main` guard |
| `pre-push: team-sync` | `bash scripts/forge-team/lib/hooks.sh sync --quiet` | No | Not affected |

### Category 6: GitHub Workflows

| File | Reference | Breaks? | Fix needed |
|------|-----------|---------|------------|
| `.github/workflows/test.yml` L235 | `node scripts/test-dashboard.js` | No | Not affected by command extraction |
| `.github/workflows/codeql.yml` L23,32 | `'.forge/hooks/**'` path filter | No | Not affected |
| `.github/workflows/eslint.yml` L25,38 | `'.forge/hooks/**'` path filter | No | Not affected |
| Multiple workflows | `.forge/hooks/**` exclusion filters | No | Not affected |

### Category 7: Documentation

| File | Reference | Breaks? | Fix needed |
|------|-----------|---------|------------|
| `docs/planning/PROGRESS.md` L60 | References `bin/forge.js`, `lefthook.yml` | No | Historical record, no fix needed |
| `docs/planning/PROGRESS.md` L81,86 | References `lib/commands/recommend.js` | No | Path unchanged |
| `docs/planning/PROGRESS.md` L117,124 | References `lib/commands/recommend.js`, `bin/forge.js` | No | Historical record |
| `docs/planning/PROGRESS.md` L136 | States scope excludes `bin/forge.js` CLI entry point | **Maybe** | May need update if scope changes |
| `docs/planning/PROGRESS.md` L185,192 | References extracted helper functions from `bin/forge.js` | No | Historical record |

### Category 8: Agent Configs

No direct references to `lib/commands/` or `bin/forge` paths found in `.claude/`, `.cursor/`, `.cline/`, `.roo/`, `.codex/`, `.kilocode/`, `.opencode/`, or `lib/agents/`.

### Category 9: Worktree (`.worktrees/agent-parity/`)

| File | Reference | Breaks? | Fix needed |
|------|-----------|---------|------------|
| `.worktrees/agent-parity/bin/forge-cmd.js` L13-17 | Same as main tree `forge-cmd.js` | No | Worktree has its own copy |
| `.worktrees/agent-parity/bin/forge.js` L54,4218,4325 | Same as main tree | No | Worktree has its own copy |
| `.worktrees/agent-parity/test/commands/*.test.js` | Same as main tree tests | No | Worktree has its own copy |

---

## High-Risk Items Requiring Attention

1. **`secureExecFileSync` extraction** (A03 Injection, HIGH): Must become a shared utility (`lib/secure-exec.js` or similar). 15+ call sites in `bin/forge.js`, 0 in `lib/commands/` currently (commands use raw `execFileSync`). Decision needed: should extracted commands adopt `secureExecFileSync`?

2. **`bin/forge.js` exports** (Blast radius): `module.exports = { getWorkflowCommands, ensureDirWithNote }` at L4765 is imported by 3 test files. If these functions move to a lib module, 3 test imports break.

3. **`bin/forge-cmd.js`** (Blast radius): Hardcodes `require('../lib/commands/status')` etc. at L13-17 with a different dispatch pattern than the registry. Must keep command module export contracts stable.

4. **Named export contracts** (Blast radius): `plan.js` exports `detectDRYViolation` and `applyYAGNIFilter` (used in `plan.phases.test.js` L566, L603). `validate.js` exports `executeValidate` (used in `validate.test.js` L166). These internal helpers are part of the test contract.

5. **`scripts/branch-protection.js`** (Blast radius): Referenced by lefthook pre-push hook AND by beads issue forge-ezno for `require.main` guard refactoring. If this refactor touches it, coordinate with that issue.
