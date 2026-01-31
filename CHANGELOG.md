# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
