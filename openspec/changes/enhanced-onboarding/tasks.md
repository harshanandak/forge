# Implementation Tasks: Enhanced Forge Onboarding

## Overview

Implementation follows **TDD-first** approach: Write tests before implementation, commit after each GREEN cycle.

**Estimated duration**: 11 days
**Parallel opportunities**: Phases 1-3 can be developed independently after specs are defined

---

## Phase 1: Semantic Merge Algorithm (3 days)

### Task 1.1: Test Fixtures & Unit Tests (RED)
**Duration**: 4 hours
**Files**:
- `test/context-merge.test.js` (create)
- `test/fixtures/existing-claude-*.md` (create 5 test cases)

**Test cases**:
1. Simple project description preservation
2. Workflow section replacement
3. Merge section combination (toolchain)
4. Fuzzy header matching (70-90% confidence)
5. Edge case: conflicting sections (ask user)

**Acceptance**:
- [ ] Tests run but fail (no implementation yet)
- [ ] 5 real-world CLAUDE.md fixtures created
- [ ] Test coverage targets: 90%+ for merge logic

```bash
npm test -- test/context-merge.test.js
# Expected: All tests FAIL (RED)
```

### Task 1.2: Semantic Section Parser (GREEN)
**Duration**: 6 hours
**Files**:
- `lib/context-merge.js` (create)

**Implementation**:
```javascript
function parseSemanticSections(markdownContent) {
  // Parse markdown into structured sections
  // Return: [{ level, header, content, category }]
}

function detectCategory(headerText) {
  // Map header to: preserve|replace|merge
  // Use fuzzy matching with confidence score
}
```

**Acceptance**:
- [ ] `parseSemanticSections()` extracts headers and content
- [ ] `detectCategory()` returns correct category + confidence
- [ ] Tests for Task 1.1 now PASS (GREEN)

```bash
npm test -- test/context-merge.test.js
# Expected: All tests PASS (GREEN)
```

### Task 1.3: Semantic Merge Logic (GREEN)
**Duration**: 8 hours
**Files**:
- `lib/context-merge.js` (modify)

**Implementation**:
```javascript
function semanticMerge(existingContent, forgeContent, options = {}) {
  const existing = parseSemanticSections(existingContent);
  const forge = parseSemanticSections(forgeContent);

  // Categorize and merge
  const merged = buildMergedDocument(existing, forge, options);

  // Add markers only if merge performed
  if (options.addMarkers) {
    return wrapWithMarkers(merged);
  }

  return merged;
}
```

**Acceptance**:
- [ ] `semanticMerge()` preserves user content
- [ ] `semanticMerge()` replaces workflow sections
- [ ] `semanticMerge()` combines merge sections
- [ ] Markers added only when requested
- [ ] All tests PASS with 90%+ coverage

```bash
npm test -- test/context-merge.test.js
npm run coverage -- test/context-merge.test.js
# Expected: All tests PASS, coverage >90%
```

### Task 1.4: Integration with bin/forge.js (REFACTOR)
**Duration**: 4 hours
**Files**:
- `bin/forge.js` (modify line 558-709)
- `test/setup-merge-integration.test.js` (create)

**Changes**:
```javascript
// bin/forge.js smartMergeAgentsMd()
function smartMergeAgentsMd(existing, forge) {
  // Check for markers first (backward compatibility)
  if (existing.includes('<!-- USER:START -->')) {
    return markerBasedMerge(existing, forge);
  }

  // NEW: Use semantic merge for unmarked files
  const { semanticMerge } = require('../lib/context-merge');
  return semanticMerge(existing, forge, { addMarkers: true });
}
```

**Acceptance**:
- [ ] Existing marker-based merge still works (backward compatible)
- [ ] New semantic merge triggered for unmarked files
- [ ] Integration test: full setup flow with existing CLAUDE.md
- [ ] No breaking changes to current behavior

```bash
npm test -- test/setup-merge-integration.test.js
# Expected: Integration tests PASS
```

