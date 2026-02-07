# Technical Design

Key technical decisions and rationale for the Skills CLI implementation.

## 1. Architecture: Canonical Source + Synced Copies

**Decision**: `.skills/` is the canonical source, synced to agent directories.

**Rationale:**
- Single source of truth (users edit in one place)
- Per-agent isolation (each agent has its own copy)
- Backwards compatible (agents already support .claude/skills/, .cursor/skills/)

**Structure:**
```
.skills/                      # Canonical source (CLI manages this)
├── .registry.json            # Local skill catalog
├── .config.json              # CLI configuration
└── my-skill/
    ├── SKILL.md              # Content
    └── .skill-meta.json      # Metadata

.cursor/skills/               # Synced copy (Cursor reads this)
└── my-skill/
    ├── SKILL.md
    └── .skill-meta.json

.github/skills/               # Synced copy (GitHub Agent reads this)
└── my-skill/
    ├── SKILL.md
    └── .skill-meta.json
```

**Alternative rejected**: Symlinks from agent dirs → .skills/
- Windows compatibility issues
- Some agents may not follow symlinks
- Copy-based is simpler and universal

## 2. Format: SKILL.md with YAML Frontmatter

**Decision**: Use SKILL.md with YAML frontmatter (universal standard).

**Rationale:**
- 100% compatibility across 20+ agents (Claude Code, Cursor, Cline, Continue, etc.)
- Proven by Vercel's parallel-ai research
- Human-readable and git-friendly

**Format:**
```markdown
---
title: Skill Title
description: Short description
category: research|coding|review|testing|deployment
version: 1.0.0
author: Your Name
created: 2026-02-07
updated: 2026-02-07
tags:
  - tag1
  - tag2
---

# Skill Name

## Purpose
...
```

**Note**: No `modelPreferences` field - skills are model-agnostic (work with whatever model the user is currently using).

## 3. Registry: Vercel's skills.sh

**Decision**: Use Vercel's existing skills.sh registry (not custom registry).

**Rationale:**
- Existing infrastructure (no maintenance burden)
- Existing user base (network effects)
- Proven API (already working)
- Competitive parity with Vercel

**API:**
```javascript
const VERCEL_REGISTRY_API = 'https://skills.sh/api';

// GET  /skills              - List all
// GET  /skills/:name        - Get details
// POST /skills              - Publish
// GET  /skills/:name/download - Download
```

**Authentication:**
- Environment variable: `VERCEL_SKILLS_API_KEY`
- Config file: `.skills/.config.json` (git-ignored)

**Fallback**: If Vercel registry is unavailable, CLI works in local-only mode.

## 4. Sync Mechanism: Copy-based with fs.cpSync

**Decision**: Use `fs.cpSync` to copy from `.skills/` to agent directories.

**Rationale:**
- Cross-platform (works on Windows)
- Simple and predictable
- Atomic operations (copy is all-or-nothing)

**Implementation:**
```javascript
function syncSkillsToAgents() {
  const skillsDir = path.join(process.cwd(), '.skills');
  const agents = detectAgents().filter(a => a.enabled);

  for (const agent of agents) {
    for (const skill of skills) {
      const source = path.join(skillsDir, skill);
      const target = path.join(agent.path, skill);

      // Copy entire directory (SKILL.md + .skill-meta.json)
      fs.cpSync(source, target, { recursive: true, force: true });
    }
  }
}
```

**Alternative rejected**: Symlinks
- `fs.symlinkSync` doesn't work reliably on Windows
- Requires elevated permissions on Windows
- Some agents may not follow symlinks

## 5. Agent Detection: Directory-based

**Decision**: Detect agents by checking for specific directories.

**Rationale:**
- Simple and reliable
- No dependency on agent-specific APIs
- Future-proof (new agents just need directory convention)

**Detection logic:**
```javascript
function detectAgents() {
  const agents = [];

  if (fs.existsSync('.cursor')) {
    agents.push({ name: 'cursor', path: '.cursor/skills', enabled: true });
  }

  if (fs.existsSync('.github')) {
    agents.push({ name: 'github', path: '.github/skills', enabled: true });
  }

  // Future: .cline, .continue, etc.

  return agents;
}
```

**Configuration**: Users can enable/disable agents in `.skills/.config.json`.

## 6. Security: Safe Command Execution

