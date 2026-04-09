# WS-2: Dual-Dispatch Model — Risk Inventory

> Generated: 2026-04-06
> Scope: All limitations, edge cases, and failure modes for internal and external dispatch in forge parallel task execution.

---

## A. Internal Dispatch Limitations

Internal dispatch = agent is main orchestrator, spawns subagents natively (Agent tool, Task tool, etc.).

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| A1 | **Parent blocks while subagents run** — Claude Code's Agent tool is synchronous; parent can't monitor, intervene, or show progress until all subagents complete | Medium | Certain | No | Accept for Claude Code. Document that progress is only visible after wave completes. Consider streaming logs to `.forge/logs/`. |
| A2 | **Filesystem race conditions** — Subagents share the working directory; concurrent edits to the same file cause data loss or corruption | Critical | Likely | Yes | **Worktree isolation per task** (each subagent works in its own git worktree). If tasks touch the same file, they MUST be in the same wave (sequential). Task list dependency graph must encode file-level conflicts. |
| A3 | **No inter-subagent communication** — Task 2 cannot observe task 1's output, intermediate state, or completion status | Medium | Certain | No | Design tasks to be fully independent within a wave. Cross-task dependencies must be in separate waves. Shared state only via committed files between waves. |
| A4 | **Limited subagent context** — Subagent doesn't inherit parent's full conversation history; only gets the prompt provided at spawn time | Medium | Certain | No | Forge must generate a self-contained task prompt including: design doc excerpt, relevant file paths, test expectations, coding conventions. Parent passes this as the subagent's initial prompt. |
| A5 | **Straggler problem** — One subagent takes 10x longer than others; entire wave blocks on the slowest task | High | Likely | No | Per-subagent timeout (configurable, default 10 min). If timeout fires: kill straggler, mark task as failed, continue wave with partial results. User decides whether to retry or skip. |
| A6 | **Subagent crash / rate limit / timeout** — Subagent hits API rate limit, crashes mid-task, or times out silently | High | Likely | No | Retry policy: 1 automatic retry per task. After retry failure, mark task `failed` in task list with error details. Don't block the wave — other tasks continue. Report failures in wave summary. |
| A7 | **Token cost amplification** — Each subagent burns its own context window; N parallel tasks = N x full context cost | Medium | Certain | No | Document cost implications. Recommend max 3-4 parallel subagents. Provide `--max-parallel N` flag. Use cheaper models for subagents if agent supports mixed-model dispatch. |
| A8 | **Practical concurrency ceiling** — Claude Code supports ~5 concurrent Agent calls; other agents may support fewer or zero | Medium | Certain | No | Agent capability matrix must document max subagent count per agent. Forge auto-caps parallelism to agent's limit. Fall back to sequential if limit is 1 or 0. |
| A9 | **Circular dispatch** — Subagent calls `forge dev` which tries to dispatch internally again, creating infinite recursion | Critical | Possible | Yes | **Environment variable guard**: when forge spawns a subagent, set `FORGE_SUBAGENT=1`. If `forge dev` is called with `FORGE_SUBAGENT=1`, execute task directly (no dispatch). Subagents run `forge dev --task <id>` which executes a single task, never dispatches. |
| A10 | **Heterogeneous subagent semantics** — Agent tool (Claude), Task tool (Kilo), async dispatch (Cursor) all have different APIs, return formats, and error handling | High | Certain | No | Abstract behind `dispatch.internal(agent, tasks)` interface. Each agent adapter implements: `spawn(prompt) -> handle`, `await(handle) -> result`, `cancel(handle)`. Forge ships adapter per supported agent. |
| A11 | **Nested subagent spawning** — Subagent tries to spawn its own subagents; may not be supported, or causes exponential process explosion | Medium | Possible | No | **Forbid nested dispatch**: subagent prompt must include `FORGE_SUBAGENT=1` context. Forge task runner in subagent mode skips dispatch entirely. Document that nested parallelism is not supported. |
| A12 | **Result collection and structured output** — Parent needs structured results (pass/fail, files changed, test results) from each subagent, but subagent output is free-form text | High | Certain | No | Define a result contract: each subagent writes `.forge/results/<task-id>.json` with schema `{ taskId, status, filesChanged[], testsPassed, errors[], commitSha }`. Parent reads these files after wave completes. |

---

## B. External Dispatch Limitations

