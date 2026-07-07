# Forge Kernel Agent + Skill Surface — Design (PR-A)

**Date:** 2026-06-19 · **Status:** proposed · **Baseline:** origin/master @ #221
**Method:** grounded by a 6-agent workflow (4 parallel readers → synth → adversarial critique). Critique defects are folded in below.

## 1. Principle

The **kernel surface** is an independent category of agent-facing skills + agents for **issue and memory operations**, distinct from the **7 stage skills** (`plan/dev/validate/ship/review/premerge/verify`). Stage skills drive the TDD ladder; kernel skills are the day-to-day verbs — find work, claim, fix in place, query the board, persist/recall memory. Rules:

1. **Skills + agents only — NO command files** (2026-06-19 direction). The kernel surface is built exclusively from `SKILL.md` files and agent files. We do **not** author Claude slash-commands (`.claude/commands/`) or top-level `commands/`. Each skill is short markdown telling the agent to run an existing `forge` CLI command via Bash — thin wrapper, no reimplementation (mirrors Beads' `Bash(bd:*)` skills). The `forge` CLI remains the *implementation*; skills/agents are the *only* agent-facing surface. The 7 existing stage commands also migrate to skills (see §6).
2. **"Exists vs must-build" tracks the CLI, not the file.** No kernel command/skill files exist today (the 11 `.claude/commands/` files are all stage commands), so every file here is new authoring. What varies is whether the wrapped `forge` command exists. `lib/project-memory.js` + `lib/memory/typed-api.js` exist but are **orphaned from the CLI** — `forge remember` does NOT exist yet.
3. **Canonical source is the neutral `.skills/` registry — NOT `.claude/`.** (Revised 2026-06-19 per design review.) Forge already ships the `@forge/skills` CLI (`packages/skills/`) whose single source of truth is the harness-neutral `.skills/` directory (`.skills/.registry.json` exists today). `skills sync` fans each `SKILL.md` out to **claude (.claude), codex (.codex), cursor (.cursor), and hermes (.hermes)** — no harness is "main." Kernel skills are therefore authored once in `.skills/<name>/SKILL.md` and synced everywhere, which also makes them **real auto-surfacing skills** (like the Beads plugin), not bare slash-commands. `.claude/` was only the de-facto canonical for the *7 stage slash-commands* via `sync-commands.js` (historical: Claude Code is the dev harness); the kernel surface does not inherit that.

## 2. Skill taxonomy (4 families)

`EXISTS` = `forge` command implemented today (skill ships immediately). `MUST BUILD` = CLI must be implemented first.

### A — Issue Lifecycle (the core agent loop)

| Skill | Wraps | CLI |
|---|---|---|
| ready / show / list / create | `forge ready` / `show <id>` / `list` / `create` | EXISTS |
| claim / release-claim | `forge claim <id>` / `forge release <id>` | EXISTS |
| update / comment / close | `forge update` / `comment` / `close` | EXISTS |
| dep / search / stats | `forge issue dep add\|remove` / `issue search` / `issue stats` | EXISTS |
| blocked | `forge blocked` | **MUST BUILD** — add read alias in `_issue.js` SUBCOMMANDS (filter `blocked===true`) + `issue.blocked` in `issue-command-contract.js` |
| epic | `forge epic` | **MUST BUILD** — `epic` is a type today, no roll-up command |

### B — Memory / Knowledge (mirrors `bd remember`/`bd memories`)

| Skill | Wraps | CLI |
|---|---|---|
| remember | `forge remember "<insight>"` | **MUST BUILD** — see §5 (signature + provenance + roadmap caveat) |
| recall | `forge recall <query\|key>` | **MUST BUILD** |
| knowledge-search | `forge knowledge search <q>` | **MUST BUILD (LAST)** — gated on FTS5 knowledge-index MVP (does not exist) |

### C — Board / Planning / Admin

| Skill | Wraps | CLI |
|---|---|---|
| board / export / release-check | `forge board` / `forge export [--import]` / `forge release check --target` | EXISTS |
| sync | `forge sync` | EXISTS — *(was missing in first draft; zero-cost, add to Wave 1)* |

> One `export` skill documents both export and `--import` (no separate `forge import` command exists).

### D — Orientation / Session (mirrors `bd prime`)

| Skill | Wraps | CLI |
|---|---|---|
| prime / orient / recap | `forge prime` / `forge orient` / `forge recap [issue]` | EXISTS |

**Explicitly out of scope** (Beads has, Forge won't mirror now, with reason): `label` (use issue fields), `compact`/`restore` (kernel keeps full history, no JSONL compaction), `delete` (use `close`/cancel), `reopen` (= `forge update --status open`), `audit`-interaction-logging (NOTE: `forge audit` already exists as lockfile verification — **name collision**, do not reuse).

## 3. Agents (`.claude/agents/`)

Forge agent frontmatter convention (`.claude/agents/command-grader.md`) = `name` + `description`. Add `tools`/`model` (Claude Code honors them).

- **`kernel-task-agent.md`** — autonomous: `forge ready` → `claim` → `recap <id>` → implement (Read/Edit/Write) → `comment` → `close`; `release` if abandoning; one issue at a time. `tools: Bash(forge:*), Read, Edit, Write, Grep, Glob`.
- **`kernel-surface-guide.md`** — orientation/teaching: forge-issues-vs-TodoWrite decision table, session protocol, memory model. `tools: Bash(forge:*), Read`.

> **Open verification:** confirm subagent `tools:` accepts scoped `Bash(forge:*)` (vs bare names) against `plugin-dev:agent-development` — if not, the CLI restriction isn't enforced. Agents are **not** synced by `sync-commands.js` (Claude-Code-only for v1; accept, like Beads' single agent).

## 4. Umbrella skill (critique fix #2 — the biggest miss)

Add a **real, auto-surfacing** umbrella skill `.skills/kernel/SKILL.md` (neutral registry) following the structure of an existing skill such as `skills/hermes-forge/SKILL.md` (Beads is a plugin/adapter, not a `skills/` entry): full frontmatter (`name: kernel`, `description`, `allowed-tools: Read, Bash(forge:*)`), body = decision table + session protocol + the 4-family command index. `skills sync` then propagates it to `.claude/skills/`, `.codex/skills/`, `.cursor/`, `.hermes/`. This is the skill that makes the surface discoverable — the per-skill files below are also `.skills/<name>/SKILL.md`, not bare slash-commands.

## 5. Memory: close the loop (critique fixes #3)

- **`forge remember` signature must satisfy the libs:** `project-memory.js write()` needs `key + value + sourceAgent`; `typed-api.js writeTyped()` needs provenance `{actor, reason, source}`. The command synthesizes `key` (slug of insight or `--key`), `sourceAgent` (from env/session), and provenance — never just a bare string.
- **Recovery loop:** today `prime`/`orient`/`recap` are deterministic file-assembly and read **zero** memories, so `remember` would be write-only. Fix: the SessionStart/PreCompact hook (and `recap`) must **re-inject stored memories**, or recall is manual and the cross-session promise fails.
- **Roadmap caveat:** D14/D16 target Beads retirement. Do **not** wire `remember`/`recall` onto `bd remember/memories` as a new Beads dependency — back them with the kernel event/KnowledgeStore path (proposals + provenance, not authority, per D3).

## 6. Packaging & sync — neutral `.skills/` via the Skills CLI (revised)

**Source of truth = `.skills/`** (neutral registry), synced by the `@forge/skills` CLI:
```bash
skills create kernel-ready   # or author .skills/<name>/SKILL.md directly + register
skills sync                  # fan out to .claude/.codex/.cursor/.hermes (detectAgents)
skills sync --check          # drift gate for CI
```
`packages/skills/src/commands/sync.js` reads `.skills/` (priority) + root `skills/`, and `detectAgents()` targets any present `.claude/.codex/.cursor/.hermes` dir. No harness is canonical; adding Hermes is automatic once `.hermes/` exists.

**Naming convention to avoid the two-systems collision.** Both the Skills CLI and `sync-commands.js` write into `.codex/skills/<name>/`. To prevent a kernel skill clashing with a stage slash-command, **prefix kernel skill names** (e.g. `kernel-ready`, `kernel-remember`) or keep them in a dedicated registry subtree. Audit: none of the 18 wrapped commands currently collide with the 11 stage command basenames, but the prefix future-proofs it and makes the "separate surface" real in the filesystem.

**Codex adapter caveat (carried over):** `sync-commands.js`'s Codex path injects a bare `forge <basename>` header. The Skills-CLI path (`cpSync` of `SKILL.md`) does **not** inject that, so authoring kernel skills via `.skills/` *sidesteps* the `dep`/`search`/`stats`/`release-claim` mismatch bug entirely — another reason to use the neutral registry. (If any kernel command is *also* exposed as a stage-style slash-command via `sync-commands.js`, the basename→invocation map fix still applies there.)

**Remove the Claude command surface entirely** (2026-06-19 direction — "totally remove claude command"). The 7 stage commands (`.claude/commands/{plan,dev,validate,ship,review,premerge,verify}.md` + utilities) are converted to `.skills/` SKILL.md entries; then `.claude/commands/`, the generated `.cursor/commands/` and `.codex/skills/` *command* outputs, and `scripts/sync-commands.js` (+ its tests/CI drift gate) are **deleted**. After migration the Skills CLI (`.skills/` → `skills sync`) is the *only* surface generator — one mechanism, not two. This is **PR-A0**, sequenced first so the kernel skills land into a single clean surface. (Update `CLAUDE.md`'s "after editing `.claude/commands/*.md` run sync-commands.js" rule accordingly.)

## 7. Prime/session hook

Forge has no `plugin.json`; adapt into existing `.claude/settings.json` (currently PreToolUse-only): add `SessionStart` + `PreCompact` hooks running `forge prime`. **Verify `forge` is on PATH in the hook shell** (Beads uses global `bd`; Forge may need `bunx forge`/`node bin/forge.js`). Claude-Code-only; Codex/Cursor priming is separate.

## 8. Build sequence

> **SUPERSEDED — see the "Combined build sequence" table at the end of this doc, and the authoritative cross-cutting ordering in [canonical-backlog.md](canonical-backlog.md) (items K0–K13).** This early Wave 1–4 sketch omitted L0 (worktree hooks) and A0 (command removal) and is kept only for the per-skill detail (which EXISTS skills ship first). For "what to build in what order," use the canonical backlog; for the hooks/unique-feature detail, use §9/§10 + the Combined table below.

## Decisions locked (2026-06-19, user-confirmed "yes for all")
- **Surface = skills + agents only. No commands anywhere.** Claude command surface removed entirely (PR-A0): the 7 stage commands → skills; `.claude/commands/` + generated command outputs + `scripts/sync-commands.js` deleted. (Interpreting "neutralize stage commands" as → skills, per the stronger "totally remove command" directive — not a neutral `commands/` dir.)
- **Canonical source = neutral `.skills/` registry**, synced by the `@forge/skills` CLI to `.claude/.codex/.cursor/.hermes`. No harness is "main."
- **Agents sync to all harnesses.** Extend the `@forge/skills` CLI with an agent-sync pass (neutral agent source → `.claude/.codex/.cursor/.hermes`), not Claude-only.
- **Forge-unique capabilities get their own surface.** Beyond Beads parity, Forge has features Beads lacks (DB-enforced claim leases, JSONL portability, conflict quarantine/evaluators, readiness read-model, planning buckets, taxonomy validation, knowledge/orient/recap, federation memory, release-readiness gate). These need their own properly-designed skills/agents — see §10 (designed via workflow).

## Open questions for the user
1. **`remember`/`recall` backing:** kernel-event/KnowledgeStore (roadmap-aligned, since D14/D16 retire Beads) — confirmed over reusing `bd remember`? (§5)
2. **MCP timing:** confirmed as a later surface (read-only first, after Beads retirement underway) per `PD-20260606-readonly-mcp-first` — or pull earlier, parallel with skills?

## §9 — Harness-neutral hooks surface

Designed via grounded workflow (existing hooks + per-harness mechanisms) with an adversarial critique pass; blocking fixes folded in. Hooks honor the **observer/evidence rule** (record evidence/proposals, never silently mutate authority — `PD-20260606-observer-evidence-proposals`) and the **no-bypass rule** (no `LEFTHOOK=0`/`--no-verify`).

### 9.1 Kernel hook set

| Hook | Event | Runs | Observer status |
|---|---|---|---|
| H1 prime-on-start | SessionStart | `forge prime --json`, inject as context | READ-only |
| H2 recap-on-compact | PreCompact | `forge recap --json --budget N`, re-inject | READ-only |
| H3 export-on-stop | Stop / SessionEnd | run `forge export` (derived projection); **print** a `forge sync` reminder — never auto-sync | COMPLIANT (export=derived; sync=deliberate) |
| H4 guard-on-tooluse | PreToolUse | command guard (blocks `gh pr merge`, `rm -f`, `git reset --hard`, force/main push, `LEFTHOOK=0`, `--no-verify`) + protected-state guard on Write/Edit | COMPLIANT (denies, never writes) |

**Load-bearing decision:** H3 splits `export` (derived read-model → allowed in a background hook) from `sync` (pushes git/Dolt authority → reminder only). No hook silently pushes authority.

### 9.2 Per-harness support (verification-honest)
- **Claude Code** ✅ fully verified — all 4 hooks ship today.
- **Codex** ⚠️ events confirmed (PascalCase `[hooks]`, `commandWindows`); no `SessionEnd` → map to `Stop`; handler field names beyond `command` unverified.
- **Cursor** ⚠️ `.cursor/hooks.json` `{version,hooks}`, camelCase; **no Bash-matcher PreToolUse** → H4 splits to `beforeShellExecution` + `afterFileEdit`. Re-confirm schema before building the writer.
- **Hermes** ❓ **no documented hook mechanism; do not wire — explicit gap, never fabricated.**
  - **CORRECTION (2026-07-07):** this was wrong. Hermes (NousResearch Hermes Agent) DOES have a native hook surface — shell hooks in the `hooks:` block of the GLOBAL `~/.hermes/config.yaml`, where a `pre_tool_call` hook can DENY a tool call (it even accepts Claude's `{decision:block}` shape). See capability-matrix source **S16** and `renderHermesHooksYaml` (lib/hook-renderer.js). It is `not-delivered` (not `unsupported`): the surface is real but global-config-scoped, so `forge setup` cannot write it project-locally — same constraint as Codex. Rendered + tested for a global-config follow-up (epic `90f2f631`).

### 9.3 Neutral source + sync (parallel to skills sync)
Neutral source = **`.skills/hooks.json`** (canonical PascalCase, includes both `Stop` and `SessionEnd` keys so H3 maps correctly). New CLI subcommand **`skills sync-hooks`** with **format-aware writers, NOT `cpSync`** (cpSync whole-dir copy is wrong for merged config files):
- Extend `AGENT_DEFINITIONS` (agents.js) with a `hooksTarget` descriptor (reuses the vestigial dead `configFile` slot) — **and add the matching projection line in `detectAgents` (`if (agent.hooksTarget) entry.hooksTarget = …`)**, else writers receive `undefined` (critique fix #3).
- Serializers: `json-merge` (Claude `.claude/settings.json` — **deep-merge**, preserves existing `permissions`/`env`/`enabledPlugins`/H4 guard), `toml-merge` (Codex `config.toml`), `json-write` (Cursor `.cursor/hooks.json`, applies the PreToolUse split), Hermes → `null` skip.
- **Per-harness guard I/O (critique fix #1, blocking):** H4 is **not** one verbatim script — Claude blocks via `process.exit(2)`, Cursor via JSON-on-stdout, Codex via its handler contract. Each harness gets a guard adapter speaking its block protocol, or the no-bypass guarantee fails-open on non-Claude.
- **PATH resolver (critique fix #2, blocking):** no committed absolute paths (trips the repo's path-leak gate); use a per-harness project-dir env var. **Fail-loud** "forge not found" — drop the `|| bunx forge` auto-fetch (supply-chain risk) and the `2>/dev/null` on the guard (a silent guard failure = a silent bypass).
- **D11 (critique fix #5):** assert `.forge/kernel/` is gitignored **or** `forge export` output is byte-stable, else per-Stop export dirties the tree = release-blocking.
- Idempotent + `--dry-run`; ship Claude first, gate Cursor/Codex on schema re-confirmation.

### 9.4 Git-hook installation — worktree-proof via `core.hooksPath` (Hermes enforcement path)

§9.1–9.3 cover **agent-runtime** hooks (push-injection, harness-specific). This sub-section covers the **git-lifecycle** hooks (`pre-commit`/`pre-push`) — the enforcement + export backstop that **every** harness inherits, including Hermes (per the decision to use Lefthook on Hermes). It must install reliably in **worktrees**, which it currently does not.

**Verified problem (root cause).** `core.hooksPath` is **unset**; `lefthook install` writes shims into `$GIT_DIR/hooks`. For a *linked worktree*, `git rev-parse --git-path hooks` resolves to `.git/worktrees/<name>/hooks` — a separate dir the main install never populated, and `forge worktree create` doesn't re-run install there. Result: a worktree silently has **no hooks**, so `forge push` can falsely claim local gates passed. (Tracked: `worktree-hook-lint-install.md`. Note: the Husky→Lefthook migration deliberately *unset* `core.hooksPath` — this section re-adopts it on purpose.)

**Fix — keep Lefthook, change how it's wired:** set **`core.hooksPath` → tracked `.forge/hooks/`** at the **git-common-dir** config level, where each hook file delegates to `lefthook run <pre-commit|pre-push>`. Why this is strictly better than per-worktree `lefthook install`:
- `core.hooksPath` is read from **shared git config → every worktree inherits it automatically.** One setting, zero per-worktree install — the failure mode disappears.
- The hooks dir is **version-controlled + harness-agnostic** → Hermes/Codex/Cursor enforcement+export all covered with no native hook surface needed.
- **Lefthook orchestration is preserved** (parallel commands, skip conditions, the `forge push` token-skip) — the dispatcher just calls into it. This is "stop relying on per-worktree shim install," not "replace Lefthook."

**Supporting work (self-hosting lifecycle):**
- `forge setup` sets `core.hooksPath` at common-dir level; `forge worktree create` verifies/sets it for new worktrees.
- **`forge hooks doctor --json`** (per the tracked issue): checks `core.hooksPath`, common-dir vs linked-worktree hooks, Lefthook binary, lint availability; with `forge hooks install/sync` repair (`--dry-run` supported, Windows/MSYS + POSIX safe).
- **`forge push`/`forge validate` refuse to claim local gate coverage** when hooks aren't active in the current worktree — no more false-green pushes.

Alternatives considered: (2) keep default install + re-run `lefthook install` per worktree — works but stays fragile; (3) pure native git hooks, drop Lefthook — smaller footprint but loses parallelism/skip/token features. `core.hooksPath`+Lefthook (above) is the recommended balance.

## §10 — Forge-unique feature surface (beyond Beads parity)

> **Honesty caveat (load-bearing):** the Kernel is **dormant by default** — `lib/forge-issues.js` `createIssueService` (line 302; line 298 is `shouldUseKernelBroker`) routes issue ops to **Beads** unless `issueBackend=kernel`; the only live Kernel consumer is `forge export`. So `kernel-ready`/`kernel-claim` wrap CLI that delegates to Beads today; lease/readiness *enforcement* exists but is internal+dormant. We surface the **verbs** (the durable agent seam), not a claim that kernel enforcement is live.

Capabilities split **three ways** (avoids over-surfacing):

### 10A — Surface now (live CLI, thin skills)
`kernel-ready` (`forge ready --json` — derived 8-state readiness, ranked by `priority_rank`), `kernel-claim` (`forge claim/release <id>` — DB-enforced lease; CLI handles revision+idempotency invisibly), `kernel-board` (`forge board --json`), `kernel-orient` (`forge orient/prime/recap`), `kernel-export` (`forge export`), `kernel-release-check` (`forge release check --target`), `kernel-migrate` (`forge migrate --dry-run`, preview-only). *Note: `recommend.js` is tool/plugin recommendation, NOT next-work.*

### 10B — Must-build (agent-relevant, no CLI yet)
- `kernel-remember`/`kernel-recall` — wire `lib/memory/typed-api.js`; provenance-enforcing (actor/reason/source + category + tags), **proposals only** (`authority=none|proposal`, never auto-promoted; conflicts surfaced, not overwritten — D3/federation). Federation/cross-repo NOT implemented.
- `kernel-buckets` — sprint/release/milestone entities (`planning-buckets-schema.js`). **Critique fix #4:** this is a *mutating* surface — its skill contract must carry the same `expected_revision` + idempotency guard as board mutations, or be marked read-only. Don't ship it guard-less.

### 10C — Internal, do NOT surface (mechanics, not verbs)
Conflict quarantine + evaluators (`evaluators.js`/`broker.js`), taxonomy validation (`taxonomy-validator.js`), runtime broker + migrations (`broker.js`/`migrations.js`/`schema.js`), the structured issue-command contract (`issue-command-contract.js` — the enabler emitted via `--json`, not a verb). Exposing these would invite agents to hand-generate revisions/idempotency keys, which D22 forbids.

**Critique fix #4 (audit):** confirm `forge export --import` is pure read-model reconstruction; if it writes authority, split `--import` behind the write-guard rather than presenting it as a thin "projection" skill.

## Combined build sequence

| PR | Work |
|---|---|
| **L0 (self-hosting, parallel with A0)** | Worktree-proof git hooks (§9.4): `core.hooksPath` → `.forge/hooks/` delegating to Lefthook; `forge hooks doctor/install/sync`; `forge push`/`validate` gate on hook-active state. Independent of the skill surface; fixes the worktree Lefthook bug and gives Hermes its enforcement+export path. |
| **A0** | Remove command surface (stage commands → skills; delete `.claude/commands/` + `sync-commands.js`) |
| **B** | Beads-parity skills → `.skills/` (Issue Lifecycle, Memory, Board/Planning, Orientation) — note `.skills/` is empty today; these are authored fresh, not "already exist" |
| **C** | Unique `kernel-*` skills (§10A live first; §10B behind their must-build CLI; §10C stays internal) |
| **D** | Agent-sync CLI extension (Claude `.claude/agents/` exists; Codex/Cursor have no agents concept → no-op; Hermes dir absent) |
| **E** | Neutral `.skills/hooks.json` + `skills sync-hooks` (format-aware writers, `detectAgents` projection, per-harness guard I/O, fail-loud PATH) |
| **F** | Wire the 4 hooks — Claude first; re-confirm Cursor/Codex schemas; skip Hermes |
| **G (later)** | Read-only MCP (`PD-20260606-readonly-mcp-first`) — mirror read ops first; writes behind the kernel write-guard |