### Task 1.5: Commit Phase 1
```bash
git add lib/context-merge.js test/context-merge.test.js test/fixtures/
git commit -m "feat: semantic merge algorithm for context files

- Parse markdown into semantic sections
- Fuzzy match headers with confidence scores
- Preserve user content, replace workflow sections
- Add markers only when merge performed

Tests: 90%+ coverage, 5 real-world fixtures
Closes: forge-xyz (Beads issue)"

git push -u origin feat/enhanced-onboarding
```

---

## Phase 2: Auto-Discovery + Optional Interview (2 days)

### Task 2.1: Auto-Detection Tests (RED)
**Duration**: 3 hours
**Files**:
- `test/project-discovery.test.js` (create)
- `test/fixtures/nextjs-project/` (create)
- `test/fixtures/legacy-project/` (create)

**Test cases**:
1. Detect Next.js framework
2. Detect TypeScript language
3. Infer "active" stage from git history
4. Detect CI/CD presence
5. Calculate confidence score

**Acceptance**:
- [ ] Tests run but fail (no implementation yet)
- [ ] 3 fixture projects created (new/active/stable)

```bash
npm test -- test/project-discovery.test.js
# Expected: All tests FAIL (RED)
```

### Task 2.2: Auto-Detection Implementation (GREEN)
**Duration**: 6 hours
**Files**:
- `lib/project-discovery.js` (create)

**Implementation**:
```javascript
async function autoDetect(projectPath) {
  const framework = await detectFramework(projectPath);
  const language = await detectLanguage(projectPath);
  const stage = await inferStage(projectPath);
  const confidence = calculateConfidence({ framework, stage });

  return { framework, language, stage, confidence };
}

async function inferStage(projectPath) {
  const gitStats = await getGitStats(projectPath);
  const cicd = await detectCICD(projectPath);
  const coverage = await getTestCoverage(projectPath);

  // New: commits < 50, no CI/CD
  // Active: commits 50-500, has CI/CD
  // Stable: commits > 500, has CI/CD + releases
}
```

**Acceptance**:
- [ ] `autoDetect()` returns framework, language, stage
- [ ] `inferStage()` correctly classifies new/active/stable
- [ ] All tests PASS

```bash
npm test -- test/project-discovery.test.js
# Expected: All tests PASS (GREEN)
```

### Task 2.3: Optional Interview (GREEN)
**Duration**: 4 hours
**Files**:
- `lib/project-discovery.js` (modify)
- `test/project-discovery.test.js` (modify)

**Implementation**:
```javascript
async function optionalInterview(autoDetectedContext) {
  // Only run if --interview flag
  const questions = [
    { name: 'description', message: 'Project description:' },
    { name: 'stage', message: 'Confirm stage:', choices: ['new', 'active', 'stable'] },
    { name: 'current_work', message: 'Current work:' }
  ];

  const answers = await prompts(questions);

  return {
    ...autoDetectedContext,
    user_provided: answers
  };
}
```

**Acceptance**:
- [ ] Interview runs only with `--interview` flag
- [ ] 3 questions asked
- [ ] Answers merged with auto-detected context
- [ ] Tests PASS

### Task 2.4: Context Storage (.forge/context.json) (GREEN)
**Duration**: 3 hours
**Files**:
- `lib/project-discovery.js` (modify)
- `test/context-storage.test.js` (create)

**Implementation**:
```javascript
async function saveContext(context, projectPath) {
  const contextPath = path.join(projectPath, '.forge', 'context.json');

  await fs.promises.mkdir(path.dirname(contextPath), { recursive: true });

  const data = {
    auto_detected: context.auto_detected,
    user_provided: context.user_provided || {},
    last_updated: new Date().toISOString()
  };

  await fs.promises.writeFile(contextPath, JSON.stringify(data, null, 2));
}
```

**Acceptance**:
- [ ] `.forge/context.json` created with correct structure
- [ ] Auto-detected and user-provided data separate
- [ ] Timestamp included
- [ ] Tests PASS

### Task 2.5: Commit Phase 2
```bash
git add lib/project-discovery.js test/project-discovery.test.js
git commit -m "feat: auto-discovery and optional interview

- Auto-detect framework, language, stage from file system
- Infer stage from git history, CI/CD, test coverage
- Optional 3-question interview with --interview flag
- Store context in .forge/context.json

Tests: 90%+ coverage, 3 fixture projects"

git push
```

