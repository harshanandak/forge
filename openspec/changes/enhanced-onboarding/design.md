# Design: Enhanced Forge Onboarding Experience

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    bin/forge.js                              │
│                 interactiveSetup()                           │
│                                                              │
│  1. Detect existing CLAUDE.md/AGENTS.md                     │
│  2. IF file exists WITHOUT markers:                         │
│     ├─→ lib/context-merge.js                                │
│     │   ├─ parseSemanticSections()                          │
│     │   ├─ detectCategory()                                 │
│     │   └─ semanticMerge()                                  │
│     └─→ Offer: Merge / Keep / Replace                       │
│  3. IF no file exists OR merge complete:                    │
│     ├─→ lib/project-discovery.js                            │
│     │   ├─ autoDetect()                                     │
│     │   └─ optionalInterview() [--interview flag]          │
│     ├─→ lib/workflow-profiles.js                            │
│     │   ├─ detectStage()                                    │
│     │   └─ selectProfile()                                  │
│     └─→ Generate customized AGENTS.md                       │
│  4. Continue existing setup flow                            │
└─────────────────────────────────────────────────────────────┘

                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  .forge/context.json                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ auto_detected:                                         │ │
│  │   framework, language, stage, confidence               │ │
│  │ user_provided:                                         │ │
│  │   description, current_work                            │ │
│  │ last_updated: timestamp                                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Module Design

### 1. lib/context-merge.js

**Purpose**: Intelligently merge existing context files with Forge workflow

**Exports**:
```javascript
module.exports = {
  parseSemanticSections,  // Parse markdown into categorized sections
  detectCategory,         // Map header text to semantic category
  semanticMerge,          // Perform intelligent merge
  wrapWithMarkers         // Add USER/FORGE markers
};
```

**Core Algorithm**:
```javascript
function semanticMerge(existingContent, forgeContent) {
  // 1. Parse both documents into sections
  const existingSections = parseSemanticSections(existingContent);
  const forgeSections = parseSemanticSections(forgeContent);

  // 2. Categorize each section
  const categorized = {
    preserve: [],  // User-specific (project desc, domain, standards)
    replace: [],   // Workflow-specific (TDD, git, 9-stage)
    merge: []      // Combine both (toolchain, quick start)
  };

  // 3. For each existing section:
  existingSections.forEach(section => {
    const category = detectCategory(section.header);
    const confidence = fuzzyMatch(section.header, knownHeaders);

    if (confidence > 0.8) {
      // High confidence - auto-categorize
      categorized[category].push(section);
    } else {
      // Low confidence - ask user
      const userChoice = promptUser(section, category);
      categorized[userChoice].push(section);
    }
  });

  // 4. Build merged document
  const merged = buildDocument({
    preserve: existingSections.filter(s => shouldPreserve(s)),
    replace: forgeSections.filter(s => shouldReplace(s)),
    merge: combineUnique([...existingSections, ...forgeSections])
  });

  // 5. Wrap with markers for future updates
  return wrapWithMarkers(merged);
}
```

**Section Categories**:
```javascript
const SECTION_CATEGORIES = {
  // PRESERVE - User-specific knowledge
  preserve: [
    'Project Description',
    'Domain Knowledge',
    'Coding Standards',
    'Architecture',
    'Tech Stack',
    'Build Commands',
    'Team Conventions',
    'Project Instructions'
  ],

  // REPLACE - Forge workflow
  replace: [
    'Workflow',
    'TDD',
    'Git Workflow',
    'Development Flow',
    'Commit Conventions'
  ],

  // MERGE - Combine both
  merge: [
    'Quick Start',
    'Toolchain',
    'MCP Servers',
    'Getting Started'
  ]
};
```

