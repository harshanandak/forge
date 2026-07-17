# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: `/check` was renamed to `/validate` and `/merge` was renamed to `/premerge` in v0.0.3. Historical entries below may use the old names.

## [Unreleased]

### Fixed

- **`forge worktree create` bases the new branch on the default branch, not the current checkout.** A worktree created while on a WIP branch previously forked from the current HEAD and silently inherited unrelated commits. New worktrees now fork from the repository default branch (`origin/<default>` when the remote ref exists, else the local default); a new `--base <ref>` flag overrides it (invalid refs error and create nothing), and `create` prints the base it used so the fork point is never silent. (B2)

## [0.1.0-beta.2] - 2026-07-15

The **beta-blocker hardening wave** — Forge's advertised loop now composes end to end, its quality gates fail closed, its control surfaces describe themselves honestly, and the runtime is Beads-free. Every change below was adversarially reviewed before merge. (v0.1.0-beta.1 was tagged but never reached npm — its publish token had expired; this release switches to OIDC Trusted Publishing and is the first npm beta.)

### Fixed

- **`forge ship` is reachable from the pure CLI.** `plan`/`dev`/`validate`/`ship` persist and read workflow stage state in the Kernel (completion-gated at the enforcement chokepoint), so **any** agent driving the bare CLI reaches ship — previously the stage state was written only by a Claude-specific slash layer, so a non-Claude agent ran every stage green then dead-ended. `plan --issue <id>` links an existing issue instead of forking a duplicate; `--issue` with no value errors instead of creating one. (#380)
- **Quality gates fail closed.** `forge validate` reports `SKIPPED` (never a silent `PASS`) on 0 tests; `forge preflight` fails on an unresolvable base instead of vacuously passing, and no longer runs Forge's own internal test files inside a consumer repo. Further preflight fail-open residuals closed. (#381, #386)
- **`forge setup` installs real TDD enforcement — on the live path.** Native `.git/hooks` fallback when lefthook's binary is absent, honors `core.hooksPath`, writes real hook jobs (never the stock example), verifies hooks are active with a loud non-zero exit when they aren't, never resolves/writes hooks into an ancestor repo, and never clobbers a user's existing hook without a backup. (#382, #388)
- npm publishing now authenticates via **Trusted Publishing (OIDC)** instead of a long-lived `NPM_TOKEN` (which had expired and silently failed the beta.1 publish).

### Added

- **`forge serve` shared-machine hardening.** Single-instance `serve.lock` (dead-PID reclaim), server state files created with restrictive permissions + a startup audit, and a hash-chained mutation journal verified at every startup. (#383)
- **`forge control` — an honest tri-state control plane.** Set gates/rails `mandatory`/`optional`/`permission` over the **real resolver-enforced** config field (no parallel un-enforced key); refuses to "control" surfaces it can't enforce. Ships a state × enforcement-locus **guarantee matrix** and locus badges that state honestly what is run-time-enforced vs declared vs advisory. (#385)
- **Surface-only, author-agnostic PR auto-monitor.** A GitHub Actions workflow that posts a single sticky summary of unresolved review threads (grouped by author — any review bot or human) + failing/pending checks; fail-closed on both halves, never merges and never posts a verdict. (#384)
- Single-binary distribution (`bun build --compile`, checksum-verified install script) + an interactive local `forge serve` dashboard with a comment-back inbox. (#378, #379)

### Changed

- **Beads is retired from the runtime.** The default kernel-primary path touches no Beads — the unconditional bootstrap/health probes (and their "Beads-not-initialized" stderr noise) are gone. An opt-in `forge migrate` import/export is the only remaining Beads surface. (#387)

### Known limitation (honest by design)

- The *configurable* gate/rail registry is not yet consumed by a runtime deny — real quality enforcement today lives in the lefthook TDD pre-commit hook, fail-closed `validate`/`preflight`, and kernel stage-order/completion (all independent of the configurable flags). The `forge control` guarantee matrix documents exactly what each control does today; wiring the registry to those enforcement points is tracked for a later release.

## [0.1.0-beta.1] - 2026-07-09

First public release (beta). Published under the npm `beta` dist-tag. The default issue backend changed from Beads to the built-in Kernel store, the Kernel's git-tracked JSONL portability loop now works end to end, and a pre-beta audit hardened the CLI surface, docs, and npm packaging.

### Changed

- **Default issue backend is now the built-in Kernel store (was Beads).** `forge list`, `forge ready`, `forge show`, `forge create`, `forge close`, and the other issue wrappers now read the Kernel issue store by default; no Beads install or initialization is required.
- Pre-merge is presented as an embedded documentation gate inside the `/ship` and `/review` stages — not a numbered workflow stage, and not an invokable `/premerge` command. (#269)
- Packaging: excluded a stray test file from the published npm tarball, added an `engines.node` requirement of `>=22.16.0`, and documented the `forge doc-gate` command. (#271)
- **Packaging: stopped shipping internal `docs/work/**` planning docs in the npm tarball.** The published package no longer contains maintainer-local absolute paths or internal project names (843 → 425 files, 2.1 MB → 997 kB). (#334)
- **`forge <unknown-command>` now fails honestly.** A mistyped or unrecognized command prints `Error: Unknown command '<x>'` to stderr and exits `1`, instead of printing the setup banner and exiting `0`. (#334)

### Fixed

- **The core workflow is now reachable out of the box after `forge init` / `forge setup`.** Previously, lefthook's own postinstall dropped a fully-commented stub `lefthook.yml` that blocked Forge from writing a real config, so `forge plan` / `dev` / `ship` all dead-ended on `HOOKS_NOT_ACTIVE: missing required hooks: pre-commit, pre-push`. Forge now writes a minimal user-facing lefthook config wiring the self-contained TDD gate (`.forge/hooks/check-tdd.js`) on pre-commit and the project's own tests on pre-push — referencing only files a user project actually has (never Forge's repo-internal `scripts/`) — and overwrites the disposable stub while never clobbering a real config. (#334)
- End-to-end new-user UX polish (all surfaced by a fresh-project journey audit): `forge claim`/`show`/etc. with no id now return a clean "Missing required argument <id>" and a non-zero exit instead of fabricating a random UUID and quarantining it; issue writes (`forge create`/`claim`/`close`/…) print a concise human confirmation (`✓ Created <id>`) at an interactive terminal while keeping the machine-parseable JSON envelope when piped or scripted (so automation is unchanged); `forge prime`/`orient` no longer show internal "D21 placeholder" text; the kernel filesystem note dropped its alarming "database corruption" wording on the fail-open path; and `forge init` no longer emits a Node `DEP0190` deprecation warning. (#334)
- `forge export` now actually projects Kernel issues to git-tracked JSONL. The command dispatcher injects a Kernel broker for `export`, and Kernel mutations enqueue the projection-outbox marker under the `jsonl` target the export consumer drains — so the Kernel git-persistence/portability loop works end to end. (#270)
- First-run hint from `forge status` pointed at a nonexistent docs topic (`forge docs workflow`); it now points at `forge docs setup`. (#334)
- Removed stale "Beads" wording from live `forge --help` output — the `board` and `test` command descriptions now reference the kernel. (#334)
- QUICKSTART: added an npm install path beside bun, listed Hermes as a supported harness (was "planned"), and pointed the section 6 validation example at the user's own project (`forge validate`) rather than this repository. (#334)

### Added

- **Human-readable issue handles: `<title-slug>-<short-id>` (e.g. `add-oauth-login-56a3a16d`).** Opaque UUIDs make it hard to tell what an issue is or track where an agent is across sub/dependency tasks. `forge ready`/`list` now show a readable handle in the ID column, and issue writes confirm with it (`✓ Created add-oauth-login-56a3a16d`) at an interactive terminal. The handle is **resolvable** — `forge show add-oauth-login-56a3a16d`, `forge show 56a3a16d`, or even a stale slug with the right id all resolve to the same issue (the resolver reads the trailing 8-char short id; the slug is display sugar). The canonical id stays the full UUID; short legacy/imported ids (`forge-2a3bc9`) pass through unchanged. (kernel 1db53c60)
- **Lease-ownership verification: `forge issue owns <id>`.** A claim returning `ok:true` does not by itself prove you won the lease — a same-key duplicate replay also returns `ok:true` (echoing the current call's `claim_id`), and a live lease can be reclaimed on expiry. The new Kernel read exits `0` iff the resolving actor (`FORGE_ACTOR` → `FORGE_SESSION_ID` → default `forge`) holds the **single active claim** and that lease has **not expired**; otherwise it exits non-zero (conflict, code `4`) with a clear "you do not own the lease for `<id>` (held by `<actor>`)" message. `--json` emits `{ ok:true, data:{ owned, claimed_by, expired, actor, expires_at } }`. It is a strict READ (never mutates state) and is Kernel-only (the Beads passthrough returns a clear kernel-only error). The new `claim-safety` skill packages the reusable procedure — claim → `owns` → work → re-verify before `close`/`release` — and is registered in the `kernel` umbrella skill. (kernel eea2f9ce, builds on d71a824b)
- **Kernel linkage backbone: `forge worktree create` now records the issue → worktree → work-folder chain, and orientation reads it instead of guessing.** Previously `kernel_worktrees` was schema-only (0 writes, always empty), so the kernel stored none of the linkage and orientation resolved the active work-folder by a filesystem heuristic ("most-complete folder wins") that breaks silently under parallel features. Now `forge worktree create <slug> [--issue <id>] [--work-folder <path>]` writes an idempotent `kernel_worktrees` row (keyed by absolute worktree path) linking `path`/`branch`/`issue_id`/`work_folder`/`git_common_dir`, and drops a machine-readable `.forge-issue` marker in the work-folder so a folder resolves to its issue deterministically. `orientation.discoverWorkFolder` and the new `forge worktree list` READ this linkage from the kernel (row `work_folder`, else `issue_id` → marker scan), falling back to the folder heuristic only when no row exists. Migration `007_kernel_worktrees_linkage_columns` adds the two nullable columns (backward-compatible; a missing/un-migrated kernel degrades to the heuristic, so a repo with no reachable kernel still gets a usable worktree). (kernel 727289e2-be51-4833-adb1-03484fadc99d)
- Two kernel-native canonical skills, registered through the `kernel` umbrella index and mirrored into the generated agent skill dirs by `skills-sync`. `triage-ready` is a read-only "what should I work on" skill that ranks and *explains* the derived ready queue via `forge issue ready` / `blocked` / `stats` (never `board`, which reads a legacy snapshot store), justifies why the top pick is workable and why the runners-up are blocked, and hands the pick off without mutating the store. `issue-basics` is the everyday CRUD floor over the `forge issue` verbs (create/update/claim/release/comment/close/show/list/search/stats) with the real flags, plus the migration disposition for `label` (→ `--label "a,b"`), `reopen` (→ `update --status open`), and `delete` (unsupported by the append-only kernel — use `close`). Both carry an explicit `## Fork points` section so users can re-carve filters, ranking, staleness windows, and create conventions.
- Toggle-driven workflow config: a sparse writer for the schema-validated `.forge/config.yaml` surface (`lib/config-writer.js`) plus two thin verbs over it. `forge gate <enable|disable> <gate-id>` writes `workflow.gates.<gate-id>.enabled` and `forge role <role> --use <skill> [--ideology <name>]` writes `roles.<role>.skill` / `roles.<role>.ideology`, so users re-carve the assembly with config writes instead of editing Forge code. The reader gains an additive, backward-compatible `roles` section (siblings to `workflow.gates`) with open-world skill validation — the closed `PLAN_SUBSKILL` enum stays scoped to `planning.template.partialInvocation` and never blocks a `roles.<role>.skill` value — and `forge options roles --json` now reflects the resolved bindings. Both verbs validate at write time: an unknown gate id, unknown role, or unresolvable skill (no `SKILL.md` under `.skills/ > skills/`) errors before anything is written, never mid-run.
- **Onboarding now auto-migrates Beads → Kernel and self-installs git hooks.** `forge setup` (quick, `--yes`, and interactive agent paths) and `forge init` now detect an existing jsonl-backed `.beads` store and **auto-import** its issues, comments, and dependencies into the Kernel — reusing the idempotent `forge migrate --from beads` spine, reading the committed jsonl sidecars directly (no external issue-tracker CLI required, so it works even when the legacy SQL backend is offline) and surfacing the same honest field-gap report. A fresh `forge init` also now installs git hooks, so `forge validate`/`plan` are no longer immediately blocked by `HOOKS_NOT_ACTIVE` — closing the init → hooks catch-22. Both steps are idempotent and degrade to a warning rather than aborting onboarding.
- `forge migrate --from beads` now transfers the full legacy **activity log** — every `events.jsonl` lifecycle event (created/closed/status_changed/updated/label_added/…) and every `interactions.jsonl` agent interaction/memory record — into the Kernel `kernel_events` table (namespaced `beads.event.*` / `beads.interaction.*`, `origin=beads_import`), preserving each record's kind, actor, timestamp and payload. The write is idempotent (deterministic id, `ON CONFLICT DO NOTHING`) so re-migration mints no duplicates, and needs no schema change. Issue-level fields with no dedicated Kernel column are folded into the issue `metadata` blob instead of being dropped: beads `owner` → `assignee` (falling back after an explicit assignee, else `metadata.beads_owner`), plus `metadata.beads_external_ref` (linked GitHub issue/run) and `metadata.beads_started_at`; `design`/`assignee` land on their Kernel columns. The loader also tolerates a split `.beads` layout (events under `.beads/backup/`, interactions at `.beads/interactions.jsonl`) so neither sidecar is silently half-read. As a result `forge migrate` reports **no data-loss gap for events or interactions**, and the dry-run/import summaries surface an `events` count. The **only remaining reported gap is `dependencies.created_by`** (the Kernel dependency row has no creator column); beads-internal/derived fields such as `content_hash` are intentionally not carried (not user data).
- **Human gates are enforced by kernel EVENTS, not skill prose.** Three human gates — `gate.intent`, `gate.plan-approval`, `gate.merge` — are registered in the runtime graph (additive to the existing `gate.*-exit` set, so each is toggleable via `workflow.gates.<id>.enabled` and surfaced by `forge options gates`). New verbs record and query approval as durable kernel events on the issue: `forge gate approve <issue> <gate>` writes a `gate.approved` event and `forge gate reject <issue> <gate> [--reason <text>]` writes a `gate.rejected` event (both carrying the resolved actor; idempotent per issue+gate+actor+decision, so re-approving mints no duplicate). `forge gate status <issue> [--json]` lists an issue's gate events (who approved/rejected, when) — making gate state resume-safe after a compaction or crash. `forge gate check <issue> <gate>` is the reusable enforcement primitive a stage skill calls: it exits 0 iff the gate is disabled OR a `gate.approved` event exists, and non-zero (`gate <id> not approved for <issue>`) otherwise. Gate events are a pure append to the issue's event stream (they do not mutate the issue or participate in its revision CAS).
- `forge export --import` now **hydrates** the Kernel from a committed JSONL snapshot: it reads `.forge/kernel/*.jsonl` and upserts issues, comments, and dependencies into `kernel.sqlite`, so a fresh clone (whose `.git/forge/kernel.sqlite` is never cloned) restores its backlog from git instead of showing zero issues. The import is idempotent (upsert by id — re-importing applies nothing and never duplicates) and honors the versioned manifest (a snapshot whose `schema_version` is newer than this forge understands is refused with a clear message). The projection now carries `created_by` for author fidelity on round-trip (`schema_version` bumped 1 → 2; older v1 snapshots still import, with `created_by` defaulting to null). (#276)
- **Opt-in conditional auto-merge rules engine (default OFF).** A new pure evaluator `lib/merge-rules.js` — `evaluateMergeRules(prContext, rules) → { allowed, unmet }` — decides whether a PR may merge by ANDing a list of composable, config-driven rules over an already-fetched PR context (no network in the evaluator). Built-in rule types: `checks_green`, `threads_resolved`, `not_behind`, `no_conflicts`, `not_draft`, `min_approvals:N`, `settle_min:N` (quiet since the last comment), `idle_min:N` (quiet since the last activity), `last_comment_by:X`, `approved_by:[..]`, `not_commented_by:[..]`, composed with `any_of:[..]` groups and a `not:` wrapper; an unknown or malformed rule, or unreadable context, is surfaced as unmet (fail-closed). `checks_green` is bare (all checks must be green) or scoped — `{ checks_green: { ignore: [...] } }` exempts the named checks, `{ checks_green: { only: [...] } }` requires only the named checks (both together is malformed → fail-closed). A thin `forge merge --auto <pr>` command reads the opt-in `merge.auto` section of `.forge/config.yaml` (`{ enabled: false, rules: [...] }`), fetches the PR context via `gh` behind an injectable seam, and merges **only** when `enabled === true` **and** every rule passes — printing the unmet rules and doing nothing otherwise. Two safety layers wrap the decision: a pre-flight guard that no-ops on an already merged/closed PR (idempotent re-runs), and a TOCTOU live re-check that re-fetches and re-evaluates immediately before merging so a since-changed PR is never merged from a stale snapshot. Absent config or `enabled` not true is a strict no-op, so the test-enforced never-auto-merge-by-default invariant is preserved; it merely promotes the proven `settle-merge.sh` baseline to a native capability. Documented follow-ups (not built): the bring-your-own custom-predicate seam (`forge add`), an opt-in `auto_update` executor (update-branch when behind → wait CI → re-check → merge), required-checks scoping for `checks_green` (read the branch-protection required set), a configurable merge `method` (squash/merge/rebase), and post-merge branch deletion.
- **`smith` orchestrator super-skill.** A new flagship skill (`skills/smith/SKILL.md`, registered through the `kernel` umbrella and mirrored into the generated agent skill dirs) that COMPOSES the existing stage skills — `triage-ready` → `claim-safety` → `plan` → `dev` → `validate` → `ship` → `review` → `verify` — into the right path for a piece of work, driving autonomously BETWEEN human gates and pausing AT them. It invents no stage logic: it picks the path by change classification, enforces the three human gates as durable kernel events (`forge gate check|approve|reject|status <issue> <gate>` over `gate.intent` · `gate.plan-approval` · `gate.merge`, so a gated run is resume-safe across compaction), proves lease ownership before and after work via `claim-safety`/`forge issue owns`, and certifies `forge release check` before close. During the planning phase `smith` **calibrates the human-loop density** from the issue's size × importance × complexity, proposing an autonomy tier (lean / standard / high) — i.e. which gates to enforce — at the intent gate; the human confirms or overrides, and a low-confidence read fails toward MORE oversight. A `## Fork points` section documents the stakes heuristic, the tier → gate-set mapping, gate density, and the composed flow so users can re-carve the assembly. This is a skill doc — no new stage code. (kernel 7da81cbd)

### Changed

- **BREAKING (default output only): `forge ready`, `forge list`/`forge issue list`, and `forge show` are human-first.** These reads now default to a compact text rendering (aligned `ID / TYPE / STATUS / PRIORITY / TITLE` columns with 8-char UUID prefixes for ready/list; a full detail view — including the FULL issue id — for show) instead of printing the raw `forge.issue.v1` JSON envelope. The kernel contract is unchanged and byte-identical behind `--json` (or `FORGE_JSON=1` for scripts that cannot alter argv); mutations and the other reads (`blocked`, `stale`, `search`, `stats`, …) keep their existing output. Check-after-write `verified:false`/`mismatches` outcomes are surfaced as a WARNING block in the text rendering, never hidden. Approved ahead of the 0.1.0 API freeze. (kernel a9bbd065)
- **Review-thread resolution machinery is now named agent-agnostically.** Renamed `.claude/scripts/greptile-resolve.sh` → `.claude/scripts/review-resolve.sh` and `.claude/rules/greptile-review-process.md` → `.claude/rules/review-process.md`. The helper always resolved GitHub PR review threads from ANY author — CodeRabbit, Qodo, Greptile, or a human — via GraphQL/REST; the old naming misleadingly implied it was Greptile-specific. The `review` and `shepherd` skills (canonical + generated `.codex` mirror), the review-process rule, and the manual/Greptile review guides now describe review threads in tool-neutral language, keeping Greptile as one supported example rather than THE brand. All in-repo references point at the new names (`lib/adapters/pr-state-adapter.js` default script path, `lib/reset.js` inventory, `lib/commands/setup.js` scaffold list, and the affected tests). Greptile-the-product surfaces are intentionally unchanged: `lib/adapters/greptile-review-adapter.js`, `lib/greptile-match.js`, the `greptile-quality-gate.yml` workflow, and `GREPTILE_SETUP.md` still document Greptile as a specific supported review tool. (092098de)
- Internal de-stage of pre-merge: the AGENTS.md/Cursor workflow generator, the plugin catalog, `forge recommend`, and the harness capability matrix no longer model pre-merge as a standalone `/premerge` stage or command. Pre-merge is now consistently presented as a documentation gate embedded in `/ship` and `/review`. Legacy `currentStage: 'premerge'` workflow state still round-trips on read, and the release-readiness gate now certifies the de-stage across those generator/taxonomy surfaces. (#275)
- Pre-merge is presented as an embedded documentation gate inside the `/ship` and `/review` stages — not a numbered workflow stage, and not an invokable `/premerge` command. (#269)
- Packaging: added an `engines.node` requirement of `>=22.16.0`, excluded a stray test file from the published npm tarball, and documented the `forge doc-gate` command. (#271)
- PR template `## Beads` section replaced with kernel-native `## Issue` (link with `Closes <forge-issue-id>`); `CONTRIBUTING.md` issue-tracking section updated to `forge issue …`; `/verify` Step 8 language de-beaded and auto-close matcher extended to also match kernel UUID issue IDs (`[0-9a-f]{8}-...-[0-9a-f]{12}`) in addition to short `prefix-xxx` form.

### Fixed

- The stderr notice `Non-interactive mode: using default agent selection (all)` no longer prints on every command run by a non-TTY agent/CI. It is debug-only now: pass `--verbose` or set `FORGE_DEBUG=1` to see it. Plain commands are silent apart from their own output. (kernel a9bbd065)
- Concurrent agents can now genuinely contend for a Kernel issue lease. The CLI issue path wired no per-agent identity into the Kernel, so every claim used the shared `forge` actor default; two agents claiming the same issue produced an identical `claim.create:<id>:forge` idempotency key, and the second claim replayed as an idempotent duplicate (`ok:true`) instead of a lease conflict — the loser was told it had won. Forge now resolves a distinct per-agent actor (`FORGE_ACTOR` → `FORGE_SESSION_ID` → the historical `forge` default) and threads it (plus a session id when present) into the mutation context, so a second distinct claimant reaches the `claim_conflict` path (`ok:false`, exit `4`) while a same-actor retry stays idempotent. With no env set the actor is unchanged, so existing behavior is preserved. (kernel d71a824b)
- The canonical stage skills (`/plan`, `/dev`, `/validate`, `/ship`, `/review`) no longer hard-gate their exit criteria on Beads shell scripts, so a model following them on the kernel-native default is not blocked. Design/acceptance capture now uses native Kernel fields (`forge update <id> --design ...` / `--acceptance ...`); stage-transition and context-validation steps invoke the `beads-context.sh` helper only when present (kernel-native `forge comment` / `forge issue show` otherwise); and the `dep-guard` contract/ripple review is advisory and skipped (non-fatal) when its tooling is unavailable. `Beads issue` wording across the stage surface is now `Forge issue`. (#279)
- Kernel JSONL projection now round-trips the **full `kernel_issues` column set** (labels, assignee, closed_at, close_reason, parent_id, sprint_id, release_id, stage_state, acceptance_criteria, estimate, design, notes, metadata) instead of the previous 12-key subset, so `forge migrate --from beads` → `export` → hydrate no longer silently drops beads-carried fields. `schema_version` bumped 2 → 3 (additive; v1/v2 snapshots still import, with the newer columns defaulting to null). (#278)
- `forge export` now projects Kernel issues to git-tracked JSONL (command-dispatcher broker injection + `jsonl` projection-outbox target), so the Kernel's git-persistence/portability loop works end to end. (#270)
- `forge plan` no longer mislabels kernel-created issues as "Beads": the result now carries backend-accurate `issueId` and `issueBackend`, and the printed label reflects the active backend ("Kernel:" vs "Beads:"). `beadsIssueId` is retained as a deprecated alias of `issueId` for backward compatibility.
- `skills-sync` setup (`populateAgentSkills`) now pre-clears a pre-existing dangling symlink sitting at a target skill path before copying, fixing skill-sync failures caused by that cruft. Only symlinks are removed — real directories with content are never deleted.
- Corrected a stale `.gitignore` comment that described agent skill directories as "junctions/symlinks"; they are populated at setup time as real file copies.

#### Migration notes

- Existing `.beads` data is no longer read unless Beads is explicitly selected.
- Opt back in to Beads (precedence: highest first) with the CLI flag `--issue-backend beads`, the environment variable `FORGE_ISSUE_BACKEND=beads`, or the `.forge/config.yaml` key `issueBackend: beads`.

## [0.0.11] - 2026-06-03

This is the public documentation and positioning release.

#### User value

- Reframes Forge as a local runtime control plane for AI-assisted engineering, not only a fixed TDD stage ladder.
- Makes the repository docs the canonical source for README, quickstart, support, command reference, release flow, and DeepWiki indexing.
- Gives new users a clearer first-run path for `forge init`, `forge setup`, `forge status`, Beads/GitHub sync, worktrees, validation, and PR review workflows.
- Adds support paths for setup failures, Beads/Dolt recovery, protected state, branch protection, worktree cleanup, and validation failures.

#### Migration notes

- Treat `/plan -> /dev -> /validate -> /ship -> /review -> /verify` as an agent workflow template. Pre-merge is a documentation gate embedded in `/ship` and `/review`, not a numbered stage. Do not assume every stage is a standalone `forge <stage>` CLI command.
- Use `forge init` for the `.forge/` adoption skeleton and `forge setup` for agent instructions, Beads/GitHub sync scaffolding, and harness files.
- Use `--agents`, not the stale singular `--agent`, when documenting or invoking setup.
- Internal roadmap labels such as `0.0.19` are future planning labels, not current public package availability.

#### Feature flags and experimental areas

- Protected-state enforcement is active only where the protected-state checker is wired into hooks or CI.
- `forge migrate` is a dry-run proof of concept.
- Review adapters currently support the review-adapter contract and Greptile-shaped starter template.
- Greptile, SonarCloud, branch protection, and GitHub sync depend on repository configuration and credentials.

#### Known limitations

- Beads/Dolt state can fail independently of Git state; use the support guide before changing issue metadata.
- Windows worktrees can leave locked Dolt or tool processes behind during cleanup.
- DeepWiki is generated from repository files and can lag behind `master` after merge.
- Some stage enforcement remains agent/harness dependent.

#### Rollback path

- Revert this release PR if the combined package metadata and public docs create release confusion.
- Do not publish the package unless the version bump, changelog entry, and public docs describe the same public release.
- If generated DeepWiki output keeps old TDD-only framing after refresh, file a follow-up issue and correct the repository docs first.

#### Adapter compatibility

- Existing issue wrappers continue to use Beads as the local/reference issue adapter.
- Existing Greptile review shell compatibility remains documented as the current review-adapter starter path.

#### Post-merge DeepWiki checklist

- Refresh DeepWiki after merge to `master`.
- Confirm the DeepWiki index date and commit changed to the merged commit.
- Compare generated Overview, Getting Started, Core Concepts, and workflow pages against `README.md`, `QUICKSTART.md`, `docs/INDEX.md`, `docs/guides/WORKFLOW_TEMPLATES.md`, `docs/reference/SKILLS.md`, and `docs/reference/COMMANDS.md`.
- File a follow-up issue if generated docs still describe Forge as only the old seven-stage TDD workflow.

### Added

- **Normalized shared GitHub/Beads issue sync state** (PR #134, forge-nlgg): added canonical link reconciliation and shared import primitives so steady-state GitHub sync and existing-issue import use the same normalized issue contract

### Fixed

- **Embedded Dolt worktree contention** (PR #146, forge-besw.18): switched this repo's Beads metadata to embedded Dolt mode, documented the local worktree contention failure mode, and updated workflow command surfaces to the current `docs/work/YYYY-MM-DD-<slug>/` planning structure
- **Historical plan file path contract** (forge-ddk3): earlier work unified `.claude/plans/` references to `docs/plans/`; current v0.0.11 docs use `docs/work/YYYY-MM-DD-<slug>/` as the canonical planning artifact path, with older path references treated as compatibility or historical notes
- **ENHANCED_ONBOARDING.md** (forge-3tnu): Rewrote to match actual 7-stage workflow with correct `--type` values (critical|standard|simple|hotfix|docs|refactor)
- **smart-status.sh jq errors**: Handle numeric priorities (0-4) and null types from beads 0.62+ — no more `string/number cannot be iterated` crashes
- **smart-status.sh display**: Numeric priorities now display as `P2` not `2` in dashboard; numeric `4` correctly groups into BACKLOG
- **Plan detection**: `forge status` no longer misdetects plan stage from unrelated files in `docs/plans/` — scopes to current branch slug
- **OWASP docs**: Fixed path-traversal risk in allowlist, clarified mitigations as collective requirements, corrected git `--` separator placement

### Changed

- **Forge Kernel authority plan reset** (PR #191, forge-2agy.8): reframed the post-0.0.18 release train around Forge Kernel authority, local SQLite broker boundaries, Cloudflare team authority, Beads import/export compatibility, provider capability contracts, and decision drift guards.
- **Ambiguity policy**: Hardcoded rubric scoring (>= 80% proceed, < 80% ask) as default in `/plan` — removed redundant per-feature Q&A question

## [0.0.5] - 2026-03-22

### Added

- **Install-fixes: hardened setup, Beads sync, documentation overhaul**
  - `--dry-run` flag: preview setup actions without writing files
  - `--non-interactive` flag: skip all prompts, use defaults; auto-enabled when `CI=true`
  - `--symlink` flag: create CLAUDE.md as a symlink to AGENTS.md instead of a copy
  - `--sync` flag: scaffold Beads GitHub sync workflow with PAT setup
  - `--agents=<list>` flag: comma-separated agent selection (e.g., `--agents=claude,cursor`)
  - `ActionCollector` and `isNonInteractive` utilities for setup orchestration
  - Beads config writer utilities for programmatic `.beads/config.yaml` generation
  - Beads health check smoke test after initialization
  - Defensive `bd init` wrapper with hook preservation
  - Auto-detect default branch and Beads version for sync workflows
  - Guided PAT setup for Beads sync via `gh` CLI
  - Beads sync scaffolding during `forge setup --sync`
  - Husky detection and automated migration to Lefthook
  - Documentation consistency tests (`test/docs-consistency.test.js`)

### Changed

- **Install command**: `bun install forge-workflow` changed to `bun add -D forge-workflow` (dev dependency)
- **install.sh**: Deprecated to thin bootstrapper that installs forge-workflow and delegates to `bunx forge setup`
- **Lefthook check**: Now verifies binary existence, not just package.json entry
- **CLAUDE.md merge**: `smartMergeAgentsMd` preserves existing CLAUDE.md without markers
- **README.md**: Added Setup Flags table documenting all new CLI flags
- **docs/SETUP.md**: Added Beads sync section with PAT requirements and `BEADS_SYNC_TOKEN` documentation
- **Sync scripts and workflow templates**: Added to npm package `files` array

### Fixed

- Lefthook check verifies binary existence, not just package.json entry
- `smartMergeAgentsMd` preserves existing CLAUDE.md without markers
- Sync scripts and workflow templates added to npm package

## [0.0.4] - 2026-03-22

### Added

- **Multi-dev session awareness: conflict detection, parallel work visibility** (PR #92, forge-w69s)
  - Pluggable sync backend (`refs`/`branch`/`inline`) for cross-developer beads sync via git
  - File index (`.beads/file-index.jsonl`) tracks which developer touches which files/modules
  - Conflict detection script with module-level overlap warnings and `--detail` drill-down
  - Cross-developer "Team Activity" section in `/status` with overlap and staleness warnings
  - Soft-block gates on `/plan` and `/dev` entry when module overlap detected
  - Auto-sync at Forge command entry pulls latest team state
  - Session identity as `email@hostname`, sync branch auto-detection with config override
  - 136 new shell tests across 5 test suites

- **Smart Setup UX: agent detection, incremental setup, clean output** (PR #90, forge-iv8b)
  - 4-layer agent auto-detection: `AI_AGENT` env > agent-specific env vars > VSCode path parsing > config file signatures (8 agents)
  - Incremental setup: content-hash comparison skips identical files on re-run; `--force` flag for CI/overwrite
  - Progressive summary output: clean 3-line default, `--verbose` for file-by-file detail
  - Lazy directory creation: `docs/planning/` and `docs/research/` created on first `/plan` use, not at setup
  - Worktree detection utility: prevents nested worktree creation in `/plan`
  - 5 new lib modules: `detect-agent.js`, `setup-action-log.js`, `file-hash.js`, `detect-worktree.js`, `setup-summary-renderer.js`
  - 124 new tests across 9 test files

### Removed

- **`docs/WORKFLOW.md`** — content duplicated in `AGENTS.md`; all 50+ references updated (PR #90, forge-iv8b)

### Fixed

- **Smart-status.sh jq date parsing** for fractional seconds + timezone offsets (PR #90, forge-iv8b)
- **CI bypass workflow** — removed `test/**` from `paths-ignore` to unblock test-only PRs (PR #90, forge-iv8b)
- **Ship command rebases onto latest base branch before push** (PR #89, forge-ebls)
  - `/validate` entry gate: rebases onto base branch (detected dynamically) before running checks
  - `/ship` freshness check: lightweight behind-check before push, alerts if stale
  - Fetch failures caught with `|| { exit 1; }` guards
  - `bun run check` clarified as checks-only (no rebase)

### Changed

- **PR template restructured to narrative format** (PR #89, forge-ebls)
  - Visible: Problem → Root Cause → Fix → Value → Beads
  - Collapsible `<details>`: Test Coverage, Security Review, Design Doc, Decisions Log, Documentation Updated, Validation checklist
  - Tips section updated to reinforce narrative-first approach

### Added

- **Workflow Intelligence: smart status, phase tracking, naming clarity** (PR #72, forge-68oj)
  - `scripts/smart-status.sh`: Ranks all issues by composite score (priority × unblock chain × type × status boost × epic proximity × staleness)
  - Grouped output: Resume → Unblock Chains → Ready Work → Blocked → Backlog with ANSI colors and NO_COLOR support
  - Active session detection: parses `git worktree list --porcelain`, maps branches to in-progress beads issues
  - Two-tier conflict detection: Tier 1 (file-level overlap via `git diff`) + Tier 2 (actual merge conflicts via `git merge-tree`, git 2.38+)
  - `/plan` now creates epic at Phase 1 entry with stage transitions at each phase boundary
  - `/status` updated to use `smart-status.sh` for dynamic ranked output
  - Disambiguation note added to `/validate` command (three concepts: /validate, forge-preflight, bun run check)
  - Auto-detect default branch (master/main) with `DEFAULT_BRANCH` env override
  - Reverse dependency map computes "Unblocks:" annotations from actual dependency data
  - 67 new tests, 0 regressions

### Changed

- **CLI prerequisite checker renamed to `forge-preflight`** (PR #72, forge-0xic)
  - Clearer name distinguishes it from `/validate` workflow command and `bun run check`
  - Updated: bin entry, package.json, README, CHANGELOG, DEVELOPMENT, docs/VALIDATION, docs/research/
  - Fixed pre-existing bug: `validateDev` now checks `docs/plans/` (was `.claude/plans/`)
  - Fixed Node compat: removed `readdirSync({ recursive })` (requires Node 18.17+)

- **Dynamic commands rule** (PR #72)
  - Added to AGENTS.md and CLAUDE.md: never hardcode example output in command files when scripts generate it dynamically

### Fixed

- **P2 bug fixes: setup, postinstall, dead config, lint hooks** (PR #69, forge-cpnj + forge-iv1p + forge-8u6q + forge-zs2u)
  - Setup code paths unified: extracted `executeSetup()` shared helper, fixed claude agent being skipped in CLI path
  - Removed `postinstall` script — no more surprise file writes on `npm install`
  - Added `[FORGE_SETUP_REQUIRED]` first-run detection with exit code 1
  - Added `--yes`/`-y` flag for non-interactive setup (AI agent friendly)
  - Removed dead `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` config objects
  - Replaced `npx --yes eslint` in lint.js with package manager delegation (eliminates supply chain risk)
  - Added `--max-warnings 0` to package.json lint script
  - Added `--version`/`-V` flag handling
  - Exempted `recommend` command from first-run guard (read-only, useful for onboarding)
  - 38 new tests (1676 → 1714)

- **Stage naming consistency + COMMANDS array fix** (PR #67, forge-7lvz + forge-b262)
  - Replaced hardcoded COMMANDS array with `getWorkflowCommands()` — scans `.claude/commands/*.md` at runtime
  - Fixed stale `/check` → `/validate` and `/merge` → `/premerge` in CURSOR_RULE and `.cursorrules`
  - Dynamic copy/convert counts — reports actual successes, not filesystem count
  - `copyFile` now always warns on missing sources (was DEBUG-only)
  - Fixed CLAUDE.md placeholder description
  - Fixed README agent count: "7" → "8" to match `lib/agents/`
  - 24 new regression tests across 2 test files

- **Hook bypass protection for AI agents** (PR #66)
  - `scripts/branch-protection.js`: Allow beads-only pushes to master while blocking code changes
  - Replaced `execSync` with `execFileSync` + `resolveGitBinary()` to prevent command injection
  - Added `isSafeGitRefComponent()` validation on all branch name paths
  - Gated `FORGE_GIT_MOCK_JS` behind `NODE_ENV=test` to prevent bypass in production
  - Removed `LEFTHOOK=0` and `--no-verify` bypass guidance from all hook scripts
  - Added behavioral integration tests with cross-platform mock git (Node.js shim)
  - Updated `CLAUDE.md`: AI agents must never bypass hooks

### Added

- **Logic-level dependency detection**: Upgrades dep-guard `check-ripple` from keyword-only matching to structured code-aware analysis (PR #65, forge-9zv)
  - `lib/dep-guard/analyzer.js`: Phase 3 structured analyzer — scores dependencies across import, contract, and behavioral dimensions
  - `lib/dep-guard/import-detector.js`: Traces actual `require`/`import` statements between task files using `@babel/parser`
  - `lib/dep-guard/task-parser.js`: Extracts file-to-function mappings from task list markdown
  - `scripts/dep-guard-analyze.js`: CLI entry point for the structured analyzer
  - `apply-decision` subcommand: Beads approval flow with cycle detection, rollback, and state persistence
  - Graceful fallback: structured analyzer failure falls through to keyword-only check
  - 107+ new tests covering analyzer, import detector, and approval flow

- **Command behavioral eval + improvement loop**: Automated testing infrastructure for slash commands with LLM-based grading (PR #63, forge-agp)
  - `scripts/run-command-eval.js`: E2E eval pipeline — runs commands in isolated worktrees, grades transcripts against assertions
  - `scripts/improve-command.js`: Semi-autonomous improvement loop with pause-on-regression and cross-session eval history
  - Three assertion types: standard (output correctness), HARD-GATE (gate enforcement), contract (cross-command pipeline integrity)
  - `.claude/agents/command-grader.md`: LLM grader agent with strict grading guidelines
  - Eval sets for `/status` and `/validate` as first targets
  - 110 new tests across 10 test files, all passing

- **Pre-change dependency guard**: Contract-aware ripple analysis that detects logic conflicts between in-flight issues before work begins (PR #62, forge-mze)
  - `scripts/dep-guard.sh`: 4 subcommands — `find-consumers`, `check-ripple`, `store-contracts`, `extract-contracts`
  - `/plan` Phase 1: Advisory ripple check before design Q&A surfaces overlapping open issues
  - `/plan` Phase 3: Auto-extract contracts from task list and store on Beads issue
  - Ripple Analyst agent prompt: LLM-judged impact analysis (NONE/LOW/HIGH/CRITICAL)
  - Keyword matching with stop-word filtering, timestamp-based contract dedup
  - 29 tests covering all subcommands with mock-based `BD_CMD` testing pattern

### Fixed

- **Roo Code rootConfig conflict**: Changed from `.clinerules` to `.roorules` — was conflicting with Cline during setup (PR #61)
- **Cline workflows directory clash**: Moved from `.clinerules/workflows/` to `.cline/workflows/` — `.clinerules` was being created as a directory, blocking the root config symlink (PR #61)
- **Symlink safety**: `createSymlinkOrCopy` now uses `lstatSync` to avoid false positives on symlinks to directories, with actionable warning for users (PR #61)
- **Cross-codepath sync**: Updated `sync-commands.js`, `install.sh`, tests, and sync manifest to match new Cline/Roo paths (PR #61)

### Changed

- **Version reset to 0.0.1**: All prior npm versions (1.0.0–1.5.0) unpublished; clean alpha start (PR #61)
- **Removed `.clinerules` flat-file migration**: No longer needed since Cline workflows moved to `.cline/workflows/` (PR #61)

### Added

- **Beads-embedded plan context**: Auto-populate design/notes/acceptance in Beads issues from `/plan` and `/dev` (PR #59, forge-bmy)
  - `scripts/beads-context.sh`: Agent-agnostic helper with 5 commands (`set-design`, `set-acceptance`, `update-progress`, `parse-progress`, `stage-transition`)
  - `/plan` Phase 3: Embeds task count + file path in `--design`, success criteria in `--acceptance`
  - `/dev` Step E: Appends per-task progress (title, tests, commit, gates) to `--notes` as HARD-GATE
  - `/status`: Shows compact progress ("3/7 tasks done | Last: title (sha)") with `bd show` hint
  - Stage transitions recorded via `--comment` at `/plan`, `/dev`, `/validate`, `/ship`, `/review` exits
  - `scripts/**` added to CI test workflow path filters
- **`forge check-agents` CLI**: Validates all agent command files are in sync and plugin catalog matches reality (`node scripts/check-agents.js`) (PR #60, forge-2w3)

### Changed

- **Plugin catalog**: Updated capability flags for 6 agents — Cursor, Cline, Copilot, Kilo Code, Codex now correctly report `commands: true`; Claude Code reports `hooks: true` (PR #60, forge-2w3)

### Removed

- **Dropped agent cleanup**: Removed all code, config, docs, and files for 4 dropped agents — Antigravity, Windsurf, Aider, Continue (PR #60, forge-2w3)
  - Deleted: `.aider.conf.yml`, `lib/agents/continue.plugin.json`, `docs/README-v1.3.md`, `docs/research/agent-instructions-sync.md`
  - Cleaned: `bin/forge.js` (Continue setup), `packages/skills/` (agent entries), `package.json` (keywords), `.gitignore` (dropped dirs)
  - Fixed: `package.json` description from "9-stage" to "7-stage"

### Fixed

- **Stale workflow refs**: Cleaned up references to removed tools and orphaned files in agent commands (PR #56, forge-ctc)
  - `status.md`: Replaced openspec/PROGRESS.md commands with Beads equivalents, fixed /research → /plan
  - `rollback.md`: Updated workflow diagrams to correct 7-stage pipeline (removed /research)
  - `premerge.md`: Replaced PROGRESS.md reference with CHANGELOG.md maintenance step
  - Fixed inconsistent example output in status.md (in-progress work vs "Ready for new feature")

## [1.5.0] - 2026-02-03

### Added

- **Plugin Architecture**: 11 specialized agent plugins for enhanced capabilities
  - `javascript-typescript`: JavaScript/TypeScript expertise (4 skills)
  - `backend-development`: API design, microservices, Temporal workflows (9 skills)
  - `database-design`: PostgreSQL, SQL optimization (2 skills)
  - `security-scanning`: SAST, threat modeling, STRIDE analysis (6 skills)
  - `full-stack-orchestration`: Deployment, performance, testing (4 skills)
  - `tdd-workflows`: TDD orchestration, code review (2 skills)
  - `llm-application-dev`: RAG, embeddings, prompt engineering (7 skills)
  - `frontend-design`: Production-grade UI development (1 skill)

- **TDD Enforcement**: Git hooks via Lefthook
  - Pre-commit hook checks for test files before allowing source commits
  - Pre-push hook runs full test suite
  - Interactive prompts for violations with recovery options
  - CI/CD-aware: auto-aborts in non-interactive environments
  - Package manager auto-detection (bun/pnpm/yarn/npm)

- **Preflight CLI**: `forge-preflight` command
  - `forge-preflight status` - Check project prerequisites
  - `forge-preflight dev` - Validate before /dev stage
  - `forge-preflight ship` - Validate before /ship stage

- **Auto-Installation**: Beads and OpenSpec setup
  - Quick setup mode auto-installs Beads
  - Interactive setup prompts for both tools
  - Dynamic tool status in project summary

- **AGENTS.md Enhancements**: Optimized universal instructions
  - Plugin loading instructions
  - Workflow stage documentation
  - Security and TDD guidelines

### Improved

- **Test Patterns**: Comprehensive test file detection
  - Nested directories: `test/unit/`, `test/integration/`
  - Colocated tests: `__tests__/` directories
  - Both `.test` and `.spec` variants

- **Error Handling**: Safer recursive file operations
  - Try/catch for directory reads
  - Graceful failures in validation

### Fixed

- Non-TTY environment handling in TDD hook (CI/CD compatibility)
- Silent failure in lefthook prepare script (now shows informative message)

## [1.4.9] - 2025-02-02

### Fixed

- **Code Quality Overhaul**: Resolved 101 SonarLint and linting warnings
  - Fixed 42 structural warnings (exception handling, control flow, code patterns)
  - Fixed 35 cognitive complexity warnings by extracting 47 helper functions
  - Modernized JavaScript patterns (Number.parseInt, Number.isNaN, optional chaining)
  - Applied node: protocol for all built-in module imports
  - Improved exception handling with meaningful comments
  - Converted negated conditions to positive logic
  - Fixed nested ternary operations and if-in-else blocks

### Refactored

- **8 Core Functions** - Reduced cognitive complexity from 24-57 to 5-10:
  - `detectProjectType()` - 27→8 (14 helpers: framework detection, feature detection)
  - `handleInstructionFiles()` - 37→5 (6 helpers: scenario handlers)
  - `setupAgent()` - 40→8 (10 helpers: agent-specific setup, file operations)
  - `interactiveSetup()` - 36→8 (9 helpers: UI, validation, workflow)
  - `main()` - 24→10 (5 helpers: CLI parsing, setup orchestration)
  - `extractUserSections()` - 25→8 (2 helpers: marker/command extraction)
  - `performRollback()` - 32→10 (7 helpers: method-specific handlers)
  - Plus 1 additional function refactored

### Improved

- **Maintainability**: Single responsibility principle applied throughout
- **Testability**: 47 new focused helper functions can be tested independently
- **Readability**: Clear function names, reduced nesting, improved code organization
- **Code Quality**: Zero SonarLint warnings (except optional S7785 - CommonJS limitation)
- **Documentation**: Comprehensive inline comments for exception handling

### Changed

- Internal code structure significantly reorganized (no API changes)
- +1,056 lines (helper functions), -749 lines (refactored complexity)
- Net: +307 lines with better separation of concerns

## [1.4.8] - 2025-02-02

### Fixed

- **Additional markdown linting**: Expanded markdownlint configuration
  - Disabled MD031 (blanks around fenced code blocks)
  - Disabled MD032 (blanks around lists)
  - Disabled MD040 (fenced code language)
  - Disabled MD041 (first line heading level)
  - Disabled MD022 (blanks around headings)
  - Disabled MD060 (table column count)
  - Fixed .claude/skills/forge-workflow/SKILL.md formatting
  - Updated .markdownlint.json with comprehensive rule suppressions

### Improved

- Zero markdown linting warnings across all documentation
- Cleaner IDE experience with focused, actionable linting rules

## [1.4.7] - 2025-02-02

### Fixed

- **Line length warnings**: Disabled MD013 line-length rule
  - 80-character limit too restrictive for modern documentation
  - Especially problematic for changelog descriptions
  - Updated .markdownlint.json to disable MD013

### Improved

- Zero IDE warnings - completely clean development environment

## [1.4.6] - 2025-02-02

### Fixed

- **IDE linting issues**: Fixed all 100+ markdownlint warnings
  - Fixed table formatting in .clinerules (MD060 - proper spacing around pipes)
  - Added language specification to code blocks (MD040)
  - Added blank lines around lists (MD032)
  - Created .markdownlint.json config to suppress false positives in CHANGELOG.md

### Improved

- Clean IDE experience with zero linting warnings
- Proper markdown formatting across all documentation files

## [1.4.5] - 2025-02-02

### Changed

- **Automatic versioning**: Version now read from package.json (single source of truth)
  - Added VERSION constant from package.json
  - Replaced all hardcoded version strings with VERSION variable
  - No more manual version updates needed in bin/forge.js
  - Simply run `npm version patch/minor/major` to bump version everywhere

### Improved

- Version management simplified - update package.json only
- Eliminates risk of version mismatch between package.json and displayed version

## [1.4.4] - 2025-02-02

### Fixed

- **Version banner**: Updated all version strings from v1.3.0 to v1.4.4
  - Fixed version display in CLI banner
  - Updated all setup completion messages
  - Ensures correct version is shown to users

- **Documentation setup**: Fixed missing documentation files during `npx forge setup`
  - Created `setupCoreDocs()` helper function
  - Now copies docs/WORKFLOW.md to project during setup
  - Now copies docs/research/TEMPLATE.md to project during setup
  - Creates docs/planning/PROGRESS.md during setup
  - Applies to all setup modes: interactive, quick, and agent-specific

### Changed

- Extracted documentation setup logic into reusable `setupCoreDocs()` function
- All setup commands now provide complete documentation structure
- Users no longer need to reference node_modules for workflow templates

## [1.4.3] - 2025-01-31

### Fixed

- **Critical package fix**: Properly exclude local user settings from npm package
  - Updated package.json `files` array to explicitly include only necessary .claude/ subdirectories
  - Prevents .claude/settings.json and .claude/settings.local.json from being published
  - v1.4.2 still included these files due to `files` array overriding .npmignore

### Security

- **CRITICAL**: v1.4.0, v1.4.1, and v1.4.2 inadvertently published user-specific permission settings
  - Users who installed these versions should check if their .claude/settings*.json files were overwritten
  - These files are now properly excluded in v1.4.3+

## [1.4.2] - 2025-01-31

### Fixed

- **npm package cleanup**: Attempted to exclude local user settings (incomplete fix)
  - Added .npmignore (did not work due to `files` array in package.json)
  - See v1.4.3 for complete fix

## [1.4.1] - 2025-01-31

### Changed

- **README simplified**: Reduced from 860 to 316 lines (63% reduction)
  - Focused on value proposition and quick start
  - Removed detailed setup instructions (moved to docs/SETUP.md)
  - Removed lengthy examples (moved to docs/EXAMPLES.md)
  - Added clear "Next Steps" section with links to guides
  - Before/after comparison showing Forge value
  - Scannable in under 2 minutes

### Added

- **QUICKSTART.md**: Complete beginner guide (5-minute walkthrough)
  - Step-by-step first feature implementation
  - Actual commands with expected outputs
  - Health check endpoint example
  - All 9 stages demonstrated
- **docs/SETUP.md**: Comprehensive setup guide
  - All agent-specific setup instructions (11+ agents)
  - External services configuration (GitHub, SonarCloud, Greptile, etc.)
  - Beads and OpenSpec detailed setup
  - Troubleshooting section
  - Environment variables reference
- **docs/EXAMPLES.md**: Real-world workflow examples
  - Simple feature example (historical timing reference; not a current guarantee)
  - Bug fix with security (30 minutes)
  - Multi-file refactor (2-3 hours)
  - Architecture change with OpenSpec (2-3 days)
  - Team collaboration with Beads
- **docs/README-v1.3.md**: Archive of previous README for reference

### Improved

- Documentation now follows progressive disclosure:
  - Beginners → README + QUICKSTART.md
  - Intermediate → docs/EXAMPLES.md
  - Advanced → docs/SETUP.md + docs/TOOLCHAIN.md
- All technical content preserved, just better organized
- Easier to find specific information
- Better onboarding for new users

## [1.4.0] - 2025-01-31

### Added

- **Plan-Act-Reflect reminders**: Gentle reflection prompts in /plan, /dev, and /check commands
  - Non-intrusive blockquote format at critical decision points
  - Prompts to review research docs and consider complexity
  - "If unsure" conditionals to avoid being prescriptive
- **Smart project detection**: Auto-detect framework, language, tooling with confidence scores
  - Supports 12+ frameworks: Next.js, React, Vue, Angular, Svelte, NestJS, Express, Fastify, and more
  - Confidence scoring (60-100) with visual indicators (✓ for 90%+, ~ for lower)
  - Detects TypeScript, monorepo, Docker, and CI/CD configurations
- **AGENTS.md metadata**: Auto-populate with framework-specific tips and conventions
  - Framework-specific development tips (3 per framework)
  - Build tool detection (Vite, Webpack, Next, etc.)
  - Test framework detection (Jest, Vitest, Playwright, Cypress, etc.)
  - Automatic insertion after project description
- **Rollback system**: `forge rollback` command with USER section preservation
  - Interactive menu with 6 options
  - Comprehensive input validation for security
  - Automatic USER section extraction and restoration
  - Custom commands preservation in `.claude/commands/custom/`
- **4 rollback methods**:
  - Last commit: Quick undo of most recent change
  - Specific commit: Target any commit by hash
  - Merged PR: Revert entire PR merge with Beads integration
  - Partial rollback: Restore specific files only
  - Branch range: Revert multiple commits
- **Dry run mode**: Preview rollback changes without executing
  - Shows affected files
  - Lists USER sections that would be preserved
  - Lists custom commands that would be preserved
  - No git operations performed
- **Input validation**: Comprehensive validation for all rollback inputs
  - Commit hash validation (4-40 character hex strings or 'HEAD')
  - Path traversal protection using `path.resolve()` and `startsWith()`
  - Shell metacharacter rejection (`;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `<`, `>`, `\n`, `\r`)
  - Method whitelist validation
- **Beads integration**: Auto-update issue status on PR rollback
  - Parses commit message for issue number
  - Updates issue status to 'reverted'
  - Adds comment: "PR reverted by rollback"
  - Silently skips if Beads not installed

### Changed

- AGENTS.md now includes auto-detected project metadata after setup
- Setup completion message includes project detection results with confidence indicators
- COMMANDS array now includes 'rollback' for command file distribution

### Security

- Added comprehensive input validation for all rollback commands to prevent command injection
- Path traversal protection for file operations using canonical path resolution
- Commit hash format validation to reject malicious inputs
- Shell metacharacter rejection in all user-provided inputs
- Non-destructive rollback using `git revert` (never uses `git reset --hard`)

### Documentation

- Added `.claude/commands/rollback.md` with complete rollback documentation
- Updated `docs/WORKFLOW.md` with recovery section
- Added troubleshooting guide for common rollback issues
- Added examples for all rollback methods

## [1.3.1] - Previous Release

(Previous changelog entries would go here)