---

## Phase 3: Workflow Profiles (2 days)

### Task 3.1: Profile Definition Tests (RED)
**Duration**: 3 hours
**Files**:
- `test/workflow-profiles.test.js` (create)

**Test cases**:
1. Get "new" profile for greenfield project
2. Get "active" profile for mid-stage project
3. Get "stable" profile for mature project
4. Generate AGENTS.md from profile + context
5. Validate profile structure

**Acceptance**:
- [ ] Tests run but fail (no implementation yet)

```bash
npm test -- test/workflow-profiles.test.js
# Expected: All tests FAIL (RED)
```

### Task 3.2: Profile Implementation (GREEN)
**Duration**: 6 hours
**Files**:
- `lib/workflow-profiles.js` (create)

**Implementation**:
```javascript
const PROFILES = {
  new: {
    name: 'New (Greenfield/Early)',
    workflow: 'critical',
    stages: ['/status', '/research', '/plan', '/dev', '/check', '/ship', '/review', '/merge', '/verify'],
    tdd: 'strict',
    research: 'all'
  },
  active: {
    name: 'Active (Mid-Development)',
    workflow: 'standard',
    stages: ['/status', '/research', '/plan', '/dev', '/check', '/ship'],
    tdd: 'balanced',
    research: 'critical'
  },
  stable: {
    name: 'Stable (Mature/Maintenance)',
    workflow: 'simple',
    stages: ['/status', '/dev', '/check', '/ship'],
    tdd: 'relaxed',
    research: 'none'
  }
};

function getProfile(stage) {
  return PROFILES[stage] || PROFILES.active;
}
```

**Acceptance**:
- [ ] `getProfile()` returns correct profile for stage
- [ ] All 3 profiles defined
- [ ] Tests PASS

### Task 3.3: AGENTS.md Generation (GREEN)
**Duration**: 6 hours
**Files**:
- `lib/workflow-profiles.js` (modify)
- `test/agents-md-generation.test.js` (create)

**Implementation**:
```javascript
function generateAgentsMd(profile, projectContext) {
  const template = `# Project Instructions

${projectContext.user_provided?.description || 'This is a project using Forge workflow.'}

**Framework**: ${projectContext.framework || 'N/A'}
**Stage**: ${profile.name}

## Forge Workflow (${profile.workflow})

This project uses the **${profile.workflow} workflow** with ${profile.stages.length} stages:

${generateStageTable(profile.stages)}

**TDD Enforcement**: ${profile.tdd}
**Research Required**: ${profile.research}

<!-- USER:START -->
<!-- USER:END -->
`;

  return template;
}
```

**Acceptance**:
- [ ] `generateAgentsMd()` produces valid markdown
- [ ] Profile-specific stages included
- [ ] Project context interpolated
- [ ] USER markers included
- [ ] Tests PASS

### Task 3.4: Commit Phase 3
```bash
git add lib/workflow-profiles.js test/workflow-profiles.test.js
git commit -m "feat: workflow profiles based on project stage

- Define 3 profiles: new/active/stable
- Auto-select profile from detected stage
- Generate customized AGENTS.md from profile
- Include stage-specific workflow stages

Tests: 90%+ coverage"

git push
```

---

## Phase 4: Agent Installation Prompt (1 day)

### Task 4.1: Create Agent Prompt Document
**Duration**: 4 hours
**Files**:
- `docs/AGENT_INSTALL_PROMPT.md` (create)

**Content**:
- Step-by-step instructions for AI agents
- Agent type detection (Claude Code, Cursor, Cline)
- Context gathering steps
- Installation command execution
- Verification steps
- Safety guardrails

**Acceptance**:
- [ ] Document is self-contained (copy-paste ready)
- [ ] All agent types covered
- [ ] Safety guardrails included
- [ ] Verification steps clear

### Task 4.2: Manual Test with Real Agents
**Duration**: 4 hours
**Tools**: Claude Code, Cursor (if available)