**Fuzzy Matching**:
```javascript
function fuzzyMatch(headerText, knownHeaders) {
  // Use Levenshtein distance or similar
  const normalized = headerText.toLowerCase().trim();

  const scores = knownHeaders.map(known => {
    const knownNorm = known.toLowerCase().trim();
    const distance = levenshtein(normalized, knownNorm);
    const maxLen = Math.max(normalized.length, knownNorm.length);
    return 1 - (distance / maxLen);  // 0-1 confidence score
  });

  return Math.max(...scores);
}
```

**Marker Strategy**:
```javascript
function wrapWithMarkers(content) {
  // Only add markers if semantic merge was performed
  // Avoid polluting fresh installs

  return `<!-- FORGE:START -->
${forgeContent}
<!-- FORGE:END -->

<!-- USER:START -->
${userContent}
<!-- USER:END -->`;
}
```

### 2. lib/project-discovery.js

**Purpose**: Auto-detect project context and optionally interview user

**Exports**:
```javascript
module.exports = {
  autoDetect,          // Scan file system for project info
  optionalInterview,   // 3-question interview (if --interview)
  saveContext          // Write to .forge/context.json
};
```

**Auto-Detection Logic**:
```javascript
async function autoDetect(projectPath) {
  const context = {
    framework: null,
    language: null,
    stage: null,
    confidence: 0
  };

  // 1. Framework detection (reuse existing bin/forge.js:728-960)
  const packageJson = await readPackageJson(projectPath);
  context.framework = detectFramework(packageJson);

  // 2. Language detection
  const files = await glob('**/*', { cwd: projectPath, ignore: ['node_modules'] });
  context.language = detectLanguage(files);  // Count .ts, .js, .py, etc.

  // 3. Project type
  const hasBackend = files.some(f => f.includes('server') || f.includes('api'));
  const hasFrontend = files.some(f => f.includes('component') || f.includes('pages'));
  context.type = hasBackend && hasFrontend ? 'fullstack' : hasBackend ? 'backend' : 'frontend';

  // 4. Stage inference
  const gitStats = await getGitStats(projectPath);
  const ciCd = await detectCICD(projectPath);
  const coverage = await getTestCoverage(projectPath);

  context.stage = inferStage(gitStats, ciCd, coverage);
  context.confidence = calculateConfidence(gitStats, ciCd, coverage);

  return context;
}

function inferStage(gitStats, ciCd, coverage) {
  // New: commits < 50, no CI/CD, coverage < 30%
  if (gitStats.commits < 50 && !ciCd.exists && coverage < 30) {
    return 'new';
  }

  // Stable: commits > 500, has CI/CD + releases, coverage > 80%
  if (gitStats.commits > 500 && ciCd.exists && ciCd.hasReleases && coverage > 80) {
    return 'stable';
  }

  // Active: everything in between
  return 'active';
}
```

**Optional Interview**:
```javascript
async function optionalInterview(autoDetectedContext) {
  // Only run if --interview flag is set

  const questions = [
    {
      type: 'text',
      name: 'description',
      message: 'Brief project description (1-2 sentences):',
      initial: `A ${autoDetectedContext.type} application using ${autoDetectedContext.framework}`
    },
    {
      type: 'select',
      name: 'stage',
      message: `Confirm project stage (auto-detected: ${autoDetectedContext.stage}):`,
      choices: [
        { title: 'New (greenfield/early)', value: 'new' },
        { title: 'Active (mid-development)', value: 'active' },
        { title: 'Stable (mature/maintenance)', value: 'stable' }
      ],
      initial: autoDetectedContext.stage === 'new' ? 0 : autoDetectedContext.stage === 'stable' ? 2 : 1
    },
    {
      type: 'text',
      name: 'current_work',
      message: 'What are you currently working on?',
      initial: ''
    }
  ];

  const answers = await prompts(questions);

  return {
    ...autoDetectedContext,
    user_provided: answers
  };
}
```

