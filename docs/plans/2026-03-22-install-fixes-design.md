# Design Doc: Fix All 10 Forge Installation Issues

- **Feature**: install-fixes
- **Date**: 2026-03-22
- **Status**: approved
- **Epic**: forge-on7a

## Purpose

Forge's npm package distribution is incomplete — critical scripts, flags, and UX flows are broken or missing. Users who run `bun install forge-workflow && bunx forge setup` don't get a working setup without manual intervention. This PR fixes all 10 reported installation issues in a single unified refactor.

## Success Criteria

1. `bunx forge setup` works end-to-end in both interactive (TTY) and non-interactive (CI/piped) environments
2. `--agents=claude,cursor` selectively installs only specified agents (verified working)
3. `--dry-run` shows a simple list of files that would be created/modified/skipped
4. `--non-interactive` and `CI=true` auto-detection skip all prompts with sensible defaults
5. Lefthook scripts (`commitlint.js`, `branch-protection.js`, `lint.js`, `test.js`) are reachable after `npm install`
6. Multi-dev scripts (`sync-utils.sh`, `file-index.sh`, `conflict-detect.sh`) are reachable after `npm install`
7. Existing `CLAUDE.md` is preserved via smart merge (USER sections kept, FORGE sections updated)
8. `--symlink` flag creates `CLAUDE.md` as a symlink to `AGENTS.md` when requested
9. Husky detected → auto-migration offered: removes `.husky/`, unsets `core.hooksPath`, maps hook scripts to `lefthook.yml`
10. `install.sh` is a thin bootstrapper (~20 lines) that installs the package and delegates to `bunx forge setup`
11. README recommends `bun add -D forge-workflow` (dev dependency)

## Out of Scope

- Rewriting `bin/forge.js` internals beyond what's needed for these 10 fixes
- Adding new agents or modifying agent plugin schemas
- Changing the lefthook.yml hook structure itself
- Beads integration changes
- Workflow stage changes (plan/dev/validate/ship/review/premerge/verify)

## Approach Selected: Unified Refactor (Approach A)

**Deprecate `install.sh` to a thin bootstrapper. Consolidate all logic in `bin/forge.js`.**

Rationale:
- Industry standard: zero of 7 researched tools (Husky, ESLint, Turborepo, Vite, Changesets, Prettier, lint-staged) use a separate bash installer
- Eliminates duplication between `install.sh` (1,056 lines) and `bin/forge.js`
- Single source of truth for all setup logic
- `install.sh` becomes a ~20-line script: detect package manager, install package, call `bunx forge setup $@`

Research: See `docs/plans/2026-03-22-bootstrap-installer-research.md`

## Constraints

- Must not break existing `bunx forge setup` users (no flag renames, no removed defaults)
- `install.sh` must still work as a curl-pipe bootstrap (it just delegates now)
- Smart merge must preserve `<!-- USER:START -->` / `<!-- USER:END -->` sections
- All interactive prompts must have sensible defaults for non-interactive mode
- Husky migration must be opt-in (prompt), never forced
- `--dry-run` must exit 0 without modifying any files

## Edge Cases

1. **CLAUDE.md exists without USER markers**: Treat entire file as user content, append Forge section
2. **CLAUDE.md exists with USER markers but no FORGE markers**: Insert Forge section, preserve user sections
3. **Husky + Lefthook both present**: Warn, offer to remove Husky, don't double-install Lefthook
4. **Husky with custom hooks not mappable to Lefthook**: Warn which hooks couldn't be auto-migrated, list them for manual migration
5. **`--agents` flag with invalid agent name**: Error with list of valid agents, exit 1
6. **`--dry-run` + `--agents`**: Show what the selected agents would produce
7. **No TTY + no `--non-interactive` + no `CI` env**: Default to non-interactive behavior (safe default)
8. **`install.sh` called without bun/npm**: Error with install instructions for bun
9. **Lefthook not installed when setup runs**: Warn clearly, don't create `lefthook.yml` without the binary, suggest `bun add -D lefthook`
10. **Symlink on Windows**: Use junction or warn that symlinks require admin/developer mode

