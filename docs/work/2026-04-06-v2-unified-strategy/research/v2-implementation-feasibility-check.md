# Forge v2 Implementation Feasibility Check

**Date**: 2026-04-06
**Reviewer**: Senior eng feasibility pass (technical, not strategic)
**Plan reviewed**: `docs/plans/2026-04-06-forge-v2-unified-strategy.md`
**Codebase state grounded against**: `lib/` (15 files, ~9k LOC), `scripts/` (33+ files, ~16k LOC total)

> **Verdict (TL;DR)**: **Optimistic by ~50%**. The plan is structurally sound and the workstreams are mostly the right ones, but the calendar math (12-14 weeks) underestimates integration tax, distributed-systems edge cases, and cross-platform debugging. Realistic range: **18-22 weeks** for the same scope. Each phase boundary increment IS individually shippable, which de-risks the slippage.

---

## Per-Workstream Realism

### WS1 — Forge CLI Abstraction (5 weeks claimed)

**Plan**: Pre-work 1w + Claude-only 1w + Codex/Cursor 1w + remaining 3 agents + smart status (3w included).

**Grounded reality**:
- `scripts/smart-status.sh` already exists at **819 lines**. Plan implies it needs ~1100 LOC of *new* work for scoring/grouping/cache. Reality: this is a partial rewrite of existing bash into either bash++ or JS, plus adding the scoring engine. The existing script will fight you (sed/awk doesn't do exponential decay cleanly).
- `lib/agents-config.js` exists, plus `lib/agents/*.plugin.json` for **all 9 agents already** (claude/cline/codex/copilot/cursor/kilocode/opencode/roo). Plan claim "currently only Claude + partial Copilot" is **incorrect** — the scaffolding is there but not necessarily the depth needed for hooks/PreToolUse parity.
- `lib/commands/_issue.js` already has the parser bug Qodo flagged (`--type` collision) — that's WS1 surface area too.
- Smart status with cache invalidation across worktrees + daemon updates is genuinely hard. 3 weeks for a single dev to ship a *correct* scoring/grouping engine with fixture tests is tight.

**Realistic**: **6-8 weeks**. Smart status alone is closer to 4 weeks if you include the eval harness, perf tuning, and cross-OS validation.

---

### WS2 — Commands → Agents Migration (2-3 weeks claimed)

**Plan**: 7 canonical YAMLs × 6 templates (EJS) → 42+ generated files + hybrid orchestrator pattern.

**Grounded reality**:
- 11 commands currently in `.claude/commands/` (not 7) — `sonarcloud`, `verify`, `rollback`, `research` are also there. The "7 stages" abstraction hides 4 utility commands that also need treatment.
- `scripts/sync-commands.js` is **600 lines** today and only handles markdown → markdown copying for one agent format. Going to multi-format generation (markdown frontmatter + JSON config + Kilo modes + OpenCode rules) is a different beast. The Kilo/OpenCode JSON formats have escaping concerns EJS handles poorly.
- Each agent has different "tool dispatch" semantics — Claude's Task tool, Cursor async subagents, Codex custom agents, OpenCode custom-agents — and the **Anthropic separate-context principle** has no clean equivalent on agents that don't expose subagent spawning. Codex/Copilot fakes it by calling out to a separate gh/CLI invocation; that's not the same.
- 13 source files (7 YAML + 6 templates) sounds clean until the first time a fix needs both a YAML edit AND template-specific overrides. The drift problem doesn't go away — it moves into the templates.

**Realistic**: **4-5 weeks**. Template system is fine; per-agent semantic gaps are where time vanishes.

---

### WS3 — Beads Wrapper + Bidirectional Sync (4-5 weeks claimed)

**This is the highest-risk workstream. The plan understates it the most.**

**Component breakdown reality check**:

| Component | Plan | Realistic | Why |
|-----------|------|-----------|-----|
| 1. Shared Dolt launcher | 2-3 days | 1-1.5 weeks | Dolt port/PID mgmt is OK on Linux, painful on Windows. Connection pooling + crash recovery + handling stale locks across multiple `bd` invocations in parallel = real engineering. |
| 2. Bidirectional GitHub sync + daemon | 2-2.5 weeks | **4-6 weeks** | Distributed systems work. See risks below. |
| 3. Cloud-agent CLI adapter | 1 week | 1-1.5 weeks | Detection logic + API-only fallback + label semantics. Mostly realistic. |
| 4. Backend interface | 2-3 days | 3-5 days | Realistic if ONLY interface (no concrete adapters). |
| 5. Fork beads + 5 bug fixes (parallel Go) | 2-3 weeks | 3-5 weeks | Go work in an unfamiliar codebase + upstreaming PRs to a project you don't maintain = unpredictable review cycles. The "parallel" framing is wishful — same dev, same week budget. |

**Realistic Component 1-4 total**: **6-9 weeks** (vs 4-5 claimed). Fork work is genuinely parallel only if a different person owns it.

---

### WS5 (evaluator) + WS11 (Context7 skills) — 2 weeks combined claimed

**Reality**:
- 5-dimension rubric with separate-context spawning is tractable on Claude Code (Task tool), **non-trivial on Cursor**, and **fakeable at best on Copilot/Codex** (you call gh/codex CLI in a fresh shell and pray for context isolation). Cross-agent parity is the time sink.
- Tech-stack auto-detection from manifests (package.json, requirements.txt, Gemfile, go.mod, pom.xml, Cargo.toml...) is a weekend project for the happy path, a 2-week project once you handle monorepos, lockfile drift, and hybrid stacks.
- Context7 MCP is a thin HTTP API — the integration is small. The bundled fallback library is the time consumer (curating 20-50 tech-stack docs, freshness rules, size budget).

**Realistic**: **3-4 weeks**.

---

### WS10 — Universal Review System (2-3 weeks claimed)

**Reality**:
- 7 parsers (Greptile, CodeRabbit, Qodo, SonarCloud, GitHub Actions, Codex, human) = 7 mini-projects. Each tool changes its comment format every few months. Greptile and CodeRabbit have moderately stable shapes; SonarCloud has multiple comment shapes depending on plugin version; GitHub Actions has zero standard format and you parse log tails. Qodo (per the actual PR comment shown) emits HTML-in-markdown.
- NormalizedComment interface + actionability scoring is tractable (~3 days).
- Reply-and-resolve enforcement requires GraphQL `resolveReviewThread` (already used in `.claude/scripts/greptile-resolve.sh`), but extending to non-Greptile tools means each tool needs its own resolution semantics.
- Pre-flight checks + timing intelligence are small.

**Realistic**: **3-4 weeks**. The parsers are the time sink and require ongoing maintenance you should budget for separately.

---

### WS13 — Universal Guardrails (1-2 weeks claimed)

**Reality**: This is the most realistic estimate in the plan.
- Per-stage guardrails are mostly file-existence checks + JSON schema validation against `.forge/results/*.json`.
- Two-layer enforcement = built-in command + next-stage check. Both are <100 LOC each.
- The integration points are 11 commands × ~20 LOC of guardrail wiring each = ~220 LOC of plumbing.

**Realistic**: **1.5-2.5 weeks**, mostly because integrating into the *existing* commands while not breaking the tests already wired to them takes longer than greenfield.

---

## Top 5 Hidden Technical Risks

1. **Dolt connection lifecycle on Windows**. The plan assumes a single shared launcher solves divergence. In practice, when 4+ `bd` commands fire in <100ms (typical agent burst), you'll hit connection refused, stale lock files, and zombie `dolt sql-server` processes. Windows file locking makes recovery worse than Linux. Expect 1-2 weeks of stabilization that isn't in the estimate.

2. **GitHub secondary rate limits during agent bursts**. 20 mutations/min is ~1 every 3 seconds. A single `/dev` run that creates 5 tasks + closes 5 + adds 5 dep edges + relabels = ~20 mutations in <30 seconds. The queue with backoff helps, but the *user experience* of "your changes are pending sync" while another agent in another worktree is reading stale state is going to confuse users and burn debugging time.

3. **Bot comment dependency parsing fragility**. `<!-- forge-deps -->` blocks survive in raw markdown but: (a) GitHub's web editor occasionally re-flows whitespace inside HTML comments, (b) humans WILL edit them despite the warning, (c) any tool that round-trips through the issue body or comment can mangle them. You need a checksum + a recovery path. Plan acknowledges the risk; doesn't budget time for the recovery UX.

4. **Smart status performance at scale**. Scoring 1000 issues × 6 dimensions × every command invocation = noticeable lag without aggressive caching. Cache invalidation across worktrees with a daemon writing in the background is a classic source of "why is this stale?" bugs. Test against repos with 5k+ issues before claiming done.

5. **Cross-context "separate-context evaluator" on non-Claude agents**. Plan assumes the Anthropic generator/evaluator separation is portable. On Codex CLI and Copilot, "separate context" means spawning a new CLI invocation — which has different env, different MCP tools loaded, and no guarantee of the same model. You'll discover this in Phase 2 of WS1 and it'll force a per-agent compromise that wasn't planned.

---

## Top 5 Things That ARE Realistic and Should Ship as Planned

1. **WS13 Guardrails (1-2 weeks)**. Mostly plumbing into existing commands. Solid estimate.
2. **WS3 Component 4 — backend interface only**. 2-3 days is right if you resist building concrete adapters in v2.
3. **WS3 Component 3 — cloud-agent CLI adapter**. 1 week is realistic; the detection logic is small and the gh fallback is well-trodden.
4. **WS1 Phase 0 pre-work (1 week)**. Audit + agents-config completion + CI grep validation are well-scoped tactical wins. The agents directory already exists (9 plugin.json files) so completion ≠ greenfield.
5. **WS2 canonical YAML extraction (week 1 of WS2)**. Pulling shared structure out of the 11 existing command markdown files into YAML is mechanical and high-value.

---

## Specific Technical Concerns — Direct Answers

1. **Dolt rapid `bd` calls**: No connection pooling in beads today. Expect to need a small connection-reuse layer or to add `--server-pid` aware retries. **2-4 days hidden cost**.

2. **GitHub rate limits at 20 issues / 50 updates / 5 syncs per day**: That's ~75 mutations spread over hours — well under limits in steady state. **Burst is the problem**, not volume. Queue handles steady state fine; bursty workloads (a `/dev` run creating 10 tasks at once) need coalescing logic the plan mentions but doesn't size.

3. **Cross-platform Dolt**: Dolt runs on Windows but with known issues: file locking, port reuse after crash, slower startup. WSL is fine. Pure Windows native is the pain point. Budget Windows-specific debugging.

4. **Bot comment parsing**: Plan's mitigation (fenced blocks + tamper detection) is sound *if* you build the recovery UX. The plan doesn't size that (`forge issue dep repair` or similar). **3-5 days hidden**.

5. **Smart status perf**: 1000 issues with cached scores is fine (~50ms). Cold cache or invalidation storm during daemon-triggered re-score is where you'll see 500ms+ latency. Acceptable for a dashboard, painful if it gates other commands.

6. **EJS regeneration drift**: `scripts/sync-commands.js` (600 LOC today) is single-target and will need a full rewrite, not extension, to handle multi-format generation. **Don't reuse it; rewrite as `scripts/build-agents.js`**.

7. **Real-world sync conflicts**: Last-write-wins on status/priority is fine. The actual UX problem is "two agents both think they own task X." Need a soft-claim mechanism that's NOT in the current plan. **1-2 weeks if you discover this mid-build**.

8. **Existing forge code wired to bd (11 files, not 8)**: `lib/beads-health-check.js`, `lib/beads-setup.js`, `lib/beads-sync-scaffold.js`, `lib/commands/{plan,setup,sync,test,worktree,_issue}.js`, `lib/runtime-health.js`, `lib/workflow/state-manager.js`. Most stay as-is if the wrapper is truly thin. `lib/beads-setup.js` workarounds get deleted (good). `state-manager.js` will need touch-ups for the shared-launcher model.

---

## Overall Verdict

**Optimistic by ~50%.** Plan claims 12-14 weeks. Realistic for the same scope: **18-22 weeks** by a single experienced dev, or **14-16 weeks** with two devs splitting WS3 (one on sync layer, one on the Go fork).

**What this means for the user**:
- The Phase 1 increment (Foundation, claimed 4 weeks) is realistically **6-7 weeks**.
- Don't promise WS3 component 2 (sync layer) in under 4 weeks; it WILL slip.
- WS13 and WS1 Phase 0 are the safest places to start — ship them first to build credibility with the rest.
- Consider deferring "Component 5 fork beads" entirely to v3 unless a second dev owns it.

**Recommendation**: Re-baseline the plan to **16-20 weeks** with explicit buffer in WS3, OR cut scope: defer Component 5 (beads fork) and Component 2g (webhook) to v3, keep poll-only sync for v2. That gets you back to ~13-15 weeks honestly.