**Context Storage**:
```javascript
async function saveContext(context, projectPath) {
  const contextPath = path.join(projectPath, '.forge', 'context.json');

  await fs.promises.mkdir(path.dirname(contextPath), { recursive: true });

  const data = {
    auto_detected: {
      framework: context.framework,
      language: context.language,
      stage: context.stage,
      confidence: context.confidence
    },
    user_provided: context.user_provided || {},
    last_updated: new Date().toISOString()
  };

  await fs.promises.writeFile(contextPath, JSON.stringify(data, null, 2));
}
```

### 3. lib/workflow-profiles.js

**Purpose**: Generate stage-appropriate workflow configurations

**Exports**:
```javascript
module.exports = {
  getProfile,      // Get profile for stage
  generateAgentsMd // Generate customized AGENTS.md
};
```

**Profile Definitions**:
```javascript
const PROFILES = {
  new: {
    name: 'New (Greenfield/Early)',
    workflow: 'critical',  // All 9 stages
    tdd: 'strict',         // Enforce RED-GREEN-REFACTOR
    research: 'all',       // Required for all features
    stages: [
      '/status', '/research', '/plan', '/dev',
      '/check', '/ship', '/review', '/merge', '/verify'
    ],
    config: {
      enforce_tdd: true,
      require_research: true,
      require_openspec: 'strategic'  // For strategic changes
    }
  },

  active: {
    name: 'Active (Mid-Development)',
    workflow: 'standard',  // 6 core stages
    tdd: 'balanced',       // Encourage but not enforce
    research: 'critical',  // Only for critical features
    stages: [
      '/status', '/research', '/plan', '/dev', '/check', '/ship'
    ],
    config: {
      enforce_tdd: false,
      require_research: 'critical',
      require_openspec: 'strategic'
    }
  },

  stable: {
    name: 'Stable (Mature/Maintenance)',
    workflow: 'simple',    // 4 essential stages
    tdd: 'relaxed',        // Optional
    research: 'none',      // Skip unless complex
    stages: [
      '/status', '/dev', '/check', '/ship'
    ],
    config: {
      enforce_tdd: false,
      require_research: false,
      require_openspec: 'optional'
    }
  }
};
```

**AGENTS.md Generation**:
```javascript
function generateAgentsMd(profile, projectContext) {
  const template = `# Project Instructions

${projectContext.user_provided?.description || 'This is a project using Forge workflow.'}

**Package manager**: ${projectContext.packageManager || 'npm'}
**Framework**: ${projectContext.framework || 'N/A'}
**Stage**: ${profile.name}

**Build commands**:

\`\`\`bash
${projectContext.buildCommands || generateDefaultBuildCommands(projectContext)}
\`\`\`

---

## Forge Workflow (${profile.workflow})

This project uses the **${profile.workflow} workflow** with ${profile.stages.length} stages:

| Stage | Command | Purpose |
|-------|---------|---------|
${generateStageTable(profile.stages)}

**TDD Enforcement**: ${profile.tdd}
**Research Required**: ${profile.research}

${generateWorkflowDetails(profile)}

---

## Core Principles

${generateCorePrinciples(profile)}

---

<!-- USER:START - Add project-specific learnings here -->

${projectContext.user_provided?.current_work ? `Currently working on: ${projectContext.user_provided.current_work}` : ''}

<!-- USER:END -->
`;

  return template;
}
```

### 4. docs/AGENT_INSTALL_PROMPT.md

**Purpose**: Copy-paste prompt for AI agents to run installation

**Structure**:
```markdown
# Forge Installation Prompt for AI Agents

You are assisting a user with installing Forge, a TDD-first workflow tool.

## Instructions

1. **Detect your agent type**
   - Check for `.claude/` → Claude Code
   - Check for `.cursor/` → Cursor
   - Check for `.continue/` → Continue
   - Other → Generic

2. **Gather project context**
   - Read package.json/requirements.txt
   - Scan for framework indicators
   - Check git history length
   - Detect CI/CD presence
   - Ask user: "What are you building?" and "What stage is the project?"