## Ambiguity Policy

7-dimension rubric scoring on spec gaps. >= 80% confidence: proceed and document. < 80%: stop and ask user.

## 10 Issues Mapped to Implementation

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | No selective agent install | Medium | Verify `--agents` flag works in `bin/forge.js`, add to `install.sh` bootstrapper passthrough |
| 2 | Lefthook install fails silently | High | Add prerequisite check before creating `lefthook.yml`, clear error message, suggest install command |
| 3 | Hook scripts not distributed | Critical | Verify `scripts/` in `files` array actually works post-publish, add integration test |
| 4 | Prod dependency in docs | Low | Update README: `bun add -D forge-workflow` |
| 5 | CLAUDE.md overwritten | High | Verify `context-merge.js` smart merge works, fix if broken, handle missing USER markers |
| 6 | No symlink option | Low | Add `--symlink` flag to create `CLAUDE.md -> AGENTS.md` symlink |
| 7 | No Husky migration | Medium | Add Husky detection, migration prompt, hook script mapping |
| 8 | Interactive blocks CI | Medium | Add `CI` env detection, `--non-interactive` flag, TTY fallback |
| 9 | No dry-run | Low | Add `--dry-run` flag, collect planned actions, print list, exit 0 |
| 10 | Multi-dev scripts not in package | High | Verify `scripts/` distribution, add package verification test |

## Technical Research

### Key Findings from Codebase Exploration

**Critical bugs found during research:**

1. **`smartMergeAgentsMd()` (bin/forge.js:734-774)**: Returns empty string `''` when existing CLAUDE.md has no USER/FORGE markers — the common case for pre-Forge projects. This signals "merge not possible" and the caller overwrites the file. **Root cause of issue #5.**

2. **`context-merge.js` IS imported** (bin/forge.js:53) and `smartMergeAgentsMd` IS defined (line 734). The explore agent initially missed these — verified via blast-radius grep.

3. **`--agents` flag works in `bin/forge.js`** (lines 2562-2712) but does NOT exist in `install.sh`.

4. **Lefthook check** (bin/forge.js:2844-2855) only checks `package.json` for `lefthook` dependency — doesn't verify the binary actually exists.

5. **No TTY detection** — no `process.stdin.isTTY` or `process.env.CI` checks found.

6. **No Husky detection** — zero references to `husky` or `.husky/` in setup logic.

7. **Missing flags**: `--non-interactive`, `--symlink`, `--dry-run` all absent from both entry points.

### Blast-Radius: install.sh Deprecation

`install.sh` is referenced in **30+ files**. All need updating:

| Location | Action |
|----------|--------|
| `docs/SETUP.md:53` | Update curl command to note bootstrapper |
| `package.json:93` | Keep in `files` array (still distributed) |
| `CHANGELOG.md:145` | Historical — no change needed |
| `docs/research/test-environment.md` (6 refs) | Update test docs |
| `test-env/README.md` | Update test instructions |
| `.github/workflows/size-check.yml` (2 refs) | Update CI workflow |
| `lib/plugin-catalog.js:51` | Different install.sh (Parallel AI) — no change |
| `.beads/README.md:64` | Different install.sh (Beads) — no change |
| Agent command files (7 refs: .claude/, .cursor/, .cline/, .roo/, .codex/, .opencode/, .github/prompts/) | Generic "install.sh / setup scripts" in plan template — no change needed |

### OWASP Top 10 Analysis

