# Parallel Agent Teams for Forge: Research Findings

**Date**: 2026-04-06
**Researcher**: Analyzed Forge's parallel execution model against Anthropic's C compiler team pattern

## Executive Summary

Forge has foundational infrastructure for parallel agents but lacks orchestration:

**What Works**:
- ✓ Worktrees enable isolated work per agent
- ✓ Beads metadata has parallelTracks field (defined but unused)
- ✓ PR coordinator tracks dependencies and conflicts
- ✓ HARD-GATE TDD enforcement (tests supervise agents)

**What's Missing**:
- ✗ /dev runs tasks sequentially (no parallel task dispatch)
- ✗ No concurrent Beads write safety (locking, versioning)
- ✗ No agent-team protocol (claim, heartbeat, queue)

## Key Findings from Analysis

### 1. Worktree Infrastructure (lib/commands/worktree.js)
- forge worktree create <slug> creates isolated branches
- setupBeads() symlinks .beads directory for shared state
- Agents work independently on separate branches
- **Strength**: Git prevents merge conflicts at filesystem level

### 2. Beads Metadata with Unused parallelTracks Field
Evidence from .worktrees/workflow-state-authority/:
- state.js lines 53-72 define normalizeParallelTrack()
- Schema includes: name, agent, status, worktree.path, worktree.branch
- Tests show parallelTracks always empty arrays (never populated)
- state-manager.js has no write operations for parallelTracks

### 3. PR Coordinator (scripts/pr-coordinator.sh)
- merge-sim: Detects merge conflicts before merge
- merge-order: Dependency-aware merge sequence
- rebase-check: Identifies branches needing rebase
- stale-worktrees: Finds abandoned worktrees >48h old
- **Limitation**: Informational only, no automatic coordination

### 4. Test Supervision (HARD-GATE in /dev)
From .claude/commands/dev.md:
- Implementer subagent enforces: failing test → implementation → passing test
- TDD is the HARD-GATE (structural enforcement)
- Spec reviewer checks compliance
- Quality reviewer checks code quality
- **Alignment with Anthropic**: Tests keep agents on track without human oversight

### 5. Sequential /dev Task Execution
Current flow: for each task → dispatch implementer → wait → spec review → wait → quality review → next task
- No support for parallel task handling
- No file-overlap analysis
- No task grouping for parallel safety

### 6. Concurrent Write Risk
Beads single-source-of-truth design vulnerable if multiple agents write parallelTracks simultaneously:
- No visible lock file/mutex
- No version field for optimistic locking
- No atomic compare-and-swap
- "Last write wins" semantics not documented

## Anthropic's Parallel Team Lessons

From 16-agent C compiler project (Feb 2026):

**Key 1: Tests ARE Supervision**
- Agents learn to run tests frequently
- Failures visible immediately
- No human needed to tell agent "you broke something"
- Agents self-fix broken tests

**Key 2: Structure Work for Parallel Progress**
- Task granularity defined by test boundaries
- Group tasks by file/module to reduce merges
- Prioritize independent tasks

**Key 3: Coordination is the Ceiling**
- "The ceiling is coordination, not capability"
- Bottleneck shifts from coding ability to coordination
- Need: explicit coordination, merge strategy, shared results, fallback to sequential

## Recommendations

### Tier 1: Parallel Task Dispatch (2-3 weeks)
- /plan Phase 3: Analyze task-to-file mapping, flag conflicts
- /dev: Partition tasks into parallel-safe groups (no file overlaps)
- Dispatch N implementers simultaneously on non-conflicting tasks
- Update Beads parallelTracks field during dispatch

### Tier 2: Concurrent Write Safety (1 week)
- Add version field to Beads metadata
- Implement optimistic locking: write succeeds only if version matches
- Agents retry on version mismatch
- Leverage git commit atomicity for consistency

### Tier 3: Agent-Team Protocol (2-3 weeks)
- Task queue: pending/in_progress/completed
- Claim operation: atomic task claiming by agent
- Heartbeat: 5-min background updates (1h timeout)
- Result reporting: completion notification to queues

### Tier 4: Test Result Sharing (1 week)
- Cache test results in .test-results.json
- First agent runs tests, commits results
- Other agents reuse if <5 min old
- Re-run if tests or affected code changed

## Cross-Agent Compatibility

| Feature | Claude Code | Codex | Cursor | Copilot |
|---------|-------------|-------|--------|---------|
| Subagent spawn | ✓ | ✓ | ✗ | ✗ |
| Worktree support | ✓ | ✓ | ✓ | ✓ |
| Task claiming | ✓ | ✓ | ✗ | ✗ |
| Heartbeat loop | ✓ | ✓ | ✗ | ✗ |

Note: Cursor/Copilot workaround via GitHub Actions CI + /dev invocation

## Test Strategy for Parallel Agents

1. **HARD-GATE**: Every agent runs tests before commit
2. **Flaky detection**: Run tests 3x to expose intermittent failures
3. **Conflict-driven tests**: Agent merging second writes integration tests
4. **CI validation**: Full test suite on main after merge

## Success Criteria

1. 50% faster execution with 2 parallel agents on non-overlapping tasks
2. Zero lost Beads updates during concurrent writes
3. All tests pass in both single and parallel execution
4. No manual coordination required (self-organizing)
5. Graceful fallback to sequential when conflicts detected

## File References (Forge codebase)

- lib/commands/worktree.js: Worktree creation + Beads integration
- scripts/pr-coordinator.sh: Merge coordination scripts
- .claude/commands/dev.md: /dev stage with TDD HARD-GATE
- .worktrees/workflow-state-authority/lib/workflow/state.js: Beads metadata schema (lines 53-72)
- .worktrees/workflow-state-authority/lib/workflow/state-manager.js: State persistence
- AGENTS.md: 7-stage workflow (single source of truth)
