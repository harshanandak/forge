# Skills CLI Capability

Universal CLI tool for managing SKILL.md files across all AI agents.

## ADDED Requirements

### R1: Initialize Skills Registry

The `skills init` command SHALL initialize a `.skills/` directory with registry and configuration.

#### Scenario: Initialize in fresh project
GIVEN a project without `.skills/` directory
WHEN user runs `skills init`
THEN `.skills/` directory is created
AND `.skills/.registry.json` is created with valid schema
AND agent detection runs automatically
AND success message is displayed

#### Scenario: Initialize in existing project
GIVEN a project with existing `.skills/` directory
WHEN user runs `skills init`
THEN operation is idempotent (no errors)
AND existing files are preserved
AND warning is displayed that registry already exists

### R2: Create Skills from Templates

The `skills create <name>` command SHALL create new skills from templates.

#### Scenario: Interactive skill creation
GIVEN user runs `skills create my-skill`
WHEN prompts for title, description, category, tags are answered
THEN `.skills/my-skill/SKILL.md` is created from template
AND `.skills/my-skill/.skill-meta.json` is created with metadata
AND `.registry.json` is updated
AND skills are auto-synced to agent directories

#### Scenario: Template-based creation
GIVEN user runs `skills create my-skill --template=research`
WHEN command executes
THEN skill is created using research template
AND creation completes in < 10 seconds

### R3: List Installed Skills

The `skills list` command SHALL display all installed skills.

#### Scenario: List skills with metadata
GIVEN user has 3 skills installed
WHEN user runs `skills list`
THEN all 3 skills are displayed
AND each shows: name, category, description, agents
AND display completes in < 100ms

#### Scenario: Filter by category
GIVEN user runs `skills list --category=research`
WHEN command executes
THEN only research category skills are shown

### R4: Sync Skills to Agent Directories

The `skills sync` command SHALL copy skills from `.skills/` to agent directories.

#### Scenario: Sync to detected agents
GIVEN user has Cursor and Claude Code installed
AND user has 5 skills in `.skills/`
WHEN user runs `skills sync`
THEN all 5 skills are copied to `.cursor/skills/`
AND all 5 skills are copied to `.claude/skills/`
AND operation completes in < 2 seconds

#### Scenario: Auto-update AGENTS.md
GIVEN user runs `skills sync`
WHEN operation completes
THEN `AGENTS.md` is updated with skill catalog
AND backup is created at `.agents.md.backup`

### R5: Remove Skills

The `skills remove <name>` command SHALL uninstall skills.

#### Scenario: Remove with confirmation
GIVEN user runs `skills remove my-skill`
WHEN confirmation prompt is accepted
THEN `.skills/my-skill/` directory is deleted
AND `.registry.json` is updated
AND agent directories are cleaned up

### R6: Validate Skills

The `skills validate <file>` command SHALL check SKILL.md format.

#### Scenario: Validate valid skill
GIVEN user has valid SKILL.md
WHEN user runs `skills validate .skills/my-skill/SKILL.md`
THEN validation passes
AND exit code is 0

#### Scenario: Validate invalid skill
GIVEN user has SKILL.md with invalid YAML
WHEN user runs `skills validate .skills/my-skill/SKILL.md`
THEN validation fails with helpful error message
AND exit code is 1

### R7: Publish to Vercel Registry

The `skills publish <name>` command SHALL upload skills to Vercel registry.

#### Scenario: Publish with API key
GIVEN user has `VERCEL_SKILLS_API_KEY` set
AND user has valid skill
WHEN user runs `skills publish my-skill`
THEN skill is validated
AND skill is uploaded to Vercel registry
AND published URL is displayed

### R8: Install from Vercel Registry

The `skills add <name>` command SHALL download skills from Vercel registry.

#### Scenario: Install published skill
GIVEN user runs `skills add awesome-skill`
WHEN skill exists in Vercel registry
THEN skill is downloaded to `.skills/awesome-skill/`
AND `.registry.json` is updated
AND skills are auto-synced to agent directories

### R9: Search Vercel Registry

The `skills search <query>` command SHALL query Vercel registry.

#### Scenario: Search for skills
GIVEN user runs `skills search react`
WHEN command executes
THEN matching skills are displayed
AND each shows: name, description, author, install command

### R10: Safe Command Execution

ALL commands that execute external processes SHALL use `spawn` from `child_process`.

#### Scenario: Safe command execution
GIVEN Forge integration calls skills CLI
WHEN `initializeSkills()` runs
THEN `spawn` is used (not `exec` or `execSync`)
AND user input is passed as array arguments (not string interpolation)
AND command injection is prevented

### R11: Cross-Platform Compatibility

ALL commands SHALL work on Unix/Linux/macOS/Windows.

#### Scenario: Windows compatibility
GIVEN user on Windows
WHEN user runs any skills command
THEN command works without errors
AND file paths use correct separators
AND file operations use `fs.cpSync` (not symlinks)

### R12: Forge Integration

Forge setup SHALL detect and initialize skills CLI.

#### Scenario: Detect skills during setup
GIVEN user runs `npx forge setup --tools`
WHEN setup runs
THEN `checkForSkills()` detects installation (3-tier pattern)
AND user is prompted to install if not found
AND user is prompted to initialize `.skills/` registry

---

## Non-Functional Requirements

### Performance
- `skills init`: < 1 second
- `skills list`: < 100ms
- `skills sync`: < 2 seconds (5 skills, 3 agents)
- `skills create --template`: < 10 seconds

### Security
- NO use of `exec` or `execSync` (prevents command injection)
- Path validation prevents directory traversal
- API keys never logged or exposed

### Testability
- 100% test coverage for core commands
- Unit tests for all lib/ modules
- Integration tests for CLI commands
- E2E tests for full workflows

### Maintainability
- Clear separation: commands/ (CLI) vs lib/ (logic)
- Comprehensive JSDoc comments
- Error messages include helpful suggestions
