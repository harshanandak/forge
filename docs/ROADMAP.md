# Forge Enhancement Roadmap

**Comprehensive implementation plan for transforming Forge into a fully automated, orchestrated workflow system.**

**Plan Created**: 2026-02-10
**Status**: Phase 2 complete. PR5/PR6 research done, ready for planning.
**Timeline**: 3-4 weeks total
**Strategy**: Quick wins first → Build testing foundation → Add automation → Enable extensibility

---

## Table of Contents

1. [Overview](#overview)
2. [Implementation Strategy](#implementation-strategy)
3. [PR Sequence & Dependencies](#pr-sequence--dependencies)
4. [Detailed PR Breakdown](#detailed-pr-breakdown)
5. [Success Metrics](#success-metrics)
6. [Tracking & Management](#tracking--management)

---

## Overview

Transform Forge from a documentation-driven workflow into a fully automated, orchestrated workflow system with:

- ✅ **Enhanced Multi-Agent Support**: Universal AGENTS.md + 5 Tier 1 agents (Claude Code, GitHub Copilot, Kilo Code, Cursor, Aider)
- ✅ **Comprehensive Testing**: 80%+ code coverage, E2E tests, mutation testing
- ✅ **Advanced Security**: CODEOWNERS, commit signing, extended OWASP checks
- ✅ **CLI Automation**: Automated `/research`, `/plan`, `/ship`, `/review` commands
- ✅ **Plugin Architecture**: Extensible system for custom checks and workflows
- ✅ **Quality Dashboards**: Metrics, auto-merge, release automation

---

## Implementation Strategy

**Philosophy**: Deliver immediate value while building towards comprehensive improvements.

```
Quick Wins (Week 1) → Testing Foundation (Week 2) → Automation (Week 2-3) → Extensibility (Week 3-4)
```

### Phased Approach

**Phase 0: Architecture Simplification (PREREQUISITE)**
- Simplify from 11 agents to 5 Tier 1 + 3 Tier 2
- Universal AGENTS.md + optional agent-specific configs
- Zero coordination complexity
- **Timeline**: 2-3 days

**Phase 1: Foundation & Quick Wins (Week 1)**
- PR1: Critical fixes (Greptile, /check, Windows compatibility)
- PR2: Security enhancements (CODEOWNERS, signing, semantic commits)
- PR3: Testing infrastructure (coverage, E2E, snapshots)

**Phase 2: Workflow Automation (Week 2)**
- PR4: CLI automation (command dispatcher, automated stages)
- PR5: Advanced testing (mutation testing, benchmarks, security expansion)

**Phase 3: Extensibility & Polish (Week 3-4)**
- PR6: Plugin architecture (config system, custom checks)
- PR7: Documentation automation (validators, consistency checking)
- PR8: Advanced features (metrics dashboard, auto-merge, SBOM)

---

## PR Sequence & Dependencies

```
PR0 (Simplification) → PR1 (Fixes) → PR2 (Security) → PR3 (Test Infra)
                                            ↓
                                    PR4 (Automation) → PR5 (Test Expansion)
                                            ↓
                              PR5.5 (Skills) → PR6 (Plugins) → PR7 (Docs) → PR8 (Advanced)
```

### Dependency Chain

| PR | Depends On | Blocks | Status |
|----|------------|--------|--------|
| PR0 | None | PR1 | ✅ MERGED (2026-02-12, PR #26) |
| PR1 | PR0 | PR2 | ✅ MERGED (2026-02-13, PR #28) |
| PR2 | PR1 | PR3 | ✅ MERGED (2026-02-14, PR #29) |
| PR3 | PR2 | PR4 | ✅ MERGED (2026-02-14, PR #30) |
| PR4 | PR3 | PR5 | ✅ MERGED (2026-02-19, PR #33) |
| PR5 | PR4 | PR5.5 | ✅ MERGED (2026-02-20, PR #40) |
| PR5.5 | PR5 | PR6 | ✅ MERGED (2026-02-23, PR #43) |
| PR6 | PR5.5 | PR7 | ✅ MERGED (2026-02-21, PR #41) |
| PR7 | PR6 | PR8 | Blocked |
| PR8 | PR7 | None | Blocked |

---

## Detailed PR Breakdown

### **PR0: Architecture Simplification** 🎯
**Branch**: `feat/pr0-agent-simplification`
**Beads Issue**: `forge-wp2`
**PR**: #26
**Status**: ✅ **COMPLETED & MERGED** (2026-02-12)
**Timeline**: 2-3 days
**Type**: `refactor`
**Impact**: Critical - Foundation for all subsequent PRs

#### Key Deliverables
1. Universal AGENTS.md (works with ALL agents)
2. Agent-specific configs (GitHub Copilot, Cursor, Kilo, Aider)
3. Smart setup with auto-detection
4. Documentation: ARCHITECTURE.md, CONFIGURATION.md, MCP_SETUP.md
5. Zero coordination complexity

[See complete details in master plan]

---

### **PR1: Critical Fixes & Immediate Improvements** ⚡
**Beads Issue**: `forge-bdo`
**Status**: Blocked (waiting on PR0)
**Timeline**: 1-2 days
**Impact**: High

#### Key Deliverables
1. Unified /check script - Orchestrate all validation steps
2. Lefthook Windows compatibility fixes
3. Package size monitoring workflow
4. Manual review guidance - Best practices for achieving high quality scores

---

### **PR2: Branch Protection & Security Enhancements** 🔒
**Beads Issue**: `forge-aom`
**Status**: Blocked (waiting on PR1)
**Timeline**: 1-2 days
**Impact**: High

#### Key Deliverables
1. CODEOWNERS file
2. Commit signing requirement
3. Additional branch protection
4. Semantic commit validation
5. SECURITY.md

---

### **PR3: Testing Infrastructure Foundation** 🧪
**Beads Issue**: `forge-5uh`
**Status**: Blocked (waiting on PR2)
**Timeline**: 2-3 days
**Impact**: High

#### Key Deliverables
1. Code coverage integration (c8, 80% thresholds)
2. E2E test framework
3. Snapshot testing
4. CI workflow enhancements

---

### **PR4: CLI Command Automation** 🤖
**Beads Issue**: `forge-9tp`
**PR**: #33
**Status**: ✅ **COMPLETED & MERGED** (2026-02-19)
**Timeline**: 3-4 days
**Impact**: High

#### Key Deliverables
1. Command dispatcher (bin/forge-cmd.js)
2. Intelligent /status with stage detection (1-9)
3. Automated /research, /plan, /ship, /review commands
4. PR body auto-generation
5. Review aggregator

---

### **PR5: Advanced Testing Expansion** 🔬
**Beads Issue**: `forge-01p`
**Research**: [docs/research/advanced-testing.md](docs/research/advanced-testing.md) (PR #36)
**Status**: Research complete, ready for `/plan`
**Timeline**: 2-3 days
**Impact**: Medium

#### Key Deliverables
1. Mutation testing (Stryker, 70%+ score)
2. Performance benchmarks
3. Extended security tests (OWASP A02, A07)
4. Test quality dashboard

---

### **PR5.5: Skills Restructure for skills.sh** 📦
**Status**: Scoped (part of PR6 research)
**Timeline**: 1-2 days
**Impact**: Medium

#### Key Deliverables
1. Restructure parallel-ai into 4 focused skills (search, extract, deep-research, enrichment)
2. Adopt `parallel-cli` as primary method (fallback to curl)
3. Add citation-standards rule
4. Update sonarcloud skill for skills.sh format
5. Publish to GitHub (auto-registers on skills.sh)

---

### **PR6: Plugin Architecture & Smart Recommendations** 🔌
**Beads Issue**: `forge-a7n`
**Research**: [docs/research/plugin-architecture.md](docs/research/plugin-architecture.md) (PR #37)
**Status**: Research complete, ready for `/plan`
**Timeline**: 4-5 days
**Impact**: High (flagship feature)

#### Key Deliverables
1. Plugin catalog — tech stack to tool mapping (JSON data structure)
2. Expanded detection — 20+ frameworks, databases, auth, payments, LSPs
3. CLI-first recommendation engine — prefer CLI tools over MCPs
4. Pricing transparency — free alternatives for every paid tool
5. Budget modes — Free/OpenSource/Startup/Professional/Custom
6. Installation orchestration — `npx skills add`, `npx add-mcp`, config generation, LSP setup
7. Absorbs forge-mlm scope (sync, validate; AI creation deferred to PR8)

---

### **PR7: Documentation Automation** 📚
**Beads Issue**: `forge-jvc`
**Status**: Blocked (waiting on PR6)
**Timeline**: 2-3 days
**Impact**: Medium

#### Key Deliverables
1. Auto-documentation updater
2. Link validator
3. Example code validator
4. Consistency checker

---

### **PR8: Advanced Features & Dashboard** 📊
**Beads Issue**: `forge-dwm`
**Status**: Blocked (waiting on PR7)
**Timeline**: 3-4 days
**Impact**: Medium

#### Key Deliverables
1. Workflow metrics dashboard
2. Auto-merge on green PRs
3. Stale PR/issue automation
4. Release notes automation
5. SBOM generation

---

## Success Metrics

### After PR1-PR3 (Week 1)
- ✅ Greptile workflow fixed with multi-tool support
- ✅ 80%+ code coverage
- ✅ E2E tests covering main workflow
- ✅ Branch protection with CODEOWNERS

### After PR4-PR5 (Week 2)
- ✅ All 9 commands executable via CLI
- ✅ Automated PR body generation
- ✅ 70%+ mutation score
- ✅ Performance benchmarks established

### After PR6-PR8 (Week 3-4)
- ✅ Plugin system with 3+ example plugins
- ✅ Automated documentation validation
- ✅ Workflow metrics dashboard
- ✅ Release automation

---

## Tracking & Management

### Beads Issues

All PRs tracked in Beads with proper dependencies:

| PR | Issue ID | Status | Priority | Blocked By |
|----|----------|--------|----------|------------|
| PR0 | forge-wp2 | ✅ Completed (PR #26) | P0 | None |
| PR1 | forge-bdo | ✅ Completed (PR #28) | P1 | None |
| PR2 | forge-aom | ✅ Completed (PR #29) | P1 | None |
| PR3 | forge-5uh | ✅ Completed (PR #30) | P1 | None |
| PR4 | forge-9tp | ✅ Completed (PR #33) | P2 | None |
| PR5 | forge-01p | ✅ Completed (PR #40) | P2 | None |
| PR5.5 | forge-qst | ✅ Completed (PR #43) | P2 | PR5 |
| PR6 | forge-a7n | ✅ Completed (PR #41) | P2 | PR5.5 |
| PR7 | forge-jvc | Ready | P3 | PR6 |
| PR8 | forge-dwm | Blocked | P3 | PR7 |
| ~~Skills CLI~~ | ~~forge-mlm~~ | ~~Absorbed into PR5.5 + PR6 + PR8~~ | — | — |

**View all issues**: `bd list`
**View ready work**: `bd ready`
**View blocked issues**: `bd blocked`

### Git Workflow

Each PR follows the Forge workflow:

```
/status → /research → /plan → /dev → /check → /ship → /review → /merge → /verify
```

**Current branch**: `master` (ready for next feature branch)
**Base branch**: `master`

### Plan Files

- **Master Plan**: `.claude/plans/*.md` (global, tracked by Claude Code)
- **Roadmap**: `docs/ROADMAP.md` (repository, git-tracked)
- **Beads Tracking**: `.beads/issues.jsonl` (git-tracked)

---

## Rollback Strategy

Each PR is self-contained and can be rolled back independently:

- **PR0**: Revert to current agent support model
- **PR1**: Revert workflow changes, restore original lefthook
- **PR2**: Remove CODEOWNERS, revert branch protection
- **PR3**: Remove coverage requirements, remove E2E tests
- **PR4**: Remove CLI commands, keep manual workflow
- **PR5**: Remove mutation tests, remove benchmarks
- **PR5.5**: Revert skills to monolithic format in .claude/skills/
- **PR6**: Remove plugin system, keep core functionality
- **PR7**: Remove doc automation, keep manual verification
- **PR8**: Remove advanced features, keep core workflow

---

## Next Steps

1. ✅ **PR4 Completed** — CLI command automation merged (PR #33)

2. ✅ **Research complete** for PR5 and PR6:
   - PR5 research: [docs/research/advanced-testing.md](docs/research/advanced-testing.md) (PR #36)
   - PR6 research: [docs/research/plugin-architecture.md](docs/research/plugin-architecture.md) (PR #37)
   - PR6 scope expanded: smart plugin recommendations, CLI-first, pricing transparency
   - forge-mlm absorbed into PR5.5 + PR6 + PR8

3. **Next: `/plan advanced-testing`** to start PR5 implementation

---

## Resources

- **Master Plan**: `.claude/plans/*.md`
- **Beads Issues**: `bd list` or `bd show <issue-id>`
- **Workflow Guide**: [WORKFLOW.md](./WORKFLOW.md)
- **Architecture Docs**: Coming in PR0 - [ARCHITECTURE.md](./ARCHITECTURE.md)

---

**Last Updated**: 2026-02-20
**Current Phase**: Phase 2 complete, research done for Phase 3
**Next Milestone**: Plan and implement PR5 (Advanced Testing)
