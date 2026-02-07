# Proposal: Enhanced Forge Onboarding Experience

**Status**: Draft
**Created**: 2026-02-05
**Author**: AI Assistant
**Related Issues**: N/A

## Problem Statement

The current Forge setup flow (`npx forge setup`) has critical gaps that create friction during onboarding:

### 1. **Loss of Existing Context**
When users have existing `CLAUDE.md` or `AGENTS.md` files without Forge markers:
- **Current behavior**: Prompts for overwrite (Y/N), destroying all user content
- **Impact**: Users lose valuable project-specific knowledge, domain concepts, coding standards
- **Evidence**: `bin/forge.js` line 558-709 `smartMergeAgentsMd()` returns `null` for unmarked files

### 2. **No Project Context Gathering**
Forge only auto-detects framework from `package.json`:
- Missing: Project goals, current stage (greenfield vs legacy), domain concepts
- Missing: Team conventions, architecture decisions, active work
- **Impact**: Generated workflow is generic, not tailored to project needs

### 3. **No Agent-Assisted Installation**
Users must manually run `npx forge setup`:
- No integration with AI agents (Claude Code, Cursor, Cline, etc.)
- Agents can't help gather context or run installation
- **Impact**: Missed opportunity for intelligent, guided setup

### 4. **One-Size-Fits-All Workflow**
Same 9-stage workflow for all projects:
- Greenfield projects need strict TDD enforcement
- Legacy projects need relaxed, incremental adoption
- **Impact**: Workflow feels too heavy or too light depending on context

## Proposed Solution

Implement a **4-phase enhancement** to the onboarding experience:

### Phase 1: Intelligent Semantic Merge

**New module**: `lib/context-merge.js`

Intelligently merge existing context files with Forge workflow:

```javascript
// Semantic section categories
PRESERVE (user-specific):
  - Project Description, Domain Knowledge, Coding Standards
  - Architecture, Tech Stack, Build Commands

REPLACE (workflow):
  - Workflow sections → Forge 9-stage workflow
  - TDD sections → Forge TDD principles
  - Git workflow → Forge git conventions

MERGE (combine):
  - Quick Start, Toolchain sections
```

**Key capabilities**:
- Parse markdown into semantic sections
- Fuzzy match headers (e.g., "Workflow" vs "Development Workflow")
- Confidence-based decisions (>80% auto-merge, <80% ask user)
- Add markers only when merge performed (avoid pollution)

**Integration point**: Replace `null` return in `bin/forge.js:564` with semantic merge call

### Phase 2: Auto-Discovery + Optional Interview

**New module**: `lib/project-discovery.js`

**Auto-detection (convention over configuration)**:
- Scan: `package.json`, `requirements.txt`, `Dockerfile`, `.github/workflows`
- Detect: Framework (reuse existing logic), language, project type
- Infer: Project stage from git history, test coverage, CI/CD presence
- Generate smart defaults without user input

