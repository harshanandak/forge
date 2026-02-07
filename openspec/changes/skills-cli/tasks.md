# Implementation Tasks

Implementation checklist ordered by TDD principles (test → implement → refactor).

## Week 1-2: Core CLI Foundation

### Task 1: Package Setup
- [ ] Create packages/skills/ structure
- [ ] Write package.json with dependencies (commander, yaml, fs-extra)
- [ ] Create bin/skills.js CLI entry point
- [ ] Add to workspace (if monorepo)
- [ ] Test: `skills --version` returns version

### Task 2: Registry Management (`skills init`)
- [ ] Write test: `skills init` creates .skills/ directory
- [ ] Write test: Creates .registry.json with valid schema
- [ ] Write test: Detects existing agents (Cursor, Claude Code)
- [ ] Implement: src/lib/registry.js (initializeSkillsRegistry)
- [ ] Implement: src/commands/init.js
- [ ] Test: `skills init` is idempotent (safe to run twice)

### Task 3: Skill Templates
- [ ] Write test: Load template by name (research, coding, review, testing, deployment)
- [ ] Create templates/default.md
- [ ] Create templates/research.md
- [ ] Create templates/coding.md
- [ ] Create templates/review.md
- [ ] Create templates/testing.md
- [ ] Create templates/deployment.md
- [ ] Implement: src/lib/template.js (loadTemplate, renderTemplate)
- [ ] Test: Templates have valid YAML frontmatter

### Task 4: Skill Creation (`skills create`)
- [ ] Write test: `skills create my-skill` prompts for metadata
- [ ] Write test: Creates .skills/my-skill/SKILL.md
- [ ] Write test: Creates .skills/my-skill/.skill-meta.json
- [ ] Write test: Updates .registry.json
- [ ] Write test: `--template=research` uses research template
- [ ] Implement: src/commands/create.js (interactive prompts)
- [ ] Implement: YAML frontmatter generation
- [ ] Test: Created skills are valid

### Task 5: Skill Listing (`skills list`)
- [ ] Write test: `skills list` shows all skills
- [ ] Write test: Displays name, category, description
- [ ] Write test: `--category=research` filters by category
- [ ] Implement: src/commands/list.js
- [ ] Test: Empty registry shows helpful message

## Week 3: Sync & Local Management

### Task 6: Agent Detection
- [ ] Write test: detectAgents() finds .cursor directory
- [ ] Write test: detectAgents() finds .github directory
- [ ] Write test: Returns enabled status
- [ ] Implement: src/lib/sync.js (detectAgents)
- [ ] Test: Works on Unix/Linux/macOS/Windows

### Task 7: Skill Sync (`skills sync`)
- [ ] Write test: `skills sync` copies to .cursor/skills/
- [ ] Write test: Copies to .github/skills/
- [ ] Write test: Preserves SKILL.md and .skill-meta.json
- [ ] Write test: Handles missing agent directories gracefully
- [ ] Implement: src/commands/sync.js
- [ ] Implement: src/lib/sync.js (syncSkillsToAgents)
- [ ] Test: Sync is idempotent

### Task 8: Skill Removal (`skills remove`)
- [ ] Write test: `skills remove my-skill` deletes from .skills/
- [ ] Write test: Updates .registry.json
- [ ] Write test: Confirms before deletion
- [ ] Write test: `--force` skips confirmation
- [ ] Implement: src/commands/remove.js
- [ ] Test: Handles non-existent skills gracefully

### Task 9: Windows Compatibility
- [ ] Test: fs.cpSync works on Windows
- [ ] Test: Path separators work on Windows
- [ ] Test: Agent detection works on Windows
- [ ] Fix: Any Windows-specific issues
- [ ] Document: Windows-specific notes in README

### Task 10: Auto-sync
- [ ] Write test: `skills create` auto-syncs
- [ ] Write test: `skills add` auto-syncs (stub for now)
- [ ] Implement: Auto-sync after create/add/remove
- [ ] Test: Can disable auto-sync with config