**Test steps**:
1. Create fresh test project
2. Copy AGENT_INSTALL_PROMPT.md into agent chat
3. Verify agent follows all steps
4. Check generated files
5. Run `/status` to verify Forge works

**Acceptance**:
- [ ] Claude Code successfully completes installation
- [ ] Generated AGENTS.md has correct content
- [ ] `.forge/context.json` created
- [ ] No errors during setup

### Task 4.3: Commit Phase 4
```bash
git add docs/AGENT_INSTALL_PROMPT.md
git commit -m "docs: AI agent installation prompt

- Copy-paste prompt for AI agents (Claude Code, Cursor, Cline)
- Auto-detect agent type
- Gather project context before installation
- Include verification steps and safety guardrails

Tested with: Claude Code"

git push
```

---

## Phase 5: Integration into Setup Flow (2 days)

### Task 5.1: Integration Tests (RED)
**Duration**: 4 hours
**Files**:
- `test/setup-flow-integration.test.js` (create)

**Test scenarios**:
1. New project (no existing files) → full setup with interview
2. Existing project (unmarked CLAUDE.md) → semantic merge
3. Existing project (marked CLAUDE.md) → marker-based merge
4. Setup with `--stage` override
5. Setup with `--interview` flag
6. Setup with `--merge=preserve` flag

**Acceptance**:
- [ ] Tests run but fail (integration not done yet)
- [ ] All edge cases covered

```bash
npm test -- test/setup-flow-integration.test.js
# Expected: All tests FAIL (RED)
```

### Task 5.2: Modify interactiveSetup() (GREEN)
**Duration**: 8 hours
**Files**:
- `bin/forge.js` (modify line 2153+)

**Changes**:
```javascript
async function interactiveSetup() {
  // ... existing framework detection ...

  // NEW: Auto-detect project context
  const { autoDetect, optionalInterview, saveContext } = require('../lib/project-discovery');
  let projectContext = await autoDetect(process.cwd());

  // NEW: Optional interview if --interview flag
  if (program.interview) {
    projectContext = await optionalInterview(projectContext);
  }

  // NEW: Save context to .forge/context.json
  await saveContext(projectContext, process.cwd());

  // NEW: Get workflow profile
  const { getProfile, generateAgentsMd } = require('../lib/workflow-profiles');
  const stage = program.stage || projectContext.stage;
  const profile = getProfile(stage);

  // NEW: Generate customized AGENTS.md
  const agentsMdContent = generateAgentsMd(profile, projectContext);

  // ... continue with file writing (use agentsMdContent) ...
}
```

**Acceptance**:
- [ ] Auto-detect runs before file generation
- [ ] Interview runs only with `--interview` flag
- [ ] Context saved to `.forge/context.json`
- [ ] Profile selected based on stage
- [ ] Generated AGENTS.md uses profile template
- [ ] All integration tests PASS

### Task 5.3: Add CLI Flags (GREEN)
**Duration**: 2 hours
**Files**:
- `bin/forge.js` (modify CLI parser section)

**New flags**:
```javascript
program
  .option('--interview', 'Force context interview')
  .option('--merge <strategy>', 'Merge strategy: smart|preserve|replace', 'smart')
  .option('--stage <stage>', 'Override stage: new|active|stable')
  .option('--agents <type>', 'Agent type: claude-code|cursor|cline|generic');
```

**Acceptance**:
- [ ] All flags recognized
- [ ] Default values work
- [ ] Flag values passed to setup functions
- [ ] Tests PASS

### Task 5.4: Commit Phase 5
```bash
git add bin/forge.js test/setup-flow-integration.test.js
git commit -m "feat: integrate enhanced onboarding into setup flow

- Auto-detect project context before file generation
- Optional interview with --interview flag
- Workflow profile selection based on stage
- Generate customized AGENTS.md from profile + context
- New CLI flags: --interview, --merge, --stage, --agents

All integration tests PASS
Backward compatible with existing setup flow"

git push
```

---

## Phase 6: Documentation & Polish (1 day)

### Task 6.1: Update README.md
**Duration**: 2 hours
**Files**:
- `README.md` (modify)