| Category | Applies | Risk | Mitigation |
|----------|---------|------|------------|
| A01 Broken Access Control | Low | File writes to project dir | Validate paths stay within project root |
| A02 Crypto Failures | Yes | `.env.local` stores API keys as plaintext, no `chmod 0600`, no input masking | Add chmod 0600, mask input during prompts |
| A03 Injection | Low | Node.js uses `secureExecFileSync` (no shell). install.sh needs shellcheck | Keep execFileSync pattern, add shellcheck to CI |
| A04 Insecure Design | Yes | `install.sh` downloads from `raw.githubusercontent.com` with no checksum, no pinned commit | Thin bootstrapper eliminates most risk — only installs npm package |
| A05 Security Misconfiguration | Low | Lefthook.yml created without binary check | Check binary exists before creating config |
| A06 Vulnerable Components | N/A | No third-party deps in setup path | — |
| A07 Auth Failures | N/A | No auth in setup | — |
| A08 Integrity Failures | Yes | No SBOM, no npm provenance, no release signing. Husky migration doesn't validate .husky/ for symlink attacks | Validate .husky/ contents are regular files before migration |
| A09 Logging Failures | Low | No audit trail of setup actions | Dry-run mode doubles as action log |
| A10 SSRF | N/A | No server-side requests | — |

### Web Research Summary

- **TTY detection**: `process.stdin.isTTY` + `process.env.CI` (covers GitHub Actions, GitLab, Travis, Vercel, Netlify). Zero-dep approach.
- **npm pack verification**: `npm pack --dry-run` lists tarball contents — use in CI test.
- **Husky migration**: Must `git config --unset core.hooksPath`. Map `.husky/` scripts to `lefthook.yml` commands.
- **Windows symlinks**: `fs.symlinkSync` needs admin. Use file copy as cross-platform fallback.
- **Dry-run pattern**: ActionCollector — collect `{ type, path, description }` pairs, print list or execute.
- **Smart merge**: Additive merge for existing configs. existence-check for new files. Always-write for Forge-owned files.

Research docs: `docs/plans/2026-03-22-bootstrap-installer-research.md`, `docs/plans/2026-03-22-install-setup-research.md`, `docs/plans/2026-03-22-owasp-top10-setup-analysis.md`

### TDD Test Scenarios

| # | Scenario | Type | What to Assert |
|---|----------|------|----------------|
| 1 | `--dry-run` lists actions without modifying files | Happy path | No files created/modified, stdout contains "Would create" lines, exit 0 |
| 2 | `--agents=claude,cursor` installs only 2 agents | Happy path | Only `.claude/` and `.cursor/` dirs created, others absent |
| 3 | `--agents=invalid` errors with valid agent list | Error path | Exit 1, stderr shows valid agents |
| 4 | Non-interactive mode (CI=true) skips all prompts | Happy path | No stdin reads, uses defaults, completes successfully |
| 5 | CLAUDE.md without markers preserved on merge | Edge case | Existing content wrapped in USER markers, FORGE section appended |
| 6 | CLAUDE.md with USER markers preserved on upgrade | Happy path | USER section unchanged, FORGE section updated |
| 7 | Husky detected → migration offered and works | Happy path | .husky/ removed, core.hooksPath unset, lefthook.yml has mapped hooks |
| 8 | Husky with unmappable hooks warns user | Edge case | Warning lists hooks that couldn't be auto-migrated |
| 9 | Lefthook binary missing → clear warning | Error path | No lefthook.yml created, warning with install command |
| 10 | `--symlink` creates CLAUDE.md → AGENTS.md link | Happy path | CLAUDE.md is a symlink (or copy on Windows) |
| 11 | `--symlink` on Windows falls back to copy | Edge case | CLAUDE.md is a copy with header comment explaining it |
| 12 | install.sh bootstrapper delegates to bunx forge setup | Happy path | Package installed, `bunx forge setup` called with passthrough args |
| 13 | npm pack includes all required scripts | Integration | `scripts/*.js` and `scripts/*.sh` present in tarball |
| 14 | Husky migration validates .husky/ files are regular files | Security | Symlinks in .husky/ rejected with warning |
| 15 | .env.local gets chmod 0600 after writing | Security | File permissions are 0600 (owner read/write only) |
