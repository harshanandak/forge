# Forge Kernel — Canonical Next-Work Backlog & Ordering

**Date:** 2026-06-19 · **Status:** AUTHORITATIVE for next-work ordering.
**This file is the single source of truth for what's next and in what order.** It supersedes the divergent orderings in `plan.md` (PR-A..F) and `kernel-skill-surface-design.md` §8. When they disagree, this file wins; decisions live in `docs/PROJECT_DESIGN.md`; per-item evidence lives in work folders.

Produced by the planning-state reconciliation audit (4 auditors + adversarial critique). The critique's verified findings drove the fixes recorded in §3.

---

## 0. Kernel readiness — smoke-spike verdict (2026-06-19)

**Can we depend on the kernel now? No — there is a missing driver layer.** A smoke spike ran all 13 issue ops via `issueBackend=kernel` against a fresh SQLite DB. **Every op threw the same error: `Kernel local broker driver must provide issueOperation()`.**

Root cause (verified): the chain is `KernelIssueAdapter → broker.runIssueOperation → driver.issueOperation`, but `lib/kernel/sqlite-driver.js` implements only `exec`/`queryAll` (raw SQL) + migration/backup/FTS5 self-tests — it does **not** implement `issueOperation`, nor the guarded-event methods (`loadKernelEntity`, `listKernelEvents`, `insertKernelClaim`, …). So the broker's domain logic (proven in #220) was tested against a **mock/test driver**; the real persistence driver is only a raw-SQL executor. **The kernel cannot serve a single issue today.**

This is THE gap between "kernel scaffolding built" and "kernel usable," and it blocks dogfooding, migration (K8), and the default-flip (K11). It is now the front-of-queue kernel item (**K-DRV** below). Good news: it's well-bounded — implement ~13 issue ops + the guarded-event methods as SQL on top of the existing `exec`/`queryAll` driver, against the existing schema + command contract, both of which exist to build against.

## 1. Canonical ordered backlog (merged scheme)

Merges the two prior PR schemes into one. Status: ✅ done · 🔄 in-progress · ⬜ not-started · ⛔ blocked.

| ID | Work | Depends on | Backing issue | Acceptance (one line) | Status |
|---|---|---|---|---|---|
| **K0** | **Repair bd/Dolt reachability** — `.beads/config.yaml` points at DB `beads`; server serves `forge`. Fix so issue capture works. | — | (process) | `bd ready` runs; new issues can be filed | ⛔ blocker |
| **K-DRV** | **Implement the kernel driver issue layer** — add `issueOperation` (the 13 ops as SQL) + guarded-event methods (`loadKernelEntity`, `listKernelEvents`, `insertKernelClaim`, …) to `lib/kernel/sqlite-driver.js`, against the existing schema + command contract. **Without this the kernel serves zero issues** (smoke-spike §0). | — | not-an-issue-yet | smoke spike: all 13 ops succeed via `issueBackend=kernel` on a real DB | ⛔ critical — blocks dogfood, K8, K11 |
| **K1** | **Worktree-proof git hooks** — `core.hooksPath` shared at common-dir + present in linked worktrees; `forge hooks doctor/install/sync`; `forge push/validate` gate on hook-active state | — | `9.3.37` (open) | fresh linked worktree has active hooks; doctor green | ⬜ |
| **K2** | **Remove command surface** — stage commands → skills; delete `.claude/commands/` + `scripts/sync-commands.js`; supersede `forge-ny6j` + `forge-besw.9` | — | not-an-issue-yet | no command files remain; skills sync is the only generator | ⬜ |
| **K3** | **Beads-parity skills → `.skills/`** (Issue Lifecycle, Memory, Board/Planning, Orientation) + umbrella `.skills/kernel/SKILL.md` | K2 | `agent-interface.1-7` (NOT filed) | fresh agent does ready→claim→comment→close via skills, no `bd` | ⬜ |
| **K4** | **Forge-unique `kernel-*` skills** — §10A live first; §10B (`remember`/`recall`/`buckets`) behind must-build CLI; §10C stays internal | K3 | not-an-issue-yet | unique verbs surfaced; internal plumbing not exposed | ⬜ |
| **K5** | **Agent-sync CLI extension** — neutral agent source → `.claude/.codex/.cursor/.hermes` (Codex/Cursor no agents concept → no-op) | K3 | not-an-issue-yet | `skills sync` propagates agents to all present harnesses | ⬜ |
| **K6** | **Neutral `.skills/hooks.json` + `skills sync-hooks`** — format-aware writers, `detectAgents` projection, per-harness guard I/O, fail-loud PATH | K1, K3 | not-an-issue-yet | hooks install to each harness's own config; Claude verified | ⬜ |
| **K7** | **Wire the 4 hooks** (SessionStart/PreCompact/Stop/PreToolUse) — Claude first; re-confirm Codex/Cursor schemas; skip Hermes native | K6 | not-an-issue-yet | prime/recap/export/guard fire on Claude; no silent authority writes | ⬜ |
| **K8** | **Beads→Kernel issue migration + fidelity harness** — migrate real issues; parity fixtures (counts/deps/comments/status/ready-queue) | K0 | `9.6.x` family | migration proves zero loss vs Beads | ⬜ |
| **K9** | **Burn down D20 runtime kill-list** — route `setup/bootstrap/health-check/sync` through kernel; drop 343 runtime + 117 command `bd` sites | K8 | `bd-call-site-kill-list.md` | `forge release check --target 0.1.0` runtime group → 0 | ⬜ |
| **K10** | **Kernel test hardening** — crash/recovery, corruption, cloud-sync WAL doctor, large-backlog perf, contract fuzz ("test every way") | K8 | not-an-issue-yet | kernel survives the hostile-condition matrix | ⬜ |
| **K11** | **Flip default backend to kernel; declare Beads retired** when `release check --target 0.1.0` is green | K9, K10 | `forge-2agy.9.9` (coordinator) | default backend = kernel; Beads = projection only | ⬜ |
| **K12** | **Read-only MCP** — mirror read ops (`ready/board/orient/recall`); writes behind kernel write-guard | K9 | `9.4.6` (open) | MCP exposes kernel reads; no live Beads dependency | ⬜ (later) |
| **K13** | **Team authority** (Cloudflare DO) — ADR stub only for now | K11 | `9.8.x` | design ADR exists; no premature build | ⬜ (later) |

