# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: `/check` was renamed to `/validate` and `/merge` was renamed to `/premerge` in v0.0.3. Historical entries below may use the old names.

## [Unreleased]

## [0.0.4] - 2026-03-22

### Added

- **Multi-dev session awareness: conflict detection, parallel work visibility** (PR #92, forge-w69s)
  - Pluggable sync backend (`refs`/`branch`/`inline`) for cross-developer beads sync via git
  - File index (`.beads/file-index.jsonl`) tracks which developer touches which files/modules
  - Conflict detection script with module-level overlap warnings and `--detail` drill-down
  - Cross-developer "Team Activity" section in `/status` with overlap and staleness warnings
  - Soft-block gates on `/plan` and `/dev` entry when module overlap detected
  - Auto-sync at Forge command entry pulls latest team state
  - Session identity as `email@hostname`, sync branch auto-detection with config override
  - 136 new shell tests across 5 test suites

- **Smart Setup UX: agent detection, incremental setup, clean output** (PR #90, forge-iv8b)
  - 4-layer agent auto-detection: `AI_AGENT` env > agent-specific env vars > VSCode path parsing > config file signatures (8 agents)
  - Incremental setup: content-hash comparison skips identical files on re-run; `--force` flag for CI/overwrite
  - Progressive summary output: clean 3-line default, `--verbose` for file-by-file detail
  - Lazy directory creation: `docs/planning/` and `docs/research/` created on first `/plan` use, not at setup
  - Worktree detection utility: prevents nested worktree creation in `/plan`
  - 5 new lib modules: `detect-agent.js`, `setup-action-log.js`, `file-hash.js`, `detect-worktree.js`, `setup-summary-renderer.js`
  - 124 new tests across 9 test files

### Removed

- **`docs/WORKFLOW.md`** — content duplicated in `AGENTS.md`; all 50+ references updated (PR #90, forge-iv8b)

### Fixed

- **Smart-status.sh jq date parsing** for fractional seconds + timezone offsets (PR #90, forge-iv8b)
- **CI bypass workflow** — removed `test/**` from `paths-ignore` to unblock test-only PRs (PR #90, forge-iv8b)
- **Ship command rebases onto latest base branch before push** (PR #89, forge-ebls)
  - `/validate` entry gate: rebases onto base branch (detected dynamically) before running checks
  - `/ship` freshness check: lightweight behind-check before push, alerts if stale
  - Fetch failures caught with `|| { exit 1; }` guards
  - `bun run check` clarified as checks-only (no rebase)

### Changed

- **PR template restructured to narrative format** (PR #89, forge-ebls)
  - Visible: Problem → Root Cause → Fix → Value → Beads
  - Collapsible `<details>`: Test Coverage, Security Review, Design Doc, Decisions Log, Documentation Updated, Validation checklist
  - Tips section updated to reinforce narrative-first approach

### Added

- **Workflow Intelligence: smart status, phase tracking, naming clarity** (PR #72, forge-68oj)
  - `scripts/smart-status.sh`: Ranks all issues by composite score (priority × unblock chain × type × status boost × epic proximity × staleness)
  - Grouped output: Resume → Unblock Chains → Ready Work → Blocked → Backlog with ANSI colors and NO_COLOR support
  - Active session detection: parses `git worktree list --porcelain`, maps branches to in-progress beads issues
  - Two-tier conflict detection: Tier 1 (file-level overlap via `git diff`) + Tier 2 (actual merge conflicts via `git merge-tree`, git 2.38+)
  - `/plan` now creates epic at Phase 1 entry with stage transitions at each phase boundary
  - `/status` updated to use `smart-status.sh` for dynamic ranked output
  - Disambiguation note added to `/validate` command (three concepts: /validate, forge-preflight, bun run check)
  - Auto-detect default branch (master/main) with `DEFAULT_BRANCH` env override
  - Reverse dependency map computes "Unblocks:" annotations from actual dependency data
  - 67 new tests, 0 regressions

### Changed

- **CLI prerequisite checker renamed to `forge-preflight`** (PR #72, forge-0xic)
  - Clearer name distinguishes it from `/validate` workflow command and `bun run check`
  - Updated: bin entry, package.json, README, CHANGELOG, DEVELOPMENT, docs/VALIDATION, docs/research/
  - Fixed pre-existing bug: `validateDev` now checks `docs/plans/` (was `.claude/plans/`)
  - Fixed Node compat: removed `readdirSync({ recursive })` (requires Node 18.17+)

- **Dynamic commands rule** (PR #72)
  - Added to AGENTS.md and CLAUDE.md: never hardcode example output in command files when scripts generate it dynamically

### Fixed

- **P2 bug fixes: setup, postinstall, dead config, lint hooks** (PR #69, forge-cpnj + forge-iv1p + forge-8u6q + forge-zs2u)
  - Setup code paths unified: extracted `executeSetup()` shared helper, fixed claude agent being skipped in CLI path
  - Removed `postinstall` script — no more surprise file writes on `npm install`
  - Added `[FORGE_SETUP_REQUIRED]` first-run detection with exit code 1
  - Added `--yes`/`-y` flag for non-interactive setup (AI agent friendly)
  - Removed dead `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` config objects
  - Replaced `npx --yes eslint` in lint.js with package manager delegation (eliminates supply chain risk)
  - Added `--max-warnings 0` to package.json lint script
  - Added `--version`/`-V` flag handling
  - Exempted `recommend` command from first-run guard (read-only, useful for onboarding)
  - 38 new tests (1676 → 1714)

- **Stage naming consistency + COMMANDS array fix** (PR #67, forge-7lvz + forge-b262)
  - Replaced hardcoded COMMANDS array with `getWorkflowCommands()` — scans `.claude/commands/*.md` at runtime
  - Fixed stale `/check` → `/validate` and `/merge` → `/premerge` in CURSOR_RULE and `.cursorrules`
  - Dynamic copy/convert counts — reports actual successes, not filesystem count
  - `copyFile` now always warns on missing sources (was DEBUG-only)
  - Fixed CLAUDE.md placeholder description
  - Fixed README agent count: "7" → "8" to match `lib/agents/`
  - 24 new regression tests across 2 test files

- **Hook bypass protection for AI agents** (PR #66)
  - `scripts/branch-protection.js`: Allow beads-only pushes to master while blocking code changes
  - Replaced `execSync` with `execFileSync` + `resolveGitBinary()` to prevent command injection
  - Added `isSafeGitRefComponent()` validation on all branch name paths
  - Gated `FORGE_GIT_MOCK_JS` behind `NODE_ENV=test` to prevent bypass in production
  - Removed `LEFTHOOK=0` and `--no-verify` bypass guidance from all hook scripts
  - Added behavioral integration tests with cross-platform mock git (Node.js shim)
  - Updated `CLAUDE.md`: AI agents must never bypass hooks

### Added

- **Logic-level dependency detection**: Upgrades dep-guard `check-ripple` from keyword-only matching to structured code-aware analysis (PR #65, forge-9zv)
  - `lib/dep-guard/analyzer.js`: Phase 3 structured analyzer — scores dependencies across import, contract, and behavioral dimensions
  - `lib/dep-guard/import-detector.js`: Traces actual `require`/`import` statements between task files using `@babel/parser`
  - `lib/dep-guard/task-parser.js`: Extracts file-to-function mappings from task list markdown
  - `scripts/dep-guard-analyze.js`: CLI entry point for the structured analyzer
  - `apply-decision` subcommand: Beads approval flow with cycle detection, rollback, and state persistence
  - Graceful fallback: structured analyzer failure falls through to keyword-only check
  - 107+ new tests covering analyzer, import detector, and approval flow

- **Command behavioral eval + improvement loop**: Automated testing infrastructure for slash commands with LLM-based grading (PR #63, forge-agp)
  - `scripts/run-command-eval.js`: E2E eval pipeline — runs commands in isolated worktrees, grades transcripts against assertions
  - `scripts/improve-command.js`: Semi-autonomous improvement loop with pause-on-regression and cross-session eval history
  - Three assertion types: standard (output correctness), HARD-GATE (gate enforcement), contract (cross-command pipeline integrity)
  - `.claude/agents/command-grader.md`: LLM grader agent with strict grading guidelines
  - Eval sets for `/status` and `/validate` as first targets
  - 110 new tests across 10 test files, all passing

- **Pre-change dependency guard**: Contract-aware ripple analysis that detects logic conflicts between in-flight issues before work begins (PR #62, forge-mze)
  - `scripts/dep-guard.sh`: 4 subcommands — `find-consumers`, `check-ripple`, `store-contracts`, `extract-contracts`
  - `/plan` Phase 1: Advisory ripple check before design Q&A surfaces overlapping open issues
  - `/plan` Phase 3: Auto-extract contracts from task list and store on Beads issue
  - Ripple Analyst agent prompt: LLM-judged impact analysis (NONE/LOW/HIGH/CRITICAL)
  - Keyword matching with stop-word filtering, timestamp-based contract dedup
  - 29 tests covering all subcommands with mock-based `BD_CMD` testing pattern

### Fixed

- **Roo Code rootConfig conflict**: Changed from `.clinerules` to `.roorules` — was conflicting with Cline during setup (PR #61)
- **Cline workflows directory clash**: Moved from `.clinerules/workflows/` to `.cline/workflows/` — `.clinerules` was being created as a directory, blocking the root config symlink (PR #61)
- **Symlink safety**: `createSymlinkOrCopy` now uses `lstatSync` to avoid false positives on symlinks to directories, with actionable warning for users (PR #61)
- **Cross-codepath sync**: Updated `sync-commands.js`, `install.sh`, tests, and sync manifest to match new Cline/Roo paths (PR #61)

### Changed

- **Version reset to 0.0.1**: All prior npm versions (1.0.0–1.5.0) unpublished; clean alpha start (PR #61)
- **Removed `.clinerules` flat-file migration**: No longer needed since Cline workflows moved to `.cline/workflows/` (PR #61)

### Added

- **Beads-embedded plan context**: Auto-populate design/notes/acceptance in Beads issues from `/plan` and `/dev` (PR #59, forge-bmy)
  - `scripts/beads-context.sh`: Agent-agnostic helper with 5 commands (`set-design`, `set-acceptance`, `update-progress`, `parse-progress`, `stage-transition`)
  - `/plan` Phase 3: Embeds task count + file path in `--design`, success criteria in `--acceptance`
  - `/dev` Step E: Appends per-task progress (title, tests, commit, gates) to `--notes` as HARD-GATE
  - `/status`: Shows compact progress ("3/7 tasks done | Last: title (sha)") with `bd show` hint
  - Stage transitions recorded via `--comment` at `/plan`, `/dev`, `/validate`, `/ship`, `/review` exits
  - `scripts/**` added to CI test workflow path filters
- **`forge check-agents` CLI**: Validates all agent command files are in sync and plugin catalog matches reality (`node scripts/check-agents.js`) (PR #60, forge-2w3)

### Changed

- **Plugin catalog**: Updated capability flags for 6 agents — Cursor, Cline, Copilot, Kilo Code, Codex now correctly report `commands: true`; Claude Code reports `hooks: true` (PR #60, forge-2w3)

### Removed

- **Dropped agent cleanup**: Removed all code, config, docs, and files for 4 dropped agents — Antigravity, Windsurf, Aider, Continue (PR #60, forge-2w3)
  - Deleted: `.aider.conf.yml`, `lib/agents/continue.plugin.json`, `docs/README-v1.3.md`, `docs/research/agent-instructions-sync.md`
  - Cleaned: `bin/forge.js` (Continue setup), `packages/skills/` (agent entries), `package.json` (keywords), `.gitignore` (dropped dirs)
  - Fixed: `package.json` description from "9-stage" to "7-stage"

### Fixed

- **Stale workflow refs**: Cleaned up references to removed tools and orphaned files in agent commands (PR #56, forge-ctc)
  - `status.md`: Replaced openspec/PROGRESS.md commands with Beads equivalents, fixed /research → /plan
  - `rollback.md`: Updated workflow diagrams to correct 7-stage pipeline (removed /research)
  - `premerge.md`: Replaced PROGRESS.md reference with CHANGELOG.md maintenance step
  - Fixed inconsistent example output in status.md (in-progress work vs "Ready for new feature")

## [1.5.0] - 2026-02-03

### Added

- **Plugin Architecture**: 11 specialized agent plugins for enhanced capabilities
  - `javascript-typescript`: JavaScript/TypeScript expertise (4 skills)
  - `backend-development`: API design, microservices, Temporal workflows (9 skills)
  - `database-design`: PostgreSQL, SQL optimization (2 skills)
  - `security-scanning`: SAST, threat modeling, STRIDE analysis (6 skills)
  - `full-stack-orchestration`: Deployment, performance, testing (4 skills)
  - `tdd-workflows`: TDD orchestration, code review (2 skills)
  - `llm-application-dev`: RAG, embeddings, prompt engineering (7 skills)
  - `frontend-design`: Production-grade UI development (1 skill)

- **TDD Enforcement**: Git hooks via Lefthook
  - Pre-commit hook checks for test files before allowing source commits
  - Pre-push hook runs full test suite
  - Interactive prompts for violations with recovery options
  - CI/CD-aware: auto-aborts in non-interactive environments
  - Package manager auto-detection (bun/pnpm/yarn/npm)

- **Preflight CLI**: `forge-preflight` command
  - `forge-preflight status` - Check project prerequisites
  - `forge-preflight dev` - Validate before /dev stage
  - `forge-preflight ship` - Validate before /ship stage

- **Auto-Installation**: Beads and OpenSpec setup
  - Quick setup mode auto-installs Beads
  - Interactive setup prompts for both tools
  - Dynamic tool status in project summary

- **AGENTS.md Enhancements**: Optimized universal instructions
  - Plugin loading instructions
  - Workflow stage documentation
  - Security and TDD guidelines

### Improved

- **Test Patterns**: Comprehensive test file detection
  - Nested directories: `test/unit/`, `test/integration/`
  - Colocated tests: `__tests__/` directories
  - Both `.test` and `.spec` variants

- **Error Handling**: Safer recursive file operations
  - Try/catch for directory reads
  - Graceful failures in validation

### Fixed

- Non-TTY environment handling in TDD hook (CI/CD compatibility)
- Silent failure in lefthook prepare script (now shows informative message)

## [1.4.9] - 2025-02-02

### Fixed

- **Code Quality Overhaul**: Resolved 101 SonarLint and linting warnings
  - Fixed 42 structural warnings (exception handling, control flow, code patterns)
  - Fixed 35 cognitive complexity warnings by extracting 47 helper functions
  - Modernized JavaScript patterns (Number.parseInt, Number.isNaN, optional chaining)
  - Applied node: protocol for all built-in module imports
  - Improved exception handling with meaningful comments
  - Converted negated conditions to positive logic
  - Fixed nested ternary operations and if-in-else blocks

### Refactored

- **8 Core Functions** - Reduced cognitive complexity from 24-57 to 5-10:
  - `detectProjectType()` - 27→8 (14 helpers: framework detection, feature detection)
  - `handleInstructionFiles()` - 37→5 (6 helpers: scenario handlers)
  - `setupAgent()` - 40→8 (10 helpers: agent-specific setup, file operations)
  - `interactiveSetup()` - 36→8 (9 helpers: UI, validation, workflow)
  - `main()` - 24→10 (5 helpers: CLI parsing, setup orchestration)
  - `extractUserSections()` - 25→8 (2 helpers: marker/command extraction)
  - `performRollback()` - 32→10 (7 helpers: method-specific handlers)
  - Plus 1 additional function refactored

### Improved

- **Maintainability**: Single responsibility principle applied throughout
- **Testability**: 47 new focused helper functions can be tested independently
- **Readability**: Clear function names, reduced nesting, improved code organization
- **Code Quality**: Zero SonarLint warnings (except optional S7785 - CommonJS limitation)
- **Documentation**: Comprehensive inline comments for exception handling

### Changed

- Internal code structure significantly reorganized (no API changes)
- +1,056 lines (helper functions), -749 lines (refactored complexity)
- Net: +307 lines with better separation of concerns

## [1.4.8] - 2025-02-02

### Fixed

- **Additional markdown linting**: Expanded markdownlint configuration
  - Disabled MD031 (blanks around fenced code blocks)
  - Disabled MD032 (blanks around lists)
  - Disabled MD040 (fenced code language)
  - Disabled MD041 (first line heading level)
  - Disabled MD022 (blanks around headings)
  - Disabled MD060 (table column count)
  - Fixed .claude/skills/forge-workflow/SKILL.md formatting
  - Updated .markdownlint.json with comprehensive rule suppressions

### Improved

- Zero markdown linting warnings across all documentation
- Cleaner IDE experience with focused, actionable linting rules

## [1.4.7] - 2025-02-02

### Fixed

- **Line length warnings**: Disabled MD013 line-length rule
  - 80-character limit too restrictive for modern documentation
  - Especially problematic for changelog descriptions
  - Updated .markdownlint.json to disable MD013

### Improved

- Zero IDE warnings - completely clean development environment

## [1.4.6] - 2025-02-02

### Fixed

- **IDE linting issues**: Fixed all 100+ markdownlint warnings
  - Fixed table formatting in .clinerules (MD060 - proper spacing around pipes)
  - Added language specification to code blocks (MD040)
  - Added blank lines around lists (MD032)
  - Created .markdownlint.json config to suppress false positives in CHANGELOG.md

### Improved

- Clean IDE experience with zero linting warnings
- Proper markdown formatting across all documentation files

## [1.4.5] - 2025-02-02

### Changed

- **Automatic versioning**: Version now read from package.json (single source of truth)
  - Added VERSION constant from package.json
  - Replaced all hardcoded version strings with VERSION variable
  - No more manual version updates needed in bin/forge.js
  - Simply run `npm version patch/minor/major` to bump version everywhere

### Improved

- Version management simplified - update package.json only
- Eliminates risk of version mismatch between package.json and displayed version

## [1.4.4] - 2025-02-02

### Fixed

- **Version banner**: Updated all version strings from v1.3.0 to v1.4.4
  - Fixed version display in CLI banner
  - Updated all setup completion messages
  - Ensures correct version is shown to users

- **Documentation setup**: Fixed missing documentation files during `npx forge setup`
  - Created `setupCoreDocs()` helper function
  - Now copies docs/WORKFLOW.md to project during setup
  - Now copies docs/research/TEMPLATE.md to project during setup
  - Creates docs/planning/PROGRESS.md during setup
  - Applies to all setup modes: interactive, quick, and agent-specific

### Changed

- Extracted documentation setup logic into reusable `setupCoreDocs()` function
- All setup commands now provide complete documentation structure
- Users no longer need to reference node_modules for workflow templates

## [1.4.3] - 2025-01-31

### Fixed

- **Critical package fix**: Properly exclude local user settings from npm package
  - Updated package.json `files` array to explicitly include only necessary .claude/ subdirectories
  - Prevents .claude/settings.json and .claude/settings.local.json from being published
  - v1.4.2 still included these files due to `files` array overriding .npmignore

### Security

- **CRITICAL**: v1.4.0, v1.4.1, and v1.4.2 inadvertently published user-specific permission settings
  - Users who installed these versions should check if their .claude/settings*.json files were overwritten
  - These files are now properly excluded in v1.4.3+

## [1.4.2] - 2025-01-31

### Fixed

- **npm package cleanup**: Attempted to exclude local user settings (incomplete fix)
  - Added .npmignore (did not work due to `files` array in package.json)
  - See v1.4.3 for complete fix

## [1.4.1] - 2025-01-31

### Changed

- **README simplified**: Reduced from 860 to 316 lines (63% reduction)
  - Focused on value proposition and quick start
  - Removed detailed setup instructions (moved to docs/SETUP.md)
  - Removed lengthy examples (moved to docs/EXAMPLES.md)
  - Added clear "Next Steps" section with links to guides
  - Before/after comparison showing Forge value
  - Scannable in under 2 minutes

### Added

- **QUICKSTART.md**: Complete beginner guide (5-minute walkthrough)
  - Step-by-step first feature implementation
  - Actual commands with expected outputs
  - Health check endpoint example
  - All 9 stages demonstrated
- **docs/SETUP.md**: Comprehensive setup guide
  - All agent-specific setup instructions (11+ agents)
  - External services configuration (GitHub, SonarCloud, Greptile, etc.)
  - Beads and OpenSpec detailed setup
  - Troubleshooting section
  - Environment variables reference
- **docs/EXAMPLES.md**: Real-world workflow examples
  - Simple feature (15 minutes)
  - Bug fix with security (30 minutes)
  - Multi-file refactor (2-3 hours)
  - Architecture change with OpenSpec (2-3 days)
  - Team collaboration with Beads
- **docs/README-v1.3.md**: Archive of previous README for reference

### Improved

- Documentation now follows progressive disclosure:
  - Beginners → README + QUICKSTART.md
  - Intermediate → docs/EXAMPLES.md
  - Advanced → docs/SETUP.md + docs/TOOLCHAIN.md
- All technical content preserved, just better organized
- Easier to find specific information
- Better onboarding for new users

## [1.4.0] - 2025-01-31

### Added

- **Plan-Act-Reflect reminders**: Gentle reflection prompts in /plan, /dev, and /check commands
  - Non-intrusive blockquote format at critical decision points
  - Prompts to review research docs and consider complexity
  - "If unsure" conditionals to avoid being prescriptive
- **Smart project detection**: Auto-detect framework, language, tooling with confidence scores
  - Supports 12+ frameworks: Next.js, React, Vue, Angular, Svelte, NestJS, Express, Fastify, and more
  - Confidence scoring (60-100) with visual indicators (✓ for 90%+, ~ for lower)
  - Detects TypeScript, monorepo, Docker, and CI/CD configurations
- **AGENTS.md metadata**: Auto-populate with framework-specific tips and conventions
  - Framework-specific development tips (3 per framework)
  - Build tool detection (Vite, Webpack, Next, etc.)
  - Test framework detection (Jest, Vitest, Playwright, Cypress, etc.)
  - Automatic insertion after project description
- **Rollback system**: `forge rollback` command with USER section preservation
  - Interactive menu with 6 options
  - Comprehensive input validation for security
  - Automatic USER section extraction and restoration
  - Custom commands preservation in `.claude/commands/custom/`
- **4 rollback methods**:
  - Last commit: Quick undo of most recent change
  - Specific commit: Target any commit by hash
  - Merged PR: Revert entire PR merge with Beads integration
  - Partial rollback: Restore specific files only
  - Branch range: Revert multiple commits
- **Dry run mode**: Preview rollback changes without executing
  - Shows affected files
  - Lists USER sections that would be preserved
  - Lists custom commands that would be preserved
  - No git operations performed
- **Input validation**: Comprehensive validation for all rollback inputs
  - Commit hash validation (4-40 character hex strings or 'HEAD')
  - Path traversal protection using `path.resolve()` and `startsWith()`
  - Shell metacharacter rejection (`;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `<`, `>`, `\n`, `\r`)
  - Method whitelist validation
- **Beads integration**: Auto-update issue status on PR rollback
  - Parses commit message for issue number
  - Updates issue status to 'reverted'
  - Adds comment: "PR reverted by rollback"
  - Silently skips if Beads not installed

### Changed

- AGENTS.md now includes auto-detected project metadata after setup
- Setup completion message includes project detection results with confidence indicators
- COMMANDS array now includes 'rollback' for command file distribution

### Security

- Added comprehensive input validation for all rollback commands to prevent command injection
- Path traversal protection for file operations using canonical path resolution
- Commit hash format validation to reject malicious inputs
- Shell metacharacter rejection in all user-provided inputs
- Non-destructive rollback using `git revert` (never uses `git reset --hard`)

### Documentation

- Added `.claude/commands/rollback.md` with complete rollback documentation
- Updated `docs/WORKFLOW.md` with recovery section
- Added troubleshooting guide for common rollback issues
- Added examples for all rollback methods

## [1.3.1] - Previous Release

(Previous changelog entries would go here)