**Decision**: Always use `spawn` or `spawnSync` from `child_process`, NEVER `exec` or `execSync`.

**Rationale:**
- Prevents command injection attacks
- Safer argument passing (array of args, not string interpolation)
- Follows Forge security standards

**Safe approach:**
```javascript
const { spawn } = require('child_process');

// ✅ SAFE - uses argument array
function runSkillsCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('skills', args, {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

// Usage
await runSkillsCommand(['init']);  // Safe - no injection possible
```

**What NOT to do:**
```javascript
const { exec } = require('child_process');

// ❌ UNSAFE - vulnerable to command injection
exec(`skills ${userInput}`, ...); // NEVER DO THIS
```

**Path validation:**
```javascript
function validateSkillPath(skillPath) {
  const resolved = path.resolve(process.cwd(), '.skills', skillPath);
  const baseDir = path.resolve(process.cwd(), '.skills');

  if (!resolved.startsWith(baseDir)) {
    throw new Error('Invalid skill path: directory traversal detected');
  }

  return resolved;
}
```

## 7. CLI Framework: Commander.js

**Decision**: Use Commander.js for CLI argument parsing.

**Rationale:**
- Industry standard (used by npm, yarn, Vue CLI, etc.)
- Excellent subcommand support
- Auto-generated help text
- Familiar to developers

**Example:**
```javascript
const { Command } = require('commander');
const program = new Command();

program
  .name('skills')
  .description('Universal tool for managing SKILL.md files')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize skills registry')
  .action(initCommand);

program
  .command('create <name>')
  .description('Create new skill from template')
  .option('-t, --template <type>', 'Template type (research, coding, etc.)')
  .action(createCommand);

program.parse();
```

## 8. Testing: Bun Test

**Decision**: Use Bun's built-in test runner (not Jest/Mocha).

**Rationale:**
- Already used in Forge (consistency)
- Fast (native speed)
- Good TypeScript support
- Built-in assertions

**Structure:**
```
test/
├── commands.test.js      # CLI command tests
├── registry.test.js      # Registry management tests
├── sync.test.js          # Sync logic tests
├── validator.test.js     # Validation tests
└── fixtures/             # Test data
    ├── valid-skill/
    └── invalid-skill/
```

## 9. Phased Execution: Template-First, AI-Second

**Decision**: v1.0 is template-based, v1.1 adds AI-powered creation.

**Rationale:**
- Vercel's skills.sh succeeded with ZERO AI (just file management)
- Template-based is fast and predictable (30-60s)
- AI-powered is optional premium feature (15-30s, better quality)
- Users tolerate 15-30s wait IF the result is high-quality

**v1.0 (Template-Based):**
```bash
skills create my-skill
# Prompts: title, description, category, tags
# Output: SKILL.md from template (30-60s)
```

**v1.1 (AI-Powered):**
```bash
skills create --ai "React best practices with 40+ rules"
# Manager agent orchestrates
# Writer sub-agent generates comprehensive SKILL.md
# Validator sub-agent checks quality
# Output: Production-ready skill (15-30s)
```

**When to use AI:**
- Complex skills (40+ rules)
- First-time creators (need guidance)
- Domain expertise distillation

**When NOT to use AI:**
- Simple workflows
- Speed is priority
- Offline/no API access

## 10. AGENTS.md Integration: Auto-update with --preserve Flag

**Decision**: `skills sync` auto-updates AGENTS.md, with opt-out flag.