3. **Run installation**
   ```bash
   npx forge setup --agents <detected-type>
   ```

4. **Customize output**
   - Add discovered context to generated AGENTS.md
   - Update USER:START section with project-specific info

5. **Report results**
   - Show what was created
   - Suggest next steps (`/status`, `/research`, etc.)

## Safety Guardrails

- Only run commands after explaining what they do
- Never modify existing files without user permission
- Back up any existing CLAUDE.md/AGENTS.md before changes
- Show diffs before applying merge

## Verification Steps

After installation:
1. Confirm AGENTS.md exists and has Forge workflow
2. Confirm .forge/context.json exists with project info
3. Run `/status` to verify Forge is working
```

## Integration Points

### bin/forge.js Modifications

**Current**: Line 558-709 `smartMergeAgentsMd()` returns `null` for unmarked files
**Change**: Call semantic merge instead

```javascript
// BEFORE
function smartMergeAgentsMd(existing, forge) {
  // Check for markers
  if (!existing.includes('<!-- USER:START -->')) {
    return null;  // Can't merge
  }
  // ... existing merge logic
}

// AFTER
function smartMergeAgentsMd(existing, forge) {
  // Check for markers
  if (existing.includes('<!-- USER:START -->')) {
    // Use existing marker-based merge
    return markerBasedMerge(existing, forge);
  }

  // New: Use semantic merge for unmarked files
  const { semanticMerge } = require('../lib/context-merge');
  return semanticMerge(existing, forge);
}
```

**Current**: Line 2153 `interactiveSetup()` main flow
**Change**: Add context gathering step

```javascript
// AFTER framework detection, BEFORE file writing
async function interactiveSetup() {
  // ... existing code ...

  // NEW: Project context gathering
  const { autoDetect, optionalInterview } = require('../lib/project-discovery');
  let projectContext = await autoDetect(process.cwd());

  if (program.interview) {
    projectContext = await optionalInterview(projectContext);
  }

  // NEW: Workflow profile selection
  const { getProfile, generateAgentsMd } = require('../lib/workflow-profiles');
  const stage = program.stage || projectContext.stage;
  const profile = getProfile(stage);

  // Use profile to customize generated files
  const agentsMdContent = generateAgentsMd(profile, projectContext);

  // ... continue with file writing ...
}
```

## CLI Flag Design

**New flags**:
```bash
--interview          # Force context interview (optional by default)
--merge=<strategy>   # Control merge: smart|preserve|replace
--stage=<stage>      # Override auto-detected stage: new|active|stable
--agents=<type>      # Specify agent type: claude-code|cursor|cline|generic
```

**Usage examples**:
```bash
# Default (auto-detect everything)
npx forge setup

# Force interview
npx forge setup --interview

# Override stage detection
npx forge setup --stage=stable

# Merge strategy
npx forge setup --merge=preserve

# Agent-assisted installation
npx forge setup --agents=claude-code
```

## Data Structures

### .forge/context.json
```json
{
  "auto_detected": {
    "framework": "Next.js",
    "language": "typescript",
    "type": "fullstack",
    "stage": "active",
    "confidence": 0.85,
    "package_manager": "npm",
    "git_commits": 234,
    "has_cicd": true,
    "test_coverage": 67.3
  },
  "user_provided": {
    "description": "E-commerce platform with multi-tenant support",
    "current_work": "Adding Stripe payment integration",
    "stage_override": null
  },
  "workflow": {
    "profile": "active",
    "stages": 6,
    "tdd_enforcement": "balanced",
    "research_required": "critical"
  },
  "last_updated": "2026-02-05T17:30:00.000Z",
  "forge_version": "1.5.0"
}
```

## Error Handling

### Semantic Merge Failures
```javascript
try {
  const merged = semanticMerge(existing, forge);
  return merged;
} catch (error) {
  console.error('Semantic merge failed:', error.message);

  // Fallback: Ask user
  const choice = await prompts({
    type: 'select',
    name: 'fallback',
    message: 'Merge failed. Choose fallback strategy:',
    choices: [
      { title: 'Keep existing file (no Forge workflow)', value: 'keep' },
      { title: 'Replace with Forge template', value: 'replace' },
      { title: 'Manual merge (show diff)', value: 'manual' }
    ]
  });

  switch (choice.fallback) {
    case 'keep': return existing;
    case 'replace': return forge;
    case 'manual': return manualMerge(existing, forge);
  }
}
```

### Interview Interruption
```javascript
// Save partial answers
const CONTEXT_TEMP = '.forge/.context-temp.json';

