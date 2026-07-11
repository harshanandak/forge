# Beta gate audit — half-cooked / confusing / undocumented surfaces

Epic: be7ce156 · Date: 2026-07-11 · Perspective: new non-expert beta user, any OS, any agent.

## TL;DR

A prior two-auditor pass already landed most P1 beta-blockers (18 epic issues, ~13
`done`). Verified on the current tree: unknown/mistyped commands now honestly error and
exit 1 (`forge bogusxyz|trace` -> "Unknown command", exit 1); the first-run hint now points
at `forge docs setup` (real topic); packaging leak, Hermes contradiction, and bun-only
QUICKSTART step are resolved. Remaining beta roughness is smaller and concentrated in three
new places below, plus four already-open items.

## New findings (filed this pass)

### P1 — `forge migrate` is half-implemented and leaks "Wave 0 PoC" jargon
- **Where:** `lib/commands/migrate.js:505`; advertised in `forge --help` as
  "Migrate a Beads issue store into the Forge Kernel, or preview the v2->v3 migration".
- **Symptom:** any non-dry-run `forge migrate` returns
  `Only forge migrate --dry-run is implemented in the Wave 0 PoC.` A beta user sees a
  first-class `--help` command that does nothing but emit internal roadmap jargon.
- **Fix:** either hide `migrate` from `--help` until it lands, or relabel it in help as
  "(preview only)" / experimental and reword the error to a user-facing message (drop
  "Wave 0 PoC").

### P2 — Bun-hardcoded remediation strings dead-end non-bun users
- **Where:** `lib/lefthook-check.js:58`, `:77`; `lib/runtime-health.js:525`.
- **Symptom:** the core stage verbs `plan`, `dev`, `ship`, `review` all gate behind
  `LEFTHOOK_MISSING` and instruct `Run: bun install` / `bun add -D lefthook && bun install`.
  An npm/pnpm/yarn user on any OS is told to run bun — a dead-end remediation on the exact
  commands the workflow revolves around.
- **Fix:** detect the project package manager (lockfile) and emit the matching install
  command, or present both (`npm install` / `bun install`).

### P2 — COMMANDS.md omits the entire core workflow loop
- **Where:** `docs/reference/COMMANDS.md` (178 lines).
- **Symptom:** the command reference documents ~13 verbs (init, setup, status, ready,
  clean, release, board, doctor, sync, explain, options, migrate, review) but is missing
  the loop a newcomer actually runs: `plan, dev, ship, prime, orient, recall, remember,
  recap, gate, hooks, export, insights, role, shepherd, merge, comment, patch`. The
  reference documents peripheral verbs and skips the center.
- **Fix:** add the workflow-loop verbs (at minimum plan/dev/ship/prime/orient/recall/
  remember) to COMMANDS.md, ideally generated from the registry so it can't drift.

### P3 — `forge recap <id>` prints usage + bare "Command failed"
- **Where:** `forge recap` with no/invalid id.
- **Symptom:** emits the usage line followed by a bare `Command failed` with no reason —
  confusing double message compared to the clean missing-arg messages elsewhere.
- **Fix:** single missing-arg message (match `forge remember` / `forge gate` style).

## Already-open (do not refile — tracked)
- `forge review` hidden bare verb leaks `.forge-state.json` internal path (P2, open).
- `forge --help` buries the status->claim->dev->ship loop below setup/recommend (P2, open).
- HOOKS_NOT_ACTIVE stage gate should accept native agent hooks, not only lefthook (P2, open).
- Reconcile `bin/forge.js` dead `minimalInstall` branch vs first-run gate (P3, open).

## Confirmed resolved (good news for beta)
Unknown-command exit 1; first-run hint -> `forge docs setup`; packaging local-path leak;
Hermes README/QUICKSTART contradiction; bun-only QUICKSTART step 1; stale Beads wording in
`--help`; filesystem-classifier scary wording; claim-no-id message; prime/orient jargon;
DEP0190 warning.

## Honestly-labeled not-yet-delivered (no action needed)
`forge sync` ("Local kernel is single-machine authority; no remote configured"), `forge
design` / `forge context` (error as unknown commands — tracked as separate build issues),
codex agents domain (`harness-capability-matrix.js` marks `not-delivered` with known-issue
ref). These fail honestly and are not misadvertised.
