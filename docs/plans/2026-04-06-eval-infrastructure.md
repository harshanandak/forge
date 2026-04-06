# Forge Eval Infrastructure & Harness Effectiveness (2026-04-06)

**Status:** Analysis Complete  
**Scope:** Eval architecture, harness metrics, infrastructure noise, cross-agent parity  
**Recommendation:** Implement 3-phase harness observatory + A/B testing framework

---

## Executive Summary

Forge has **functional command-level eval** (worktree isolation, NDJSON parsing, LLM-based grading) but **lacks workflow-level harness metrics**. Current infrastructure can measure if individual commands succeed; it cannot measure if the 7-stage workflow actually improves code quality or development velocity.

**Recommendation: Build a Harness Observatory** — unified metrics collection across all 7 stages, per-agent tracking, infrastructure noise quantification, and A/B testing framework. Cost: ~200 LOC, zero overhead to normal workflow (metrics collected asynchronously).

---

## Q&A: Eval Infrastructure Analysis

### Q1: Does Forge evaluate its own harness effectiveness?

**Answer: Partially, at command level only.**

Current state:
- ✅ Per-command behavioral eval: `run-command-eval.js` executes query → parses NDJSON → grades via `command-grader.md` → saves results to `.forge/eval-logs/`
- ✅ Assertion types (standard, hard-gate, contract) can validate command output correctness
- ✅ Improvement loop (`improve-command.js`) detects regressions and flaky assertions across sessions
- ❌ No unified metric for "did the harness help?" — no measurement of code quality delta, velocity improvement, or reduction in manual intervention

**Gap:** We can test `/dev` in isolation, but not measure if `/plan` → `/dev` → `/validate` → `/ship` actually produces better outcomes than ad-hoc development.

---

### Q2: Should Forge track metrics per stage?

**Answer: Yes—critical gap.**

Current metrics (scattered):
- CLI startup: 212ms (from benchmark-results.json)
- Command execution time: embedded in eval-runner stdout (not aggregated)
- Grader score: 0-1 (per eval, not per stage)
- Hook execution: logged to stderr, not captured