process.on('SIGINT', async () => {
  if (interviewInProgress) {
    await savePartialContext(CONTEXT_TEMP, partialAnswers);
    console.log('\nInterview interrupted. Run `npx forge setup --interview` to resume.');
  }
  process.exit(0);
});

// Resume logic
if (fs.existsSync(CONTEXT_TEMP)) {
  const resume = await prompts({
    type: 'confirm',
    name: 'resume',
    message: 'Found incomplete setup. Resume?'
  });

  if (resume) {
    partialAnswers = JSON.parse(fs.readFileSync(CONTEXT_TEMP));
  }
}
```

## Testing Strategy

### Unit Tests
```javascript
// test/context-merge.test.js
describe('semanticMerge', () => {
  it('preserves user project description', () => {
    const existing = '# Project\n\nThis is my e-commerce platform.';
    const forge = '# Project\n\n## Forge Workflow\n...';
    const merged = semanticMerge(existing, forge);

    expect(merged).toContain('e-commerce platform');
    expect(merged).toContain('Forge Workflow');
  });

  it('replaces workflow sections with Forge', () => {
    const existing = '## Workflow\n\nWe use custom workflow.';
    const forge = '## Forge Workflow\n\nUse 9-stage TDD.';
    const merged = semanticMerge(existing, forge);

    expect(merged).not.toContain('custom workflow');
    expect(merged).toContain('9-stage TDD');
  });
});

// test/project-discovery.test.js
describe('autoDetect', () => {
  it('detects Next.js framework', async () => {
    const context = await autoDetect('./fixtures/nextjs-project');
    expect(context.framework).toBe('Next.js');
  });

  it('infers active stage from git history', async () => {
    const context = await autoDetect('./fixtures/mid-stage-project');
    expect(context.stage).toBe('active');
  });
});
```

### Integration Tests
```javascript
// test/setup-flow.test.js
describe('Enhanced setup flow', () => {
  it('merges existing CLAUDE.md without data loss', async () => {
    // Setup: Create project with existing CLAUDE.md
    const original = fs.readFileSync('./fixtures/existing-claude.md', 'utf8');

    // Act: Run setup
    await runCommand('npx forge setup --merge=smart');

    // Assert: Original content preserved
    const merged = fs.readFileSync('./CLAUDE.md', 'utf8');
    expect(merged).toContain(extractUserContent(original));
    expect(merged).toContain('Forge Workflow');
  });
});
```

## Open Design Questions

1. **Confidence threshold**: Is 80% the right threshold for auto-merge vs ask-user?
   - Consider: Lower threshold (70%) = more auto-merges, higher risk
   - Higher threshold (90%) = more user prompts, safer but slower

2. **Marker placement**: Should markers wrap entire document or just merged sections?
   - Option A: Wrap entire document (simpler, but larger blocks)
   - Option B: Wrap individual sections (granular, but more complex)

3. **Profile customization**: Should users be able to customize individual stages within a profile?
   - Phase 1: Profiles only (simpler)
   - Phase 2: Per-stage customization (more flexible)

4. **Agent prompt distribution**: Where should AGENT_INSTALL_PROMPT.md live?
   - Option A: In docs/ (checked into repo)
   - Option B: On Forge website (always latest)
   - Option C: Both (repo + remote fetch)