External dispatch = forge CLI is main orchestrator, spawns N independent agent processes.

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| B1 | **Agent binary discovery** — Forge must know which binary to invoke (`claude`, `codex`, `cursor`, `kilo`, `opencode`, `gh copilot`); not all are CLI-invocable | Critical | Certain | Yes | Agent registry maps agent name to spawn command. Only agents with CLI/headless mode are supported for external dispatch. Forge probes at startup: `which claude`, `which codex`, etc. Fail fast if binary not found. |
| B2 | **Headless mode support** — Cursor, Kilo Code, and OpenCode require an IDE; they cannot run as headless CLI processes | Critical | Certain | Yes (for these agents) | External dispatch is only available for agents with headless CLI: Claude Code (`claude --print`), Codex (`codex --quiet`), GitHub Copilot CLI. IDE-bound agents must use internal dispatch or sequential fallback. Document this clearly in agent matrix. |
| B3 | **Authentication per process** — Each spawned agent process needs valid API credentials; credentials may not be available in all environments (CI, containers) | High | Likely | No | Require credentials to be configured before `forge dev --parallel`. Forge pre-flight checks auth for the target agent. For CI: document required env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). |
| B4 | **Task context injection** — Spawned processes need the task description, design doc, file list, and conventions; how is this passed? | High | Certain | No | Write task prompt to `.forge/tasks/<task-id>.md`. Spawn agent with: `claude --print < .forge/tasks/<task-id>.md` or equivalent per agent. Agent reads task file as its initial prompt. |
| B5 | **Process lifecycle management** — PID tracking, timeout enforcement, graceful kill, zombie cleanup on Windows and Unix | High | Likely | No | Use Node.js `child_process.spawn` with PID tracking. Store PIDs in `.forge/pids/`. Implement: timeout kill (SIGTERM then SIGKILL), cleanup on forge exit (process.on('exit')), orphan detection on next forge run. Windows: use `taskkill /PID`. |
| B6 | **No prompt caching across processes** — Each process starts a fresh API session; no shared prompt cache; costs N x full context | Medium | Certain | No | Accept as inherent cost. Mitigate by keeping task prompts minimal (only task-relevant context, not full design doc). Document cost multiplier in `forge dev --parallel` help text. |
| B7 | **Result aggregation** — Forge needs to know when all processes complete and collect their results into a unified report | High | Certain | No | Same contract as A12: each process writes `.forge/results/<task-id>.json`. Forge polls for result files + monitors process exit codes. Timeout: if process exits without writing result file, mark task as `errored`. |
| B8 | **Partial failure handling** — One process fails; should others be killed, or continue? | Medium | Likely | No | Default: continue other tasks (fail-open per wave). Option `--fail-fast`: kill remaining tasks on first failure. Always report which tasks succeeded/failed in wave summary. |
| B9 | **Resource exhaustion** — N agent processes x memory/CPU can overwhelm the machine; Claude Code ~500MB per process | Medium | Possible | No | Default `--max-parallel 3`. Forge checks available memory before spawning. Warn if spawning would exceed 80% memory. User can override with `--max-parallel N`. |
| B10 | **Filesystem conflicts without worktrees** — Even separate processes share the same working directory by default; concurrent git operations corrupt the index | Critical | Certain | Yes | **Mandatory worktree isolation for external dispatch**. `forge dev --parallel` must create one worktree per task. Each process is spawned with cwd set to its worktree. Results merged back via git after wave completes. |
| B11 | **Worktree overhead** — Creating N worktrees, merging N branches, cleaning up — adds significant time and complexity | Medium | Certain | No | Worktree creation is fast (< 2s each). Merge uses `git merge --no-ff` per task branch into feature branch. Conflict resolution: if merge conflicts, mark task as `needs-manual-merge`. Cleanup in `forge clean`. |
| B12 | **Agent output capture** — Different agents output results differently (stdout, files, git commits); forge must normalize | High | Certain | No | Standardize: each agent adapter defines how to extract results. For CLI agents: capture stdout + check for `.forge/results/<task-id>.json`. For commit-based agents: diff the worktree branch against base. |
| B13 | **Cost: N separate API sessions** — No shared context across processes; each pays full prompt cost; can be 5-10x more expensive than internal dispatch | Medium | Certain | No | Document cost comparison: internal dispatch (shared parent context, cheaper) vs external dispatch (isolated, more expensive). Recommend internal dispatch for cost-sensitive workflows. |

---

## C. Entry-Point Ambiguity