### Waves (what runs in parallel)
- **Wave 1 (now):** K0 (blocker — do first), K1, K2 — independent, parallel worktrees.
- **Wave 2:** K3 → then K4, K5, K8 in parallel.
- **Wave 3:** K6 → K7; K9 (after K8); K10.
- **Wave 4:** K11 → K12 → K13.

No dependency cycles (verified). Front-of-queue: **K0 then K1/K2.**

## 2. Decision capture status (registry reconciliation)

| Decision | In `PROJECT_DESIGN.md`? | Action |
|---|---|---|
| D16–D22 (portability, driver, taxonomy, fs-doctor, kill-list, orient/recap, agent-interface) | ✅ PD-20260611-* | none |
| `.skills`-canonical surface | ❌ missing | **added** PD-20260619-skills-canonical-surface |
| No commands (command surface removed) | ❌ missing | **added** PD-20260619-no-command-surface |
| Agent-sync to all harnesses | ❌ missing | **added** PD-20260619-agent-sync-all-harnesses |
| Hooks surface + `core.hooksPath` install | ❌ missing | **added** PD-20260619-harness-neutral-hooks |
| Forge-unique surface 3-way split | ❌ missing | **added** PD-20260619-unique-feature-surface |

These refine `PD-20260611-agent-interface-parity` (which originally implied `.claude/commands/`); the new entries note the supersession.

## 3. Drift fixed this pass (from the critique)
1. **`plan.md`** — was still instructing `.claude/commands/` + `sync-commands.js` (contradicts locked NO-COMMANDS). Banner + pointer added; ordering deferred to this file.
2. **`kernel-skill-surface-design.md` §8 vs Combined** — two contradictory build sequences. §8 now points to the Combined/this file.
3. **`forge-issues.js:299` citation** — default-to-Beads is ~line 303 (`createIssueService`); 299 is `shouldUseKernelBroker`. Corrected in §10 caveat.
4. **Registry** — 5 new PD entries added (§2).

## 4. Dogfooding — keep this from drifting "every time"
- **Owner-of-truth:** decisions → `docs/PROJECT_DESIGN.md` (PD-*); ordering/next-work → **this file**; per-item evidence → work folders; live work items → issue backlog (Beads now, kernel after K11).
- **Honest blocker:** the planning state **cannot yet live in the Forge kernel** — the kernel backend is **dormant by default** (`forge-issues.js` ~L303 defaults to Beads; engages only when `issueBackend==='kernel'`) and **bd/Dolt is currently unreachable** (K0). So today authoritative capture = PROJECT_DESIGN + Beads JSONL. True kernel self-capture unblocks at **K11** (flip default).
- **Per-cycle checklist** (run when a planning decision changes): (1) add/supersede the PD-* entry in PROJECT_DESIGN.md; (2) update this backlog's ordering + statuses; (3) file/adjust the backing issue (once K0 done); (4) grep work-folder docs for the now-stale instruction and fix it. A future `forge` check should enforce steps 1–3.

## Outstanding tracker actions (need K0 first)
- File backing issues for K2, K4, K5, K6, K7, K10 (currently design-doc-only).
- Commit `agent-interface.1-7` to the tracker (designed, never filed).
- Close/rewrite `forge-ny6j` + `forge-besw.9` (contradict NO-COMMANDS).
