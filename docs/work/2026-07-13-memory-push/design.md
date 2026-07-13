# Design: Push memory to agents + wire the auto-file rail

**Issues:** `48d67c91-2ea9-4fe3-a8b0-569a93298701` (memory push), `a4b8f56f-7f1f-453e-8ddd-a8210fb4ec05` (auto-file rail)
**Date:** 2026-07-13
**Type:** Critical (agent-agnostic + reliability-critical; reviewed before merge)

## Problem

Forge memory is **100% pull**: an agent only sees remembered notes if it *types*
`forge recall`. The only hooks Forge renders are the two ENFORCEMENT intents
(`protected-path`, `tdd-gate`) in `FORGE_HOOK_CONTRACT` (lib/hook-renderer.js);
nothing injects memory at session start. `forge prime`'s orientation envelope
(lib/orientation.js `buildOrientationSections`) omits memory entirely. And
`ensureBackingIssue()` (lib/kernel/backing-issue.js) — the "nothing goes missing"
auto-file primitive — has **zero callers**, though its own header says wire it
into worktree/push/lefthook.

## FIX 1 — Memory push

### 1a. SessionStart context hook (new intent `kind`)

The existing enforcement adapter (`.forge/hooks/forge-native-hook.js`) is
deliberately **self-contained** — target projects have `.forge/hooks/*.js` but
NOT Forge's `lib/`. Enforcement must *fail closed* with zero deps. Memory
injection is the opposite: it needs kernel DB access (`memoryRouter.recall` over
FTS5/sqlite + the issue store + `applyBudget`), all of which live in `lib/`, and
it must *fail open* (a missing digest never blocks a session).

**Decision:** make the semantic split first-class in the contract via an intent
`kind`:

- `kind: 'enforcement'` → routes through the self-contained adapter, fail-closed
  (existing `protected-path`, `tdd-gate`).
- `kind: 'context'` → routes to the **`forge` CLI** (which loads `lib/`),
  fail-open. New intent `memory-inject` (lifecycle `session-start`).

Routing the context hook straight to the CLI (rather than having the adapter
shell out to `forge`) removes a pointless hop and a second failure surface: the
adapter would only `spawnSync forge` anyway. The rendered command is:

```
forge hooks session-start --harness <h>
```

`forge hooks` already exists (the global-install command); we add a
`session-start` **action** to it — machine-facing plumbing, don't type it by
hand. It emits harness-native SessionStart JSON:

- **Claude:** `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: <digest> } }`.

On ANY failure (no notes, kernel unreachable, `forge` not on PATH) the command
exits 0 with empty output → the harness ignores it → fail-open. Never emits
malformed JSON.

### The digest (`lib/memory-digest.js`)

`buildMemoryDigest(data, { budgetTokens })` — **pure**, token-capped via
orientation's `applyBudget` (newly exported alongside `buildSection`). Default
budget **400 tokens** (small: a nudge, not a manual). Content:

- **Remembered notes** — top ~5 from `memoryRouter.recall(projectRoot, { limit })`.
- **Open issues** — top ready + top claimed (in_progress), titles only.

`collectDigestData(projectRoot, opts)` does the best-effort fetch (each source
wrapped → `[]` on failure): notes via recall (sync); ready/claimed via
`runIssueOperation('ready'|'list', ['--json', ...])`, parsed defensively. The
fetcher is **injectable** so tests are deterministic and never touch a DB.
Empty data → empty digest → no injection.

### Per-harness rendering — capability matrix, NEVER faked parity

The `memory-inject` intent is rendered honestly per harness; each render reports
`rendered | skipped(<reason>)`:

| Harness | SessionStart surface | Result |
|---|---|---|
| claude | `.claude/settings.json` `SessionStart` hook (emits `additionalContext`) | **rendered** |
| cursor | Cursor 1.7 hooks are deny-oriented (`beforeShellExecution`/`afterFileEdit`/`beforeSubmitPrompt`); no documented session-start context-injection surface | **skipped(no-session-start-surface)** |
| codex | hooks live in GLOBAL `$CODEX_HOME/config.toml`; project setup never writes global config | **skipped(global-config)** |
| hermes | hooks live in GLOBAL `~/.hermes/config.yaml`; same | **skipped(global-config)** |