How forge determines whether it's being called BY an agent (should return data) or BY a user (should orchestrate).

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| C1 | **Agent vs user detection** — Forge can't reliably distinguish `agent calls forge dev` from `user runs forge dev in terminal` | Critical | Certain | Yes | **Explicit flag**: `forge dev` (user mode, forge orchestrates) vs agent reads task list and dispatches natively. Agent adapters call `forge dev --task <id>` for single-task execution. Environment detection as secondary signal: `CLAUDE_CODE`, `CODEX_SANDBOX`, `CURSOR_TRACE_ID`. |
| C2 | **Double dispatch loop** — Agent calls `forge dev` → forge detects agent → forge tries to tell agent to dispatch → agent calls `forge dev` again | Critical | Likely | Yes | **Clear contract**: when called by an agent, `forge dev` returns the task list as structured data (JSON to stdout). The agent is responsible for dispatching. Forge never spawns agents when called by an agent. Guard: `FORGE_SUBAGENT=1` env var prevents any dispatch. |
| C3 | **Dual entry point in IDE** — User runs `forge dev --parallel` in Cursor's integrated terminal; Cursor also detects forge and tries internal dispatch | Medium | Possible | No | Document: external dispatch via terminal and internal dispatch via agent are mutually exclusive. If `CURSOR_TRACE_ID` is set, `forge dev --parallel` warns and exits: "Use Cursor's agent mode for parallel dispatch, or run in a standalone terminal." |
| C4 | **Mode selection UX** — User doesn't know whether to use internal or external dispatch; no clear guidance | Medium | Likely | No | `forge dev` auto-selects: if running inside a supported agent (env var detected) → return task list for internal dispatch. If running in bare terminal → external dispatch. `--internal` and `--external` flags for explicit override. |

---

## D. Cross-Model Coordination

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| D1 | **Model selection for external dispatch** — Forge spawns agent processes, but which model does each use? User's default? Cheapest? | Medium | Certain | No | External dispatch uses the agent's configured default model. No model override from forge. Document: "spawned agents use their default model configuration." Future: `--model` flag per task in task list. |
| D2 | **Mixed-model quality variance** — Internal dispatch subagents might use a different (cheaper) model than parent; quality of task output varies unpredictably | Medium | Possible | No | Forge doesn't control model selection for internal dispatch — the agent does. Document recommendation: use same model tier for all tasks in a wave. Agent adapters can pass model preference if agent supports it. |
| D3 | **Rate limits are per-model/per-key** — N parallel subagents (internal) or N processes (external) all hit the same API key's rate limit simultaneously | High | Likely | No | Stagger dispatch: don't spawn all N simultaneously; add 2-3 second delay between spawns. Implement backoff in task runner. `--max-parallel` caps concurrency. Document: high parallelism requires higher rate limit tier. |
| D4 | **Model-specific behavioral differences** — Same task prompt produces different code patterns from Opus vs GPT-5.4 vs Gemini; merging becomes harder | Low | Possible | No | Task prompts include project coding conventions explicitly. Code review step in `/validate` catches style drift. Not a dispatch-level concern — mitigated by existing quality gates. |

---

## E. State Management

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| E1 | **SQLite concurrent writes** — N parallel tasks update forge-issues (SQLite) simultaneously; SQLite doesn't handle concurrent writers well | High | Likely | No | **WAL mode** (Write-Ahead Logging) for SQLite — allows concurrent reads + serialized writes. Alternatively: only the orchestrator writes to forge-issues; subagents write to `.forge/results/<task-id>.json`; orchestrator aggregates after wave. |
| E2 | **Git merge conflicts from parallel tasks** — N tasks commit to N worktree branches; merging all back into feature branch causes conflicts | High | Likely | No | Task list dependency graph must ensure parallel tasks touch disjoint file sets. If overlap detected at planning time, serialize those tasks. Post-wave merge: attempt auto-merge; on conflict, mark task as `needs-manual-merge` and report to user. |
| E3 | **Handoff artifact contention** — N tasks all try to write `.forge/handoff/dev.json` simultaneously | Medium | Possible | No | Subagents don't write handoff artifacts. Only the orchestrator (parent agent or forge CLI) writes `dev.json` after collecting all task results. Subagents write to `.forge/results/<task-id>.json` only. |
| E4 | **Beads/forge-issues concurrent updates** — N agents update the same Beads issue simultaneously (status, comments) | Medium | Possible | No | Same as E1: only orchestrator updates Beads. Subagents report status via result files. Orchestrator does a single `bd update` per task after wave completes. |
| E5 | **Progress tracking** — Orchestrator needs real-time (or near-real-time) progress: "task 3 of 5 done" | Medium | Certain | No | **File-based signaling**: each task writes `.forge/progress/<task-id>.status` (`running`, `passed`, `failed`). Orchestrator polls these files (or uses fs.watch). For internal dispatch (blocking): progress only available after wave completes. |

---

