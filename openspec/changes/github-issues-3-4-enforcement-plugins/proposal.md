# Proposal: AGENTS.MD-First Workflow Enforcement + Plugin Architecture

**Issue:** GitHub #3 & #4
**Type:** Strategic (Architecture Change)
**Status:** Proposed
**Beads:** forge-6hn

## Problem

### Issue #3: Workflow Commands Not Enforced

Commands like `/status`, `/dev`, `/research` are documentation-only with zero technical enforcement:
- No validation of prerequisites (research before dev, tests before ship)
- No git hooks to prevent skipping TDD steps
- Relies entirely on AI agent discipline
- No actual CLI commands, just markdown instructions

**Impact:** AI agents can skip critical workflow steps, leading to:
- Missing research for security-critical features
- Shipping code without tests
- Incomplete documentation
- Inconsistent quality across features

### Issue #4: Agent Directories Hardcoded

The `AGENTS` object in `bin/forge.js` is hardcoded with 11 agents:
- Adding new agent requires editing source code
- No plugin architecture
- Not scalable as new AI agents emerge
- Community cannot add agents without forking

**Impact:** Cannot easily support new AI coding agents as ecosystem grows.

### Critical Research Finding: Skills vs AGENTS.MD

**Vercel's evaluation results (2026):**
- Baseline (no docs): 53% pass rate
- **Skills (default): 53% pass rate** ← NO IMPROVEMENT
- Skills with explicit instructions: 79% pass rate
- **AGENTS.MD docs index: 100% pass rate** ← 47pp improvement!

**Why AGENTS.MD wins:**
1. **Eliminates decision points** - Context always available
2. **Persistent availability** - In system prompt across all turns
3. **Simplified sequencing** - No async loading complications
4. **Reduces noise** - Skills can introduce distraction

**Current anti-pattern:** `.claude/skills/forge-workflow/SKILL.md` likely hurting performance.

## Solution

### Core Architecture: AGENTS.MD-First

**Main workflow instructions IN AGENTS.MD** (~180 lines):
- 9-stage TDD workflow with automatic change classification
- TDD orchestration with parallel Task agents
- Conversational enforcement (guided recovery, not hard blocks)
- State management via Beads metadata
- Git hooks for automatic validation
- Context pointers to detailed command files