## Week 4: Vercel Registry Integration

### Task 11: API Client
- [ ] Write test: Fetch skills from Vercel API
- [ ] Write test: Handle API errors gracefully
- [ ] Write test: Retry on network failures
- [ ] Implement: src/lib/vercel-api.js
- [ ] Test: Mock API responses in tests

### Task 12: Skill Publishing (`skills publish`)
- [ ] Write test: `skills publish my-skill` validates skill
- [ ] Write test: Uploads to Vercel registry
- [ ] Write test: Requires API key
- [ ] Write test: Shows published URL
- [ ] Implement: src/commands/publish.js
- [ ] Test: Handles publish failures

### Task 13: Skill Installation (`skills add`)
- [ ] Write test: `skills add awesome-skill` downloads from Vercel
- [ ] Write test: Creates .skills/awesome-skill/
- [ ] Write test: Auto-syncs to agents
- [ ] Write test: Updates .registry.json
- [ ] Implement: src/commands/add.js
- [ ] Test: Handles network failures

### Task 14: Skill Search (`skills search`)
- [ ] Write test: `skills search react` queries Vercel API
- [ ] Write test: Displays results (name, description, author)
- [ ] Write test: Shows install command
- [ ] Write test: Handles no results
- [ ] Implement: src/commands/search.js
- [ ] Test: Pagination works

### Task 15: API Authentication
- [ ] Write test: Read API key from env variable
- [ ] Write test: Read API key from .skills/.config.json
- [ ] Write test: `skills config set vercel-api-key <key>` saves key
- [ ] Implement: src/lib/config.js
- [ ] Test: API key is never logged

## Week 5: Validation & Quality

### Task 16: YAML Validator
- [ ] Write test: Valid YAML frontmatter passes
- [ ] Write test: Missing required fields fail
- [ ] Write test: Invalid YAML syntax fails
- [ ] Implement: src/lib/validator.js (validateYamlFrontmatter)
- [ ] Test: Helpful error messages

### Task 17: Markdown Validator
- [ ] Write test: Valid Markdown passes
- [ ] Write test: Detect malformed Markdown
- [ ] Write test: Warn on missing sections
- [ ] Implement: src/lib/validator.js (validateMarkdown)
- [ ] Test: Non-blocking warnings

### Task 18: Skill Validation (`skills validate`)
- [ ] Write test: `skills validate .skills/my-skill/SKILL.md` checks file
- [ ] Write test: Validates YAML + Markdown
- [ ] Write test: Validates .skill-meta.json
- [ ] Write test: Exit code 0 on success, 1 on failure
- [ ] Implement: src/commands/validate.js
- [ ] Test: CI integration (validate all skills in CI)

### Task 19: Error Handling
- [ ] Review all commands for error handling
- [ ] Add helpful error messages
- [ ] Add --debug flag for verbose output
- [ ] Test: All error cases have user-friendly messages

### Task 20: Real Skill Testing
- [ ] Test with parallel-ai skill (real example)
- [ ] Test with sonarcloud skill (real example)
- [ ] Test with frontend-design skill (real example)
- [ ] Fix any issues discovered
- [ ] Document: Known issues/limitations

## Week 6: Forge Integration & Polish

### Task 21: Forge Detection (`checkForSkills`)
- [ ] Write test: findInPath('skills') finds global install
- [ ] Write test: Detects local node_modules/.bin/skills
- [ ] Write test: Returns bunx fallback
- [ ] Implement: bin/forge.js (checkForSkills function)
- [ ] Test: 3-tier detection works

### Task 22: Forge Initialization (`initializeSkills`)
- [ ] Write test: Calls `skills init` using spawn
- [ ] Write test: Handles command not found
- [ ] Write test: Shows success message
- [ ] Implement: bin/forge.js (initializeSkills function)
- [ ] Test: Safe command execution (no injection)