**Rationale:**
- Vercel research: **100% pass rate with AGENTS.md** vs 53% without
- Convenience (users don't manually update)
- Safety (`--preserve-agents` skips update)
- Backup (.agents.md.backup created before overwrite)

**Implementation:**
```javascript
function updateAgentsMdFromSkills() {
  const registry = JSON.parse(fs.readFileSync('.skills/.registry.json', 'utf8'));
  const skills = Object.values(registry.skills);

  // Create backup
  if (fs.existsSync('AGENTS.md')) {
    fs.copyFileSync('AGENTS.md', '.agents.md.backup');
  }

  // Generate new AGENTS.md
  const content = `# Agent Instructions

## Available Skills

${skills.map(skill => `### ${skill.title}
**Command**: \`/skill ${skill.name}\`
${skill.description}
`).join('\n')}
`;

  fs.writeFileSync('AGENTS.md', content, 'utf8');
}
```

**Usage:**
```bash
skills sync                   # Updates AGENTS.md
skills sync --preserve-agents # Skips AGENTS.md update
```

## 11. Forge Integration: 3-Tier Installation Pattern

**Decision**: Mirror Beads/OpenSpec's 3-tier installation pattern.

**Rationale:**
- Consistency with existing Forge toolchain
- Proven pattern (Beads and OpenSpec use it)
- Flexible (global, local, or bunx)

**Detection:**
```javascript
async function checkForSkills() {
  // 1. Check local node_modules/.bin/skills
  const localSkills = path.join(process.cwd(), 'node_modules', '.bin', 'skills');
  if (fs.existsSync(localSkills)) {
    return { found: true, command: localSkills };
  }

  // 2. Check global install
  const globalSkills = await findInPath('skills');
  if (globalSkills) {
    return { found: true, command: 'skills' };
  }

  // 3. Fallback to bunx
  return { found: false, command: 'bunx skills' };
}
```

**Initialization (using spawn for safety):**
```javascript
const { spawn } = require('child_process');

async function initializeSkills() {
  const skillsCheck = await checkForSkills();

  if (!skillsCheck.found) {
    console.log('Skills CLI not found. Install with: npm install -g @forge/skills');
    return;
  }

  // Use spawn (safe - prevents command injection)
  return new Promise((resolve, reject) => {
    const child = spawn(skillsCheck.command, ['init'], {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('✓ Skills registry initialized');
        resolve();
      } else {
        console.error('Failed to initialize skills');
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on('error', (error) => {
      console.error('Failed to initialize skills:', error.message);
      reject(error);
    });
  });
}
```

## 12. Dependencies

**Core:**
- `commander` - CLI framework
- `yaml` - YAML parsing/serialization
- `fs-extra` - Enhanced file operations
- `chalk` - Terminal colors
- `inquirer` - Interactive prompts

**Validation:**
- `js-yaml` - YAML validation
- `markdown-it` - Markdown parsing
- `ajv` - JSON schema validation

**Testing:**
- `bun:test` - Built-in test runner
- `mock-fs` - Filesystem mocking

**AI (v1.1):**
- `@anthropic-ai/sdk` - Claude API client
- TBD: Agent orchestration library

## 13. Error Handling Strategy

**Principle**: Fail gracefully with helpful error messages.

**Categories:**
1. **User errors** (invalid input): Helpful message, exit 1
2. **Network errors** (API failures): Retry 3x, then fail with fallback suggestion
3. **File system errors** (permission denied): Detailed error, suggest fix
4. **Validation errors** (invalid SKILL.md): Show errors, suggest corrections

**Example:**
```javascript
try {
  const skill = await loadSkill(skillName);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(`Skill not found: ${skillName}`);
    console.error(`Run 'skills list' to see available skills.`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    console.error(`Permission denied: ${error.path}`);
    console.error(`Try running with sudo or check file permissions.`);
    process.exit(1);
  } else {
    throw error; // Unexpected error
  }
}
```

## 14. Performance Targets

**v1.0 (Template-Based):**
- `skills init`: < 1 second
- `skills create`: 30-60 seconds (interactive prompts)
- `skills create --template`: < 10 seconds (skip prompts)
- `skills list`: < 100ms
- `skills sync`: < 2 seconds (5 skills, 3 agents)
- `skills remove`: < 500ms
- `skills validate`: < 500ms

**v1.1 (AI-Powered):**
- `skills create --ai`: 15-30 seconds (AI generation)
- `skills refine --ai`: 20-40 seconds (AI refinement)

**Optimization strategies:**
- Cache agent detection results
- Parallel sync (copy to multiple agents concurrently)
- Lazy-load heavy dependencies (yaml parser, markdown validator)

## 15. Versioning & Releases

**Semantic versioning:**
- `1.0.0` - Initial release (template-based CLI)
- `1.1.0` - AI-powered creation
- `1.x.x` - Bug fixes, minor features
- `2.0.0` - Breaking changes (if needed)

**Release process:**
1. Run full test suite (100% pass)
2. Test on all platforms (Unix/Linux/macOS/Windows)
3. Update CHANGELOG.md
4. Tag release: `git tag v1.0.0`
5. Publish to npm: `npm publish @forge/skills`
6. Announce: Documentation site, Discord, Twitter

**Deprecation policy:**
- Deprecate features in minor version
- Remove in next major version
- Provide migration guide