**Changes**:
- Add "Enhanced Onboarding" section
- Document new CLI flags
- Show workflow profiles
- Link to AGENT_INSTALL_PROMPT.md

**Acceptance**:
- [ ] README has new features documented
- [ ] Examples included
- [ ] Links work

### Task 6.2: Update WORKFLOW.md
**Duration**: 2 hours
**Files**:
- `docs/WORKFLOW.md` (modify)

**Changes**:
- Add workflow profile descriptions
- Document auto-detection logic
- Explain .forge/context.json

**Acceptance**:
- [ ] Workflow profiles explained
- [ ] Auto-detection documented

### Task 6.3: Create Migration Guide
**Duration**: 2 hours
**Files**:
- `docs/MIGRATION.md` (create)

**Content**:
- For existing Forge users: What changed?
- How to enable new features
- How to migrate existing projects
- Troubleshooting common issues

**Acceptance**:
- [ ] Migration guide complete
- [ ] Covers all breaking changes (none expected)

### Task 6.4: Final Manual Verification
**Duration**: 2 hours

**Test matrix**:
| Scenario | Expected Outcome |
|----------|------------------|
| Fresh install (new project) | Auto-detect stage, generate profile-based AGENTS.md |
| Existing CLAUDE.md (no markers) | Semantic merge, preserve user content |
| Existing CLAUDE.md (with markers) | Marker-based merge (backward compatible) |
| With `--interview` | 3 questions asked, answers saved |
| With `--stage=stable` | Stable profile used |
| Agent prompt (Claude Code) | Agent completes installation |

**Acceptance**:
- [ ] All scenarios tested manually
- [ ] No regressions found
- [ ] Edge cases handled gracefully

### Task 6.5: Final Commit & PR
```bash
git add README.md docs/
git commit -m "docs: enhanced onboarding documentation

- Add Enhanced Onboarding section to README
- Update WORKFLOW.md with workflow profiles
- Create migration guide for existing users
- Document all new CLI flags

/verify complete"

git push

# Create PR
gh pr create --title "feat: Enhanced Forge Onboarding Experience" \
  --body "See openspec/changes/enhanced-onboarding/proposal.md

## Summary
- Intelligent semantic merge for existing context files
- Auto-detection of project stage and framework
- Workflow profiles (new/active/stable)
- Agent installation prompt for AI-assisted setup

## Breaking Changes
None - fully backward compatible

## Testing
- 90%+ test coverage on new modules
- Integration tests for full setup flow
- Manual verification with real-world projects

## Related
- OpenSpec: openspec/changes/enhanced-onboarding/
- Beads: forge-xyz"
```

---

## Parallel Execution Plan

**Week 1**:
- Days 1-3: Phase 1 (Semantic Merge) - **Developer A**
- Days 1-2: Phase 2 (Auto-Discovery) - **Developer B**
- Days 3-4: Phase 3 (Workflow Profiles) - **Developer B**

**Week 2**:
- Day 1: Phase 4 (Agent Prompt) - **Developer A**
- Days 2-3: Phase 5 (Integration) - **Both** (pair programming)
- Day 4: Phase 6 (Documentation) - **Developer A**

**Total**: 11 days → **8 days with parallelization**

---

## Definition of Done

For each phase:
- [ ] All tests PASS (unit + integration)
- [ ] Test coverage >90% for new code
- [ ] No linting errors
- [ ] Committed with descriptive message
- [ ] Pushed to feature branch

For the entire feature:
- [ ] All 6 phases complete
- [ ] Integration tests PASS
- [ ] Manual verification complete
- [ ] Documentation updated
- [ ] PR created and reviewed
- [ ] OpenSpec proposal archived
- [ ] Beads issue closed

---

## Rollback Plan

If implementation fails or needs to be rolled back:

1. **Preserve existing functionality**: All new code is additive, old code paths unchanged
2. **Feature flags**: Could add `FORGE_ENHANCED_ONBOARDING=false` env var to disable
3. **Git revert**: `git revert <commit-range>` to undo changes
4. **Communication**: Update users if feature is delayed or removed

No breaking changes expected, so rollback risk is low.
