# Monitor-Driven PR Shepherd — FINAL Implementation Plan

Status: implementation-ready. Hand to agents working in isolated worktrees off `origin/master`.
All claims below were re-verified against the main worktree at `C:/Users/harsha_befach/Downloads/forge`. File:line citations are load-bearing.

---

## 0. What changed from the draft, and why (contradiction resolutions)

The draft was wrong or unsafe on several points the adversarial review caught. Verified findings forced the following **binding decisions**. These are not optional; every wave task inherits them.

### D-1. NO auto-merge. Ever. (resolves flow-regression #1, scope-feasibility #1)
The harness structurally forbids the agent from merging:
- `.claude/settings.json:11` — `"Bash(gh pr merge:*)"` is a PreToolUse deny rule.
- `.claude/commands/premerge.md:9` — "The actual merge is always done by the user in the GitHub UI — never by this command."
- `.claude/commands/premerge.md:107,138,169` — "DO NOT run `gh pr merge`"; "NEVER run `gh pr merge` — blocked by PreToolUse hook".

**Decision:** Shepherd terminates at a `MERGE_READY` terminal state and hands off to the human, mirroring premerge Step 5. The `--auto-merge` rung is DELETED from the design. The gh-pr-merge PreToolUse block is **out of scope** and must not be touched. No server-side `gh pr merge --auto` latch is ever set (it would outlive the loop's caps — safety-edgecases #9 — and violate the invariant).

### D-2. Auto-rebase + force-push is NET-NEW high-risk machinery, gated OFF by default. (resolves safety-edgecases #1, #5, #6)
Verified: there is **zero** rebase/force-push machinery in the repo. `grep -rIn "git rebase|force-with-lease|push --force"` over `lib/ scripts/ .claude/scripts/` returns nothing. `ship.js:146` only *detects* divergence via `git rev-list --left-right --count` (`getBranchReadiness`, ship.js:114-199); it never rebases or pushes. `push.js:188` writes a nonce so lefthook's pre-push hook skips re-running the suite — a raw force-push would NOT carry that nonce and would re-trigger the full local suite every push (safety-edgecases #5).

**Decision:**
- BEHIND-base handling default = **detect + escalate to human**, NOT auto-rebase.
- An opt-in `--auto-rebase` flag may perform `git rebase` + `git push --force-with-lease`, but it is classed Tier-B (see D-4), default OFF, and is genuinely new code with its own preconditions and tests (clean working tree, worktree-aware cwd, HEAD-unchanged check, lease-rejection HARD-STOP).
- Lease rejection = **HARD-STOP + escalate**. Never auto-fetch-then-retry (re-arming the lease silently clobbers the concurrent human push the lease exists to protect — safety-edgecases #6).
- If `--auto-rebase` is enabled, the cost model must assume each force-push re-runs the full lefthook suite (no nonce reuse in v1).

### D-3. Gate on REQUIRED checks needs a real data source. (resolves safety-edgecases #2)
`gh pr view --json statusCheckRollup` does NOT say which checks are branch-protection-required. Nothing in the repo reads `required_status_checks` today.

**Decision:** Shepherd fetches required checks via `gh api repos/{owner}/{repo}/branches/{base}/protection/required_status_checks` once per run, joins against `statusCheckRollup`. If protection is unreadable (403 insufficient scope, or branch not protected) → **do not guess**: treat as "cannot determine required set" and escalate to human with the readable rollup attached. Merge-ready is only declared when the required set is known AND all of it is green.

### D-4. Three-tier action ladder; only Tier-A is autonomous. (resolves safety-edgecases #4, #3)
- **Tier-A (autonomous, idempotent, reversible):** `gh run rerun --failed` for flaky CI (capped, see caps). Status replies on threads (comment only, no resolve).
- **Tier-B (opt-in per-flag, default OFF — trust/history affecting):** `--auto-rebase` (force-push). Thread *resolution* is NOT in v1 at all (see D-5).
- **Tier-C (human escalation):** everything else — conflicts, required-check failures that rerun didn't fix, unknown mergeability, auth-scope failures, oscillation, too-many-issues.

### D-5. Greptile thread RESOLUTION is removed from v1; shepherd only REPLIES. (resolves safety-edgecases #3, flow-regression #7)
Verified `.claude/rules/greptile-review-process.md:201` lists "Resolve threads that haven't been fixed yet" under **❌ DON'T**, and line 5 notes the process "has been problematic for days." Mechanical fix↔thread mapping is semantic, not mechanical.

**Decision:** Shepherd does not resolve threads. It may post a status reply via the existing shell-out `.claude/scripts/greptile-resolve.sh` (verified present). Resolution stays with the semantic agent (`/review`). Thread I/O is a **shell-out to greptile-resolve.sh, NOT an adapter method** — there is no adapter-registry path that composes a shell script (greptile-review-adapter.js:38,68,75 throw without an injected github client; adapter-cli.js does not wire shell scripts).

### D-6. Shepherd does NOT replace /review, does NOT rewrite premerge.md, and does NOT become a stage. (resolves flow-regression #2,#6; harness-parity #1; scope-feasibility #2,#4)
Three verified facts collide:
1. `lib/release-readiness.js:1801-1833` `premergeEmbeddedGateBlocker` **FAILS the release gate** when `/premerge` or `premerge` appears in `lib/workflow/stages.js`, `lib/workflow-profiles.js`, or `AGENTS.md`. D22 is actively dissolving /premerge into a task-type gate. (`premerge` IS currently present in stages.js:18 etc., so the gate is already designed to push removal.)
2. `review.md:372` emits `bash scripts/beads-context.sh stage-transition <id> review premerge`; `premerge.md:130` emits `premerge verify`. These transitions are beads-based and D22 is retiring beads — they are an in-flight migration, not a contract the shepherd should perpetuate or silently drop.
3. `lib/harness-capability-matrix.js:23` derives `STAGE_IDS` from `lib/workflow/stages.js`; any new STAGE must be added there AND given per-harness renderTargets, or it is invisible to parity tests.

**Decision:** Shepherd is a **standalone utility command**, not a workflow stage.
- It does NOT edit `lib/workflow/stages.js`, `lib/workflow-profiles.js`, `WORKFLOW_STAGE_MATRIX`, or add itself to `STAGE_SUBSKILLS` as a stage. (Verified safe: `_registry.js` `normalizeStageId()` is a classifier, not a registration gate; many commands — audit, board, insights, status, claim — are not in `STAGE_IDS`.)
- It is registered as a UTILITY skill in the capability matrix (`UTILITY_SKILL_IDS`, harness-capability-matrix.js:24) so parity tests cover it, WITHOUT touching the frozen stage list.
- It does **not** rewrite `premerge.md` and does **not** "replace /review". `/review` keeps owning semantic review + the `review→premerge` stage-transition emission. `/premerge` is left untouched (its dissolution is D22 scope). Shepherd **wraps and automates the polling/rerun/escalation loop** that today is done by hand after `/review`; it explicitly defers semantic actions (thread resolve, fact fixes) back to `/review`.
- Shepherd does NOT emit any `beads-context.sh stage-transition`. Because it is not a stage and does not claim to replace review, it does not break the `review→premerge→verify` chain — `/review` still emits `review→premerge`, `/premerge` still emits `premerge→verify`. (resolves flow-regression #2: the chain is preserved by NOT inserting shepherd into it.)

### D-7. The "fresh-clone-no-beads.test.js" the draft cited DOES NOT EXIST. (resolves flow-regression #5, harness-parity #2, scope-feasibility low-2)
Verified: `find test -iname "*fresh-clone*"` returns nothing. The string `expect(bdInvocations).toEqual([])` is a **detector regex inside lib/release-readiness.js**, not a runnable asset. `bdInvocations` assertions live only in `test/release-readiness.test.js` and `test/beads-migrate-to-dolt.test.js`. `freshCloneBlocker` (release-readiness.js:1835) currently FAILS the gate because the file is missing — that is an open **D22** blocker, NOT a safety net shepherd inherits.

**Decision:** Authoring the fresh-clone acceptance test is **D22 scope, decoupled from shepherd.** Shepherd does NOT claim `forge release check` is or will be green. Shepherd's own zero-beads guarantee is enforced by (a) its files containing zero `bd`/`.beads`/`dolt` tokens, and (b) a dedicated shepherd test that statically scans the new source files. Acceptance is NOT coupled to `forge release check` (which is manual-only — verified NOT in `lefthook.yml` or `.github/workflows`).

### D-8. Beads non-regression: correct constraint, correct mechanism. (resolves flow-regression #4, harness-parity low-1, scope-feasibility low-2)
Verified `STATIC_SCAN_ROOTS` (release-readiness.js:23-35) already contains `'lib'`, `'bin'`, `'scripts'` — so all new files are auto-scanned; **no "add to STATIC_SCAN_ROOTS" step is needed.** `findBdTerms` (release-readiness.js:447-453) is **case-insensitive** (`/\bbd\b/i`, `/\.beads\b/i`, `/\bdolt\b/i`).

**Decision:** All new JS (`lib/pr-shepherd.js`, `lib/adapters/pr-state-adapter.js`, `lib/commands/shepherd.js`, `lib/pr-state-validator.js`) and the synced skill files must contain **zero** `bd`/`.beads`/`dolt` tokens (case-insensitive) and zero bare identifiers like `bd`. State persists via `gh` PR comments + labels and `git` only. A shepherd unit test asserts zero tokens in the source files directly (the test tree is NOT scanned — `STATIC_SCAN_ROOTS` excludes `test/` — so the in-test scan is the guard).

### D-9. PRStateAdapter has its own kind and its own validator. (resolves harness-parity #5, flow-regression #7)
`lib/review-adapter.js:51-52` — `validateReviewAdapter` hard-requires `kind === 'review'`. PRStateAdapter uses `kind: 'pr-state'`. It is never fed to `validateReviewAdapter`. A new `validatePrStateAdapter()` (own module) enforces its contract, mirroring the review validator, and is registered in `adapter-cli.js`.

### D-10. Codex sync: keepDescription only; injectForgeAdapter is install-time. (resolves harness-parity #4, scope-feasibility low-1, scope-feasibility missing-1)
Verified two distinct mechanisms:
- `scripts/sync-commands.js` AGENT_ADAPTERS.codex (lines 182-187) uses `keepDescription` and writes `.codex/skills/<name>/SKILL.md`. It does NOT call `injectForgeAdapter`.
- `lib/codex-skills.js:5` `injectForgeAdapter` is applied at **install time** when Codex skills are materialized, and it literally emits: ``Before executing this workflow, invoke `forge <commandName>` ...`` (codex-skills.js:9).

**Consequence (load-bearing):** because injectForgeAdapter auto-emits ``invoke `forge shepherd` ``, a working `forge shepherd` CLI dispatch **MUST exist** or Codex agents get a dead command. The draft omitted CLI wiring. **`bin/forge-cmd.js` is added to the file inventory** (`VALID_COMMANDS` lacks shepherd today — verified lines 20-30; `HANDLERS` map lines 12-18).

### D-11. The 60s-poll-then-handoff rule. (resolves flow-regression #3, missing-1)
Verified repeated across `review.md:301,304`, `premerge.md:97`, `greptile-review-process.md:191,274`: "poll for at most 60 seconds, then stop and hand off." An in-process loop "until merge-ready" inverts this documented invariant.

**Decision:** Shepherd is an **EXTERNAL scheduler driving discrete bounded passes.** Each `forge shepherd <pr>` invocation = ONE bounded pass: read state, take at most the allowed Tier-A actions, then **exit** (it does not sit in-process burning a session). `--watch` is a thin loop *in the scheduler layer* (cron / external `loop`) that re-invokes the bounded pass on an interval with debounce, NOT an in-process infinite poll. This preserves the 60s ergonomic: any single pass that hits "pending" exits and lets the next scheduled pass pick up. The three rule files are therefore **not modified** (shepherd does not contradict them — it composes discrete handoff-style passes). No rule-file edits in scope.

### D-12. Hermes: hand-authored skill, not a sync target; observes via PR state, not orient. (resolves harness-parity #3, #6)
Verified: `.hermes/skills/hermes-forge/SKILL.md` exists, declared via `hermes.plugin.json` (`directories.skills='.hermes/skills'`), hand-authored, intentionally excluded from `sync-commands.js` AGENT_ADAPTERS (only `claude-code`/`cursor`/`codex` — verified lines 169-187). `lib/commands/orient.js:10` is "bounded project orientation from **deterministic source files**" with no PR/CI awareness (grep confirms no pull/PR/mergeab/checks in orient.js).

**Decision:** Hermes is NOT a sync target and gets NO synced shepherd command. The Hermes touchpoint is the EXISTING hand-authored `.hermes/skills/hermes-forge/SKILL.md` (or `skills/hermes-forge/SKILL.md`), updated to document "an external scheduler invokes `forge shepherd <pr>`." Shepherd progress is surfaced to Hermes via PR comments/labels (the durable state) — NOT via `orient` (deterministic-source contract). If a forge read-surface is desired, it would extend `recap` (which already has PR awareness), but that is **explicitly out of v1 scope** to keep blast radius small.

### D-13. Cursor degradation is manual-invoke only. (resolves harness-parity missing-6)
The matrix marks Cursor skills/stages as unproven and hooks unsupported. **Decision:** On Cursor, shepherd is a manually-invoked `.cursor/commands/shepherd.md` (frontmatter-stripped by the cursor adapter, sync-commands.js:176-180) documenting how to run `forge shepherd <pr>` from a terminal. No polling-loop affordance, no hook reliance. Documented in the skill body.

---

## 1. Architecture (final)

Harness-agnostic core + thin CLI + own-kind adapter + own validator. Dependency-injected for parallel testability.

| File | Role | Notes |
|------|------|-------|
| `lib/pr-shepherd.js` | Core: one **bounded pass** state machine. Reads PR state, decides action, returns a decision + side-effect plan. Pure-ish: all IO via injected `gh`/`git` runners. | NO `bd`/`dolt`. NO in-process infinite loop. NO merge. NO rebase unless `autoRebase` opt-in passed. |
| `lib/adapters/pr-state-adapter.js` | `kind: 'pr-state'`. Wraps `gh pr view --json`, `gh api .../protection/required_status_checks`, `gh pr checks`, `git rev-list --left-right --count`. Returns normalized `{ checks[], required[], mergeStateStatus, headSha, behind, ahead, threads[] }`. | Does NOT extend `ReviewAdapter`. Composes greptile-resolve.sh for thread *reply* only. |
| `lib/pr-state-validator.js` | `validatePrStateAdapter(adapter)` — own kind contract, mirrors `validateReviewAdapter` shape. | Registered in `adapter-cli.js`. |
| `lib/commands/shepherd.js` | Command handler. Exports `{ name:'shepherd', description, handler }` (the `_registry` contract). One pass per invocation; `--watch` documented as scheduler-driven. | Wires core + adapter + validator. |
| `bin/forge-cmd.js` (EDIT) | Add `'shepherd'` to `VALID_COMMANDS` and dispatch in the switch / `HANDLERS`. | Required so injected Codex ``invoke `forge shepherd` `` is not dead. |

**State machine terminal states:** `MERGE_READY` (hand off to human, never merge), `ESCALATE` (Tier-C, post comment + label, exit), `PENDING` (took a Tier-A action or nothing actionable; exit, await next scheduled pass).

**Per-pass safety preamble (every mutating action):** read `headSha` first; if HEAD moved since pass start, ABORT the action (safety-edgecases #8 — the HEAD-changed abort is the *real* concurrency guard; the label lock is advisory only).

**Concurrency:** `shepherd:active` label / marker comment is **advisory, NOT mutual exclusion** (TOCTOU — gh has no CAS). True guard = per-action HEAD-SHA check. Debounce ≥60s between scheduled passes; scheduler uses cancel-in-progress.

**Auth taxonomy (startup scope probe + per-error):**
- 401 / token expiry → pause + surface (transient).
- 403 insufficient-scope → **HARD-STOP**, message "token lacks <permission>" (permanent; retry never recovers). Probe required scopes once at pass start so it fails fast.
- 403 + `Retry-After` (secondary rate limit on mutations) → honor `Retry-After`, then resume.

---

## 2. Skill-rewrite manifest (per harness)

Canonical source: `.claude/commands/*.md`. Propagation via `scripts/sync-commands.js` to the **only three** sync targets (verified AGENT_ADAPTERS keys: `claude-code`, `cursor`, `codex`).

| Canonical file | Action | claude-code | cursor | codex | hermes |
|----------------|--------|-------------|--------|-------|--------|
| `.claude/commands/shepherd.md` | **NEW** | kept as-is (claude adapter, baseDir `.claude/commands/`) | synced → `.cursor/commands/shepherd.md`, frontmatter **stripped** (cursor adapter) | synced → `.codex/skills/shepherd/SKILL.md`, `keepDescription`; `injectForgeAdapter` applied at **install time** (emits ``invoke `forge shepherd` ``) | NOT synced |
| `.claude/commands/review.md` | **UNCHANGED** | — | — | — | — |
| `.claude/commands/premerge.md` | **UNCHANGED** (D-6: dissolution is D22) | — | — | — | — |
| `.claude/commands/ship.md` | **UNCHANGED** | — | — | — | — |
| `.hermes/skills/hermes-forge/SKILL.md` (or `skills/hermes-forge/SKILL.md`) | **EDIT** (hand-authored; document external `forge shepherd <pr>` invocation) | — | — | — | hand-edited, NOT via sync |

`shepherd.md` body MUST: (a) contain zero `bd`/`.beads`/`dolt` tokens; (b) describe the bounded-pass model + 60s handoff philosophy (D-11); (c) state Cursor = manual terminal invoke (D-13); (d) explicitly say it never merges and never resolves Greptile threads (defers to `/review`); (e) document Tier-A/B/C ladder and that `--auto-rebase` is opt-in default-OFF.

Capability-matrix: add `shepherd` to `UTILITY_SKILL_IDS` (harness-capability-matrix.js:24) with subskills (e.g. `shepherd.poll`, `shepherd.rerun`, `shepherd.escalate`) in `STAGE_SUBSKILLS`. Do NOT add to `STAGE_IDS`/stages.js (D-6).

---

## 3. WAVE plan (worktree-partitioned, exclusive file ownership)

All waves branch off `origin/master`. Each task lists owned files (no two concurrent tasks share a file), a RED test (write first, must fail), and a DoD tied to a concrete check. W3 is **serialized** (single owner runs `sync-commands.js` and commits the generated tree to avoid collisions).

### WAVE 1 — Core + adapter + validator (parallel via DI)

**W1-T1: PR-state adapter**
- Owned: `lib/adapters/pr-state-adapter.js`, `test/pr-state-adapter.test.js`
- RED test: feed a fake `gh`/`git` runner returning a mixed required/optional check rollup + behind=2; assert adapter returns normalized `{required:[...], behind:2, headSha, mergeStateStatus}` and that it calls `gh api repos/.../protection/required_status_checks`. Fails (no file).
- DoD: `node --test test/pr-state-adapter.test.js` green; adapter never imports merge/rebase; in-test grep of adapter source → zero `bd|dolt`.

**W1-T2: PR-state validator**
- Owned: `lib/pr-state-validator.js`, `test/pr-state-validator.test.js`
- RED test: assert `validatePrStateAdapter({kind:'review',...})` returns error "kind must be \"pr-state\""; a valid `pr-state` adapter passes; assert `validateReviewAdapter` is NOT called. Fails (no file).
- DoD: tests green; shape mirrors `lib/review-adapter.js:40-62`.

**W1-T3: Core bounded-pass state machine**
- Owned: `lib/pr-shepherd.js`, `test/pr-shepherd.test.js`
- RED tests (table-driven, injected adapter):
  1. all required green + behind=0 → `MERGE_READY`, NO merge call emitted.
  2. failed flaky required check, rerun budget left → emits ONE `gh run rerun --failed`, returns `PENDING`.
  3. behind>0, `autoRebase:false` → `ESCALATE` (no git push emitted).
  4. behind>0, `autoRebase:true`, clean tree, HEAD unchanged → emits `git rebase`+`push --force-with-lease`; lease-reject → `ESCALATE` (no auto-retry).
  5. required set unreadable (protection 403) → `ESCALATE`, never `MERGE_READY`.
  6. HEAD moved mid-pass → action aborted.
  7. 403 insufficient-scope → HARD-STOP; 403+Retry-After → honor; 401 → pause.
  8. rerun budget exhausted / oscillation detected → `ESCALATE`.
  9. NEVER emits `gh pr merge` or `gh pr merge --auto` in any branch.
  10. NEVER emits a greptile thread *resolve* (reply allowed).
- DoD: all 10 green; in-test scan `/\bbd\b|\.beads|\bdolt\b|gh pr merge/` of `lib/pr-shepherd.js` → empty.

### WAVE 2 — CLI command + dispatch wiring (parallel after W1)

**W2-T1: shepherd command handler**
- Owned: `lib/commands/shepherd.js`, `test/commands-shepherd.test.js`
- RED test: handler exports `{name:'shepherd',description,handler}`; one invocation = one bounded pass (assert core called once, no loop); `--auto-rebase` default false; exits after pass. Fails (no file).
- DoD: tests green; `_registry` contract satisfied.

**W2-T2: bin dispatch**
- Owned: `bin/forge-cmd.js`, `test/forge-cmd-shepherd.test.js`
- RED test: `VALID_COMMANDS.includes('shepherd')` true; dispatching `shepherd` routes to handler; unknown-command path unchanged. Fails (shepherd absent from VALID_COMMANDS:20-30).
- DoD: tests green; `forge shepherd --help` resolves (no dead command for Codex injection).

### WAVE 3 — SERIALIZED: canonical skill + sync generation (single owner)

**W3-T1 (sole owner of generated tree):**
- Owned: `.claude/commands/shepherd.md` (new), and ALL sync outputs it produces: `.cursor/commands/shepherd.md`, `.codex/skills/shepherd/SKILL.md`, plus any manifest/lockfile sync-commands touches (`skills-lock.json` if applicable). `test/shepherd-skill-sync.test.js`.
- Steps: author `shepherd.md` per §2 manifest rules; run `node scripts/sync-commands.js`; commit generated files.
- RED test:
  - `node scripts/sync-commands.js --check` exits 0 (in sync).
  - `.cursor/commands/shepherd.md` has frontmatter stripped.
  - `.codex/skills/shepherd/SKILL.md` exists with kept description.
  - `shepherd.md` contains zero `bd|.beads|dolt` (case-insensitive).
  - no `.hermes/...shepherd` file created (Hermes not a sync target).
- DoD: `--check` exits 0; token scan empty; assertions pass.

### WAVE 4 — Cross-harness docs + matrix + Hermes (one owner each, parallel)

**W4-T1: capability matrix**
- Owned: `lib/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js` (exclusive edit window)
- RED test: `shepherd` present in `UTILITY_SKILL_IDS` with subskills; `getSkillsFirstStageGraph()` emits shepherd utility renderTargets for claude/cursor/codex; `STAGE_IDS` UNCHANGED (shepherd NOT a stage — assert deep-equal to frozen list). Fails (shepherd absent).
- DoD: matrix self-consistency test green; stages.js untouched.

**W4-T2: AGENTS.md / capability docs**
- Owned: `AGENTS.md` (shepherd section only — must NOT add `premerge` text that would trip premergeEmbeddedGateBlocker; shepherd section is bd-free), `docs/reference/shepherd.md` (new).
- RED test: `test/docs-shepherd.test.js` asserts AGENTS.md documents shepherd as utility (not stage) and contains no new `gh pr merge`/auto-merge promise; in-test grep `/\bbd\b|\bdolt\b/i` on the new doc → empty.
- DoD: tests green.

**W4-T3: Hermes consumption skill**
- Owned: `.hermes/skills/hermes-forge/SKILL.md` (and/or `skills/hermes-forge/SKILL.md`) — Hermes-only edit.
- RED test: `test/plugins/hermes-plugin.test.js` (extend) asserts the skill documents external `forge shepherd <pr>` invocation AND that Hermes remains absent from `sync-commands.js` AGENT_ADAPTERS.
- DoD: test green; sync target set still exactly `{claude-code,cursor,codex}`.

### WAVE 5 — Acceptance (after W1–W4)

**W5-T1:** owns `test/shepherd-acceptance.test.js` — see §5.

---

## 4. Reuse table (corrected)

| Need | Reuse? | Reality |
|------|--------|---------|
| ahead/behind detect | YES (read pattern) | `git rev-list --left-right --count` per ship.js:146. Re-implement the read in pr-state-adapter; do NOT import ship's writer. |
| rebase + force-push | NO | Net-new (D-2). Zero existing machinery. |
| pre-push lint/test | NO direct reuse | push.js:188 writes a nonce so lefthook skips; a raw force-push won't carry it → full lefthook re-runs each forced push. Fold into cost budget. |
| greptile thread reply | YES (shell-out) | `.claude/scripts/greptile-resolve.sh` (verified present). Reply only, no resolve (D-5). |
| merge | NO | Forbidden (D-1). |
| stage-transition | NO | Not a stage (D-6); `/review` and `/premerge` keep emitting their transitions. |

---

## 5. Acceptance test (`test/shepherd-acceptance.test.js`)

Drives `lib/pr-shepherd.js` + `lib/commands/shepherd.js` with a scripted fake `gh`/`git` runner. Asserts, in one suite:

1. **Happy path (zero manual steps to READY):** PR with one flaky failed *required* check + behind=2 + an unresolved Greptile thread. Pass 1: rerun the failed check (Tier-A) → `PENDING`. Pass 2 (rerun now green) but behind=2 with `autoRebase:false` → `ESCALATE` (human rebases). Re-run pass 3 with behind=0 → `MERGE_READY`. Assert NO `gh pr merge` ever emitted; thread never resolved (only reply).
2. **autoRebase path:** same but `autoRebase:true`, clean tree, HEAD unchanged → emits `git rebase`+`push --force-with-lease`; on lease reject → `ESCALATE`, no retry.
3. **Caps honored:** rerun budget = N; (N+1)th flaky failure → `ESCALATE`, not another rerun.
4. **No auto-merge by default / ever:** assert across all branches `gh pr merge` and `gh pr merge --auto` are never in the emitted side-effect log.
5. **Unknown/unreadable required set → wait/escalate, not merge-ready:** protection 403 → `ESCALATE`; mergeStateStatus UNKNOWN → `PENDING`/wait (UNKNOWN ≠ conflict).
6. **Auth taxonomy:** 403 insufficient-scope → HARD-STOP (no retries logged); 403+Retry-After → resume after delay; 401 → pause.
7. **Zero-beads static scan (the strongest non-regression guard):** read the four source files (`lib/pr-shepherd.js`, `lib/adapters/pr-state-adapter.js`, `lib/pr-state-validator.js`, `lib/commands/shepherd.js`) from disk and assert `/\bbd\b/i`, `/\.beads\b/i`, `/\bdolt\b/i` return ZERO matches. (Mirrors release-readiness.js:447-453 but runs in the test tree, which the release scanner does NOT cover.)
8. **Sync integrity:** `node scripts/sync-commands.js --check` exits 0.
9. **NOT coupled to `forge release check`:** the suite explicitly does NOT assert the release gate is green (it is RED for unrelated D22 reasons — freshClone + premergeEmbeddedGate — verified). Decoupled per D-7.
10. **HEAD-changed abort:** simulate HEAD moving mid-pass → mutating action aborted.

**Test-tree note:** the literal tokens used as scan inputs in §5.7 are SAFE — `STATIC_SCAN_ROOTS` excludes `test/` (verified) — so embedding the regex strings does not trip the release scanner. Conversely, the release gate will NOT catch a stray token in any new test helper; §5.7 scanning the *source* files is therefore the authoritative guard.

---

## 6. Out of scope (explicit, to prevent scope creep)

- Removing/altering the `Bash(gh pr merge:*)` PreToolUse block (D-1).
- Authoring `fresh-clone-no-beads` acceptance test or making `forge release check` green (D-7 — that is D22).
- Dissolving `/premerge` / editing stages.js / workflow-profiles.js (D-6 — D22).
- Greptile thread auto-resolution (D-5 — stays with `/review`).
- Extending `orient`/`recap` for live PR state (D-12 — deferred).
- In-process infinite watch loop (D-11 — scheduler-driven bounded passes only).