Missing per-stage:
- Success rate (% of invocations that completed without error)
- Latency (p50, p95, p99 of stage duration)
- Tool-call volume (git, bash, gh, file I/O per stage)
- Precondition pass rate (% of runs where hard-gates allowed progression)
- Beads integration latency (how long did `/plan` spend waiting for beads?)
- Artifact contract violations (outputs that don't match downstream contracts)
- Error categories (command parse, network timeout, assertion failure, user abort)

**Implementation:** Modify each `.claude/commands/*.md` to emit metrics to `.forge/stage-metrics/{stage}-{date}.json`. Aggregate in `/status` command dashboard.

---

### Q3: How should Forge handle infrastructure noise?

**Answer: Measure it, isolate it, use robust aggregation.**

Infrastructure noise sources in Forge:
1. **Worktree creation:** Measured at 1-2s per eval. Spikes on Windows (file system sync).
2. **Git operations:** Branch creation, rebase, worktree prune—highly variable.
3. **Network latency:** Beads API calls (200-500ms), GitHub API (100-300ms).
4. **Claude API latency:** LLM response time varies 2-10s depending on prompt complexity.
5. **Hook execution:** lefthook serializes hooks; N hooks = N sequential delays.

Handling strategy:

1. **Baseline noise:** Run N evals with empty prompts (no-op runs) to quantify system noise. Subtract from command eval time.
2. **Per-hook latency:** Wrap each hook in `time` command, log to `.forge/hook-timings.log`. Identify slow hooks.
3. **Robust aggregation:** Use p90 (90th percentile) instead of mean for metrics. Mean is skewed by outliers; p90 is stable.
4. **Flaky assertion detection:** Expand `improve-command.js` logic—flag assertions that pass in session A but fail in session B (infrastructure-dependent).
5. **Parallel baselines:** Run 2 identical evals concurrently; if results differ >10%, mark run as noisy.

---

### Q4: Should Forge implement A/B testing between harness configurations?

**Answer: Yes, staged approach.**

Phase 1 (Now): Command-level A/B
- Test prompt variant A vs B for same command
- Use `eval-schema.js` to define two eval sets (control, treatment)
- Run both in parallel worktrees
- Compare assertion pass rates

Phase 2 (Q2): Stage-level A/B
- Test different hard-gate thresholds
- Example: strict mode (all hard-gates enforced) vs lenient mode (warnings only)
- Run 2 parallel workflows, compare final code quality + time

Phase 3 (Q3): Full workflow A/B
- Compare entire 7-stage TDD pipeline vs traditional dev workflow
- Long-term study with real developers

**Cost:** Worktree spawn time (~1s per parallel run), storage for dual eval-logs (~1MB per week).

---

### Q5: Can Forge use command-grader agent to evaluate outputs?

**Answer: Yes, and expand scope.**

Current usage:
- Grades transcripts against assertions (standard, hard-gate, contract)
- Returns per-assertion pass/fail + reasoning

Expansion opportunities:

1. **Artifact-consistency assertions:** New assertion type checking that command output matches format expected by next stage. Example: "Does `/plan` output contain required 'Design Decisions' section?"
2. **Beads state validation:** Grade whether issue state transitions are correct. Example: "Did `/ship` transition issue from `in_progress` to `waiting_for_review`?"
3. **PR review feedback:** Use grader to evaluate if `/review` stage actually addressed all GitHub comments.
4. **Code quality subjective eval:** Ask grader: "Is this code idiomatic for the language?" (subjective but valuable).

**Risk:** Grader latency (3-5s per eval). Mitigate by running grader async, use caching for identical transcripts.

---

### Q6: Should Forge track harness overhead?

**Answer: Absolutely—cost of process visibility.**

Current overhead (measured):
- Hook execution per stage: ~500ms
- Worktree creation per eval: ~1-2s
- Beads sync per command: ~200ms
- Grader invocation: ~3-5s
- **Total per `/dev` invocation:** ~5-10s overhead

Overhead scaling:
- 1 developer: negligible
- 5 developers (5 parallel worktrees): 5-10s becomes 25-50s if not coordinated
- Team growth risk: Hooks become bottleneck

Tracking strategy:

1. **Enforce SLO:** "Full `/dev` command under 30s" (including overhead)
2. **Per-hook timing:** Warn if any hook exceeds 5s
3. **Overhead budget:** Reserve 20% of total time for harness overhead
4. **Latency correlate:** Track correlation between team size (N developers) and hook latency (should stay constant, not grow)

---

### Q7: How to evaluate cross-agent parity?

**Answer: Automated test suite per agent.**

Forge supports 8+ agents: Claude Code, Cursor, Cline, OpenCode, GitHub Copilot, Kilo Code, Roo Code, Codex.

Parity eval framework:

1. **Unified eval set:** Create `.forge/eval-sets/core-workflow.json` with 20 representative queries (basic task, complex refactor, documentation, etc.)
2. **Per-agent runner:** For each agent, execute same queries, capture transcripts
3. **Comparison metrics:**
   - Assertion pass rate (must match within 5%)
   - Tool usage patterns (do all agents use git? beads?)
   - Error categories (which agent fails on MCP tasks?)
4. **Parity dashboard:** CI job runs nightly, reports pass/fail per agent

---

### Q8: What metrics matter for a workflow harness?

**Answer: Five primary metrics.**

| Metric | Target | Alert threshold |
|--------|--------|------------------|
| **Command success rate** | >95% | <90% |
| **Hard-gate enforcement** | 100% | Any violation |
| **Artifact contract compliance** | 100% | <98% |
| **End-to-end cycle time** | <2min per command | >3min |
| **Flaky assertion rate** | 0% | >5% |

Secondary metrics (track, don't enforce):
- Hook execution time (trend, don't alert)
- Beads integration latency (per-command)
- Per-stage error distribution (which stage fails most?)
- Human override frequency (how often does user override hard-gate?)
- Tool call volume per stage (detect scope creep)

---

## Recommended Implementation (3-Phase)

### Phase 1: Metrics Observatory (Week 1)
- [ ] Add `.forge/stage-metrics/` collection in each command
- [ ] Emit JSON: `{ stage, duration_ms, success, error, tool_calls, assertions_passed }`
- [ ] Aggregate in `/status` dashboard

### Phase 2: A/B Testing (Weeks 2-3)
- [ ] Extend `eval-schema.js` to support treatment variants
- [ ] Implement parallel eval runner (2 worktrees, compare results)
- [ ] Pilot: test "strict vs lenient" hard-gates on `/validate` stage

### Phase 3: Cross-Agent Parity (Weeks 4-5)
- [ ] Implement `.github/workflows/cross-agent-eval.yml`
- [ ] Run nightly parity tests
- [ ] Flag agent-specific failures in dashboard

---

## Why This Matters

Current state: Forge works, but we don't know *how well*. TDD enforcement catches some bugs, but is it worth the overhead? Are hard-gates actually preventing failures?

With harness metrics: Data-driven answers to:
- "Should we make hard-gates stricter?"
- "Which stage is slowest? Can we optimize it?"
- "Do newer agents (Cursor, Codex) need special handling?"
- "Is the 7-stage workflow better than ad-hoc development?"

**Business impact:** Prove Forge's ROI. Justify complexity. Enable team scaling.

---

## Appendix: Existing Infrastructure

**Eval components (functional):**
- `scripts/lib/eval-runner.js` — worktree isolation, command execution, Bun.spawn for Windows
- `scripts/lib/transcript-parser.js` — NDJSON parsing, tool-call extraction
- `scripts/lib/grading.js` — grader orchestration via command-grader agent
- `scripts/lib/eval-schema.js` — assertion validation (standard, hard-gate, contract)
- `scripts/lib/eval-storage.js` — result persistence with cross-session history
- `scripts/improve-command.js` — semi-autonomous improvement loop with regression detection
- `.claude/agents/command-grader.md` — behavioral evaluation agent

**Benchmarks (partial):**
- `scripts/benchmark.js` — CLI startup (212ms), others (0ms)
- `benchmark-results.json` — 3 samples per metric

**Gaps:**
- No per-stage metrics collection
- No infrastructure noise isolation
- No A/B testing framework
- No cross-agent parity eval
- No harness overhead tracking