**Optional interview** (only with `--interview` flag):
- 3 core questions: description, confirm stage, current work
- Store in `.forge/context.json` (separate config, don't pollute user files)

**Inspired by**: OpenCode's layered configuration approach (oh-my-opencode.json)

### Phase 3: Simplified Workflow Profiles

**New module**: `lib/workflow-profiles.js`

**Three profiles** (reduced from 5 per user feedback):

| Profile | Use Case | Workflow | TDD | Research |
|---------|----------|----------|-----|----------|
| **New** | Greenfield/Early | 9-stage (critical) | Strict | All features |
| **Active** | Mid-development | 6-stage (standard) | Balanced | Critical only |
| **Stable** | Mature/Maintenance | 4-stage (simple) | Relaxed | None |

**Auto-detection**:
- New: commits < 50, no CI/CD, coverage < 30%
- Active: commits 50-500, has CI/CD, coverage 30-80%
- Stable: commits > 500, has CI/CD + releases, coverage > 80%

**Override**: `--stage` flag for manual selection

### Phase 4: Agent Installation Prompt

**New file**: `docs/AGENT_INSTALL_PROMPT.md`

Self-contained prompt for AI agents that:
1. Detects agent type (`.claude/`, `.cursor/`, etc.)
2. Gathers project context (explores codebase, asks questions)
3. Runs installation (`npx forge setup --agents <type>`)
4. Customizes output with discovered context
5. Reports results

**Format**: Copy-paste markdown with step-by-step instructions

## Alternatives Considered

### Alternative 1: Simple Append (No Semantic Merge)
**Approach**: Just append Forge content to existing files
**Pros**: Simple, no risk of data loss
**Cons**: Creates duplicate sections, confusing structure
**Decision**: Rejected - poor UX, cluttered files

### Alternative 2: Full Interactive Wizard
**Approach**: Ask 10+ questions about project
**Pros**: Maximum customization
**Cons**: High abandonment rate (research shows >10 questions = fatigue)
**Decision**: Rejected - use auto-discovery instead

### Alternative 3: Replace Existing Files
**Approach**: Always overwrite with Forge templates
**Pros**: Clean, consistent output
**Cons**: Destroys user knowledge, breaks trust
**Decision**: Rejected - preservation is critical

### Alternative 4: Five Workflow Profiles
**Approach**: Greenfield/Early/Mid/Mature/Legacy
**Pros**: More granular customization
**Cons**: Too complex, analysis paralysis
**Decision**: Simplified to 3 profiles per user feedback

## Impact Analysis

### User Impact
**Positive**:
- Existing context preserved (no data loss)
- Faster setup (<5 min vs current ~15 min)
- Tailored workflow (not generic)
- Agent-assisted option (for AI-native workflows)

**Negative**:
- New `.forge/context.json` file (minimal)
- Markers in merged files (only when needed)

### System Impact
**Files Modified**:
- `bin/forge.js` (integration into `interactiveSetup()`)

**Files Created**:
- `lib/context-merge.js` (semantic merge algorithm)
- `lib/project-discovery.js` (auto-detection + interview)
- `lib/workflow-profiles.js` (stage-based configs)
- `docs/AGENT_INSTALL_PROMPT.md` (agent prompt)
- `.forge/context.json` (project context storage)

**Test Coverage**:
- Unit tests for each module
- Integration tests for setup flow
- Edge case tests for semantic merge

### Breaking Changes
**None** - This is purely additive:
- Existing setup flow continues to work
- New behavior only triggers for unmarked files
- All new features are opt-in via flags

### Performance Impact
**Minimal**:
- Semantic merge adds ~100ms to setup
- Auto-discovery adds ~200ms (file system scans)
- No runtime performance impact (setup-time only)

## Implementation Phases

### Phase 1: Core Merge Algorithm (3 days)
- Create `lib/context-merge.js`
- Implement semantic section parsing
- Implement confidence-based merge logic
- Unit tests with real-world CLAUDE.md files
- Integration test: merge existing file without data loss

### Phase 2: Auto-Discovery (2 days)
- Create `lib/project-discovery.js`
- Implement file system scanning
- Implement stage detection logic
- Create `.forge/context.json` format
- Unit tests for detection accuracy

### Phase 3: Workflow Profiles (2 days)
- Create `lib/workflow-profiles.js`
- Define 3 profile templates
- Implement auto-detection → profile mapping
- Unit tests for profile selection

### Phase 4: Agent Prompt (1 day)
- Create `docs/AGENT_INSTALL_PROMPT.md`
- Test with Claude Code, Cursor, Cline
- Add verification steps and safety guardrails

### Phase 5: Integration (2 days)
- Modify `bin/forge.js` interactiveSetup()
- Add CLI flags: `--interview`, `--merge`, `--stage`
- Integration tests for full setup flow
- Manual verification with test projects

### Phase 6: Documentation (1 day)
- Update `README.md` with new features
- Update `docs/WORKFLOW.md` with workflow profiles
- Create migration guide for existing users

**Total estimate**: 11 days

## Success Metrics

1. **Merge Success Rate**: >95% of existing files merge without data loss
2. **Interview Completion**: >80% of users complete core 3-question interview
3. **Agent Prompt Adoption**: >50% of new users try agent-assisted installation
4. **Time to Value**: Setup completes in <5 minutes (vs current ~15 min)
5. **Error Recovery**: <5% of setups require manual intervention

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Semantic merge fails on edge cases | Medium | High | Extensive test suite with real-world files; preserve backup |
| Interview abandonment | Low | Medium | Optional by default; sensible auto-detected defaults |
| Agent prompt security concerns | Medium | Medium | Human-readable format, verification steps, safety guardrails |
| Marker pollution | Low | Low | Only add markers when merge performed |
| Merge confidence errors | Medium | High | Fuzzy matching with confidence thresholds; ask user when unsure |
| Stage detection inaccuracy | Medium | Medium | Allow manual override via `--stage` flag |

## Open Questions

1. **Merge conflict resolution**: When confidence < 80%, show diff or ask per-section?
   - **Recommendation**: Show side-by-side diff with radio buttons (Forge/User/Both)

2. **Interview skip option**: Should we allow "skip with defaults" button?
   - **Recommendation**: Yes, with clear message about what defaults were applied

3. **Agent prompt scope**: Should agent explore codebase beyond context gathering?
   - **Recommendation**: Make exploration opt-in via `--explore` flag (avoid overstepping)

4. **Workflow profile override**: Should users be able to customize individual stages?
   - **Recommendation**: Phase 2 feature - start with profiles, add granular control later

## References

### Research Documents
- [Parallel AI Research](C:\Users\harsha_befach\.claude\plans\purring-nibbling-meadow.md#research-findings)
- OpenCode layered configuration: https://ohmyopencode.com/
- Git semantic merge best practices
- CLI onboarding UX patterns (ThoughtWorks, Lucas Costa)
- AI agent installation patterns (Red Hat, Microsoft, MindStudio)

### Related Code
- `bin/forge.js:558-709` - Current `smartMergeAgentsMd()` function
- `bin/forge.js:2153` - Current `interactiveSetup()` function
- `bin/forge.js:728-960` - Existing `detectProjectType()` function
- `test/rollback-user-sections.test.js` - Existing marker extraction pattern

### Related Issues
- GitHub #[TBD] - Enhanced onboarding experience
- Beads [TBD] - Implementation tracking

## Approval Checklist

- [ ] Technical approach validated
- [ ] Breaking changes reviewed (none in this case)
- [ ] Performance impact acceptable
- [ ] Test strategy defined
- [ ] Documentation plan complete
- [ ] Success metrics agreed upon
- [ ] Open questions resolved