## F. Testing and Debugging

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| F1 | **Testing parallel dispatch** — Hard to write deterministic tests for concurrent behavior; timing-dependent failures | High | Certain | No | Mock agent adapters that simulate task execution with configurable delays/failures. Integration tests use `--max-parallel 1` (sequential) for determinism. Separate parallel-specific tests with retry tolerance. |
| F2 | **Reproducing parallel failures** — A failure that only occurs under parallel execution is hard to reproduce | High | Likely | No | Log everything: each task gets its own log file at `.forge/logs/<task-id>.log`. Include timestamps, file operations, git operations. `forge dev --parallel --verbose` enables detailed logging. |
| F3 | **Debugging a failed subagent** — Subagent fails mid-task; parent only sees the final error, not the chain of reasoning | Medium | Likely | No | Require subagents to write incremental progress to `.forge/logs/<task-id>.log`. For internal dispatch: capture subagent's full output in result object. For external dispatch: redirect stdout/stderr to log file. |
| F4 | **Log distinguishability** — Logs from N parallel agents interleave; hard to trace which agent did what | Medium | Certain | No | Prefix all log lines with `[task-<id>]`. Separate log files per task. Summary log aggregates key events in chronological order with task attribution. |
| F5 | **Tracing file changes per subagent** — After parallel wave, hard to know which subagent changed which file | Medium | Likely | No | Worktree isolation makes this trivial — each worktree branch shows its own diff. For internal dispatch without worktrees: use git stash/commit boundaries per task. |

---

## G. Graceful Degradation

| # | Risk | Severity | Likelihood | Blocker | Mitigation |
|---|------|----------|------------|---------|------------|
| G1 | **Agent doesn't support subagents** — Some agents have no subagent/task tool; internal dispatch impossible | Medium | Certain | No | **Automatic fallback to sequential**. Agent capability matrix checked at dispatch time. If `canSpawnSubagents: false`, execute tasks sequentially within the agent. Log: "Parallel dispatch not available for [agent]; executing sequentially." |
| G2 | **External dispatch binary not found** — `forge dev --parallel` can't find the agent CLI binary | Medium | Possible | No | Pre-flight check at `forge dev --parallel` start. If binary not found: "Agent CLI not found. Install [agent] or use internal dispatch." Fall back to sequential if no external dispatch possible. |
| G3 | **Worktree creation fails** — Disk full, git corruption, path too long (Windows 260-char limit) | Medium | Possible | No | Catch worktree creation errors. Fall back to sequential execution in the main working directory. Warn: "Worktree creation failed; falling back to sequential execution. Parallel tasks may conflict." |
| G4 | **Rate limit hit mid-wave** — After spawning 4 tasks, rate limit blocks tasks 3 and 4 | High | Possible | No | Exponential backoff per task. If rate limit persists after 3 retries, pause remaining tasks. Complete already-running tasks. Report: "2 of 4 tasks completed; 2 paused due to rate limit. Re-run `forge dev` to continue." |
| G5 | **Max parallelism configuration** — Users need control over how many parallel tasks run | Low | Certain | No | `--max-parallel N` flag (default: 3). Config in `.forge/config.json`: `{ "parallel": { "maxConcurrency": 3 } }`. Respect agent-specific limits from capability matrix. |
| G6 | **Partial wave completion** — 3 of 5 tasks complete, 2 fail; wave is partially done | Medium | Likely | No | Merge completed tasks' results. Mark failed tasks as `pending` for next wave (or retry). Don't block subsequent waves that don't depend on failed tasks. Report clear status: "Wave 1: 3/5 passed, 2 failed [task-4, task-5]. Wave 2 can proceed (no dependencies on failed tasks)." |

---

## H. Summary: Critical Blockers

These risks **must be resolved before implementation**:

| Risk | Description | Required Resolution |
|------|-------------|-------------------|
| A2 | Filesystem race conditions (internal) | Worktree isolation or file-disjoint task validation |
| A9 | Circular dispatch (subagent calls forge) | `FORGE_SUBAGENT=1` env var guard |
| B1 | Agent binary discovery (external) | Agent registry with spawn commands |
| B2 | Headless mode not supported by IDE agents | External dispatch limited to CLI agents; document clearly |
| B10 | Filesystem conflicts without worktrees (external) | Mandatory worktree isolation for external dispatch |
| C1 | Agent vs user detection | Explicit flags + env var detection |
| C2 | Double dispatch loop | Clear contract: forge returns data to agent, never spawns when called by agent |

## I. Recommended Architecture Decisions

Based on this risk analysis:

1. **Worktree isolation is non-negotiable** for both dispatch models when tasks touch different files. Tasks modifying the same file must be serialized.

2. **Result contract via files** (`.forge/results/<task-id>.json`) is the universal integration point — works for both internal and external dispatch, all agents.

3. **Environment variable guards** (`FORGE_SUBAGENT=1`, `FORGE_DISPATCH_MODE=internal|external`) prevent circular dispatch and clarify entry points.

4. **Agent capability matrix** drives dispatch decisions — forge never attempts a dispatch mode the agent can't support.

5. **External dispatch is CLI-agent-only** — IDE-bound agents (Cursor, Kilo, OpenCode) use internal dispatch exclusively.

6. **Sequential fallback is always available** — parallel dispatch is an optimization, never a requirement. Every workflow must work sequentially.

7. **Orchestrator-only state writes** — subagents/processes never write to forge-issues, Beads, or handoff artifacts directly. Only the orchestrator aggregates and writes.