This mirrors the existing `scope: 'global-config'` skip precedent and is asserted
by snapshot tests. We claim claude-only injection with explicit, tested skip
reasons for the rest — not "supports all harnesses".

**Idempotency fix:** `mergeClaudeSettings` currently detects Forge-owned groups
by the adapter marker `forge-native-hook.js`. The context command
(`forge hooks session-start`) does NOT contain that marker, so a second marker
`forge hooks session-start` is added and `isForgeClaudeGroup` tests **either**,
keeping re-render idempotent for both PreToolUse and SessionStart groups.

### 1b. MEMORY section in `buildOrientationSections`

Add a bounded `remembered_notes` section (top ~5 recall notes, `preserve: false`,
low priority) so `forge prime`/`orient` surface remembered notes. Recent
**decisions** are already surfaced by the existing `headline_decisions` section
(from `docs/PROJECT_DESIGN.md`), so MEMORY adds the genuinely-missing half
(remembered notes) rather than duplicating decisions. Wrapped best-effort →
omitted on any failure or when empty; keeps `buildOrientationSections` sync
(recall is synchronous).

## FIX 2 — Auto-file rail (wire `ensureBackingIssue`)

`ensureBackingIssue()` is idempotent (deduped by branch), best-effort (never
throws → null). Wire it into three surfaces, each **non-blocking** (degrade +
warn, never fail the command):

1. **`forge worktree create`** — after `registerWorktreeLinkage`, when no
   `--issue` was supplied, call `ensureBackingIssue({ branch, worktreePath,
   projectRoot, driver, broker })` so a bare `worktree create` still files a
   backing stub. The linkage row it writes upserts the same
   `kernel_worktrees` row.
2. **`forge push`** — before `git push`, call `ensureBackingIssue({ branch: getCurrentBranch() })`
   best-effort so pushing started work auto-files. Warn on failure; never abort
   the push.
3. **lefthook pre-push** — a new non-blocking command invoking the same CLI path
   (`node scripts/auto-backing-issue.js || true`) so a **raw** `git push` (not
   via `forge push`) still auto-files. The script always exits 0.

All three share the `ensureBackingIssue` contract: main/master, detached HEAD,
and tmp/spike/wip/throwaway branches are skipped; a missing/non-kernel backend
yields null. Idempotency means multiple surfaces firing for one branch never
create duplicates (the first link wins).

## Testing (TDD)

- **hook-renderer:** `memory-inject` intent present with `kind: 'context'`;
  `renderClaudeHooks` emits a `SessionStart` group whose command is
  `forge hooks session-start --harness claude`; per-harness render reports the
  exact capability-matrix result (claude rendered; cursor/codex/hermes skipped
  with the labelled reason); re-merge is idempotent (no duplicate SessionStart
  group).
- **memory-digest:** bounded output honours `budgetTokens` (never exceeds);
  formats notes + ready/claimed; empty data → empty digest; `collectDigestData`
  degrades to `[]` on fetch failure.
- **hooks session-start command:** claude → valid `additionalContext` JSON;
  empty digest → empty stdout, exit 0; never throws.
- **orientation:** `buildOrientationSections` includes a `remembered_notes`
  section when notes exist; omitted when empty/unavailable; stays within budget.
- **backing-issue wiring:** `worktree create` and `push` invoke
  `ensureBackingIssue` (mocked) exactly once; idempotent (second call with an
  existing link creates nothing); a thrown/failed ensure does NOT fail the
  command (non-blocking).

## Non-goals / follow-ups

- UserPromptSubmit per-turn injection (considered; deferred — SessionStart is the
  high-leverage push; per-turn risks context churn). File a follow-up.
- Codex/Hermes global SessionStart context hooks (global-config follow-up, same
  as their enforcement hooks).
- Graphiti-backed digest (local kernel floor only, per memory/router design).