### Task 23: Forge Setup Prompts
- [ ] Write test: promptToolchainSetup includes skills
- [ ] Write test: Prompts to install if not found
- [ ] Write test: Prompts to initialize .skills/
- [ ] Implement: bin/forge.js (update promptToolchainSetup)
- [ ] Test: Integration with existing setup flow

### Task 24: AGENTS.md Generation
- [ ] Write test: `skills sync` updates AGENTS.md
- [ ] Write test: `--preserve-agents` skips update
- [ ] Write test: Creates backup before overwrite
- [ ] Implement: src/lib/agents-md.js (updateAgentsMdFromSkills)
- [ ] Test: Generated AGENTS.md is valid Markdown

### Task 25: Documentation
- [ ] Write README.md (installation, usage, examples)
- [ ] Write CONTRIBUTING.md (development setup)
- [ ] Write API.md (programmatic API)
- [ ] Add JSDoc comments to all functions
- [ ] Generate API docs with typedoc

### Task 26: Release v1.0.0
- [ ] Run full test suite (100% pass)
- [ ] Test on Unix/Linux/macOS/Windows
- [ ] Update CHANGELOG.md
- [ ] Tag v1.0.0
- [ ] Publish to npm: `npm publish @forge/skills`
- [ ] Announce: Documentation site, Discord, Twitter

## Weeks 7-8: v1.1 (AI-Powered Creation)

### Task 27: Manager Agent
- [ ] Write test: Manager agent parses user description
- [ ] Write test: Spawns Writer and Validator sub-agents
- [ ] Write test: Returns final SKILL.md
- [ ] Implement: src/agents/manager.js
- [ ] Test: Error handling for agent failures

### Task 28: Writer Sub-agent
- [ ] Write test: Generates comprehensive SKILL.md
- [ ] Write test: Includes YAML frontmatter
- [ ] Write test: Includes examples and success criteria
- [ ] Implement: src/agents/writer.js
- [ ] Test: Quality of generated content

### Task 29: Validator Sub-agent
- [ ] Write test: Validates YAML frontmatter
- [ ] Write test: Checks completeness
- [ ] Write test: Returns suggestions for improvement
- [ ] Implement: src/agents/validator.js
- [ ] Test: Catches common issues

### Task 30: AI-Powered Create (`skills create --ai`)
- [ ] Write test: `skills create --ai "description"` works
- [ ] Write test: Takes 15-30 seconds
- [ ] Write test: Generates production-ready skill
- [ ] Implement: src/commands/create.js (--ai flag)
- [ ] Test: 5+ complex examples (React best practices, etc.)

### Task 31: Skill Refinement (`skills refine --ai`)
- [ ] Write test: `skills refine my-skill --ai` improves skill
- [ ] Write test: Suggests improvements based on usage
- [ ] Write test: Preserves user customizations
- [ ] Implement: src/commands/refine.js
- [ ] Test: Before/after comparison

### Task 32: Cost Estimation
- [ ] Implement: Track API calls and tokens
- [ ] Display: Estimated cost before AI operation
- [ ] Implement: `--cost-limit` flag
- [ ] Test: Cost tracking is accurate

### Task 33: Release v1.1.0
- [ ] Run full test suite (100% pass)
- [ ] Update documentation with AI features
- [ ] Update CHANGELOG.md
- [ ] Tag v1.1.0
- [ ] Publish to npm: `npm publish @forge/skills`
- [ ] Announce: Marketing push on AI-powered features

---

## Test Coverage Requirements

- **Unit tests**: 100% coverage for all src/lib/ modules
- **Integration tests**: All CLI commands
- **E2E tests**: Full workflows (create → sync → publish → add)
- **Platform tests**: Unix/Linux/macOS/Windows
- **Security tests**: Command injection, path traversal

## TDD Workflow

For each task:
1. **RED**: Write failing test
2. **GREEN**: Implement minimum code to pass
3. **REFACTOR**: Clean up, extract helpers
4. **COMMIT**: `git commit -m "test: <description>"` then `git commit -m "feat: <description>"`