**Benefits:**
- ✅ Persistent in system prompt (100% pass rate per Vercel)
- ✅ No decision points (agent doesn't choose when to load)
- ✅ Strong enforcement (core rules always available)
- ✅ Compressed size (~180 vs 596 lines across multiple files)
- ✅ Retrieval for details (load command files when executing stage)

### Technical Enforcement

**Git Hooks (lefthook):**
- Pre-commit: Blocks if source modified without tests
- Pre-push: Requires all tests passing
- Offers guided recovery (not just hard blocks)
- Creates tech debt issues for skips

**Beads Integration:**
- Single source of truth for workflow state
- Tracks: current stage, completed stages, parallel tracks, TDD phases
- Survives conversation compaction (git-backed)

**Automatic TDD Orchestration:**
- `/dev` analyzes plan and launches parallel Task agents
- Each agent follows RED-GREEN-REFACTOR cycle
- Real-time progress tracking
- Integration phase with E2E tests

### Plugin Architecture

**JSON-based plugins:**
- Extract hardcoded `AGENTS` object to `lib/agents/*.plugin.json`
- Plugin discovery and validation system
- Community can add agents via PR (just add JSON file)
- Zero breaking changes (backwards compatible)

### UX Philosophy

**Conversational, Not Blocking:**
- AI automatically detects change type (critical/standard/simple/hotfix/docs/refactor)
- Offers solutions when prerequisites missing
- Creates accountability for skips (tech debt tracking)
- Progressive disclosure (simple by default, detailed when needed)

## Alternatives Considered

### Alternative 1: Full Runtime CLI ❌

Create actual CLI commands like `forge dev`, `forge status`, etc.

**Rejected because:**
- Most commands require AI intelligence (can't be scripted)
- Would duplicate AI orchestration logic in JavaScript
- Violates core philosophy (AI-driven workflows)
- Massive scope creep
- Doesn't match how the product works

### Alternative 2: Keep Skills-Based Approach ❌

Continue using `.claude/skills/forge-workflow/SKILL.md`

**Rejected because:**
- Vercel research shows 53% vs 100% pass rate
- Introduces noise and distraction
- Fragile and wording-dependent
- Decision points hurt performance

### Alternative 3: Configuration Files for Enforcement ❌

Use `.forge/config.yml` with 200+ lines of YAML for enforcement rules.

**Rejected because:**
- Not conversational (AI-agent workflows need natural language)
- Cognitive overhead for users
- Most users won't touch it
- Interrupts conversation flow

## Impact

### Breaking Changes

**None** - Fully backwards compatible:
- Existing command files still work
- Plugin system loads from JSON but maintains same `AGENTS` object structure
- Git hooks are opt-in during setup
- Validation defaults to warn mode

### Migration Path

**No migration needed** (greenfield implementation):
- New installs get optimized AGENTS.MD automatically
- Existing users: `npm update forge-workflow`
- Hooks auto-install on next `npx forge setup`
- Can opt into strict mode via conversation

### Performance Impact

**Expected improvements:**
- Agent performance: 53% → 90%+ (based on Vercel's AGENTS.MD results)
- Context size: 596 lines → ~180 lines (70% reduction)
- Decision points: eliminated (persistent context)
- TDD compliance: 100% (git hooks enforce)

### Security Impact

**Positive:**
- Git hooks prevent shipping code without tests
- Research enforced for critical features (security, payments, auth)
- OWASP analysis built into critical workflow
- Pre-commit validation (no arbitrary code execution)

**Mitigations:**
- Use execFile() not shell commands (prevent command injection)
- Plugin schema validation (no arbitrary code)
- Path traversal prevention
- Clear override mechanisms (--no-verify)

## Implementation

### Phase 1: AGENTS.MD Consolidation

**Week 1:**
- Create optimized AGENTS.MD (~180 lines)
- Remove harmful forge-workflow skill
- Compress command files (remove duplication)
- Testing & documentation

**Deliverables:**
- `AGENTS.MD` with core workflow
- Updated `.claude/commands/*.md` (compressed)
- Tests validating AGENTS.MD structure

### Phase 2: Validation Framework

**Week 2:**
- Create `bin/forge-validate.js` CLI
- Add git hooks (lefthook)
- Beads metadata integration
- Testing & integration

**Deliverables:**
- `lefthook.yml` with pre-commit/pre-push hooks
- `.forge/hooks/check-tdd.js` with guided recovery
- Tests for git hook enforcement

### Phase 3: Plugin Architecture

**Week 3:**
- Create plugin schema
- Build plugin manager
- Migrate 11 agents to JSON plugins
- Testing

**Deliverables:**
- `lib/plugin-manager.js`
- `lib/agents/*.plugin.json` (11 files)
- Updated `bin/forge.js` to use plugins
- Tests for plugin loading/validation

### Phase 4: Release

**Week 4:**
- Comprehensive testing
- Documentation updates
- Release as v2.0.0

## Success Criteria

### Functional Requirements

- ✅ All workflow stages have automatic validation
- ✅ Git hooks prevent TDD violations
- ✅ All 11 agents work via plugin system
- ✅ Community can add agents (just add JSON file)
- ✅ Zero breaking changes for existing users

### Performance Targets

- ✅ Agent performance: 90%+ (vs current ~53%)
- ✅ AGENTS.MD size: <200 lines (vs 596 across files)
- ✅ Decision points: 0 (persistent context)
- ✅ TDD compliance: 100% (git hooks enforce)

### Quality Gates

- ✅ All tests passing
- ✅ No regression in existing functionality
- ✅ Documentation complete (AGENTS.MD, docs/, commands/)
- ✅ Security review passed (command injection prevention)
- ✅ Community plugin template ready

## Risks & Mitigations

### Risk 1: Git Hooks Too Strict

**Impact:** Users frustrated by enforcement, disable hooks

**Mitigation:**
- Guided recovery (offer solutions, not just blocks)
- Clear override mechanisms (--no-verify with documentation)
- Tech debt tracking for skips
- Default to warn mode (can opt into strict)

### Risk 2: AGENTS.MD Too Large

**Impact:** Performance degrades if AGENTS.MD exceeds token budget

**Mitigation:**
- Target <200 lines (currently ~180 in plan)
- Context pointers to detailed files (retrieval-based)
- Regular compression audits
- User feedback monitoring

### Risk 3: Plugin System Complexity

**Impact:** Community confused about how to add agents

**Mitigation:**
- Clear plugin template (`.github/PLUGIN_TEMPLATE.json`)
- Comprehensive docs (`docs/PLUGINS.md`)
- Schema validation with helpful error messages
- Example plugins for all 11 agents

## Timeline

**Total: 4 weeks**

- Week 1: AGENTS.MD consolidation (CRITICAL)
- Week 2: Validation framework
- Week 3: Plugin architecture
- Week 4: Release preparation

**Target Release:** v2.0.0 (no migration needed)

## References

- [Vercel Blog: AGENTS.MD outperforms skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
- [Vercel Agent Skills Repository](https://github.com/vercel-labs/agent-skills)
- [AGENTS.MD Official Specification](https://agents.md/)
- [Full Implementation Plan](../../../.claude/plans/precious-kindling-hartmanis.md)
- [GitHub Issue #3](https://github.com/harshanandak/forge/issues/3)
- [GitHub Issue #4](https://github.com/harshanandak/forge/issues/4)
