# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
