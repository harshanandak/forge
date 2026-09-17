# Independent delivery-plan review

Date: 2026-09-17. Planning issue: `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`.
This is a bounded read-only review of the proposed work below, not implementation authorization.

## Review task

Critique the proposed first work wave for Forge developer throughput and correctness. Give GO or CHANGES_REQUIRED, followed by material findings with severity, exact change recommended, dependency order, and measurable exit conditions. Distinguish source evidence from inference. Do not write files, create or change issues, install tools, run tests, change machine settings, push, or open/merge PRs. Do not delegate. Limit research to the local sources named here and return a concise review. The lead will preserve your response and actual model attribution separately.

## Sources and live baseline

- Repository: `C:/Users/harsha_befach/Downloads/forge`.
- Tracked `origin/master`: `bd1abbd8ab63b590fd916dad379e0a575542fcc7`, fetched 2026-09-17. Use `git show origin/master:<path>` for product-source claims; the shared root contains user-owned changes.
- Prior saved analysis: `C:/Users/harsha_befach/Downloads/forge/.worktrees/architecture-research-checkpoint/docs/work/2026-09-15-delivery-environment/delivery-environment-analysis.md`.
- Existing push patch branch: `fix/push-resource-aware-docs`, clean registered worktree at `.worktrees/optional-skipped-merge/.worktrees/push-resource-aware-docs`, head `76a730435ff7cb867ebdcb6a0b607ec38064e43f`; commits `b330cbe7` and `76a73043` are not on origin/master. It has no open PR. Inspect existing patch; do not rebase/cherry-pick it.
- Prior audit found repeated hosted Windows Node22 package installation failure: `npm install --ignore-scripts <tarball>` reaches 60 seconds, returns null. Failed before merge, passed retry, failed merged master. Root cause is unknown; recent live checks are being refreshed by a separate reader.
- Existing `forge validate` full-run receipt binds clean worktree, exact head and runtime identity; valid receipt lets `forge push` skip duplicate tests, but retains lint/branch checks. Without a receipt `push` uses raw package test script instead of supervised runner. Do not replace generic consumer test commands with Forge-specific scripts.
- `.github/workflows/test.yml` affected `test-env` command currently masks failure with `|| true`.
- Existing full-suite runner uses resource-weighted scheduling; canonical validate does not expose its budget, and budgets below lane cost may be silently exceeded.
- Strict required GitHub checks remain enforced. User goal is sustainable 5-10 healthy PR landings/day; no measured throughput guarantee exists.

## Proposed sequence to challenge

1. Three independent preparation lanes: recover push-runner patch; diagnose/fix package install root cause; make CI edge failures reach required CI Gate. One owner per file; common runner/helper changes transfer to one lane and add explicit dependency.
2. Landing: fix package smoke first if it blocks required CI; CI propagation and push parity follow in whichever order their checks allow. Do not turn timeout increases, retries, missing aggregates, zero tests, or targeted tests into full-suite proof.
3. Next expose and enforce a supported validation resource budget through existing runner, retaining receipts and process cleanup. One broad local suite at a time initially; focused tests and coding may run concurrently when headroom permits.
4. Later connect risk selection and existing evidence mechanisms in shadow mode, then consolidate only demonstrated equivalent fixture/CI work. Do not add a second scheduler, generalized cache platform, dashboard, or remote execution service.
5. Proposed operating model: parallel development/review, one dependency-ready landing candidate refreshed and validated at a time, no blanket sibling rebases. Preserve final tested head plus integration/base verification and strict server protection.

## Critical policy conflict

Existing freshness issue `8d51c08b-8a02-480c-b6cd-d497deb769ea` explicitly requires behind=0 before dev, validate, ship and push, plus base advance invalidates previous validation. That conflicts with postponing updates until landing. The plan must propose a concrete policy amendment and have it accepted before applying it; do not quietly treat the existing acceptance as already changed. Determine whether a narrow initial wave can proceed under current rules while policy alignment is prepared.

## Graft question

Official sources checked previously: https://trailhq.com/graft and https://github.com/trailhq/Graft/blob/main/README.md . Graft is a local source graph with tree-sitter, content-hash parse caching, caller/blast-radius queries and optional model summaries. It addresses repeated exploration, not test result caching or execution. Its setup changes agent files/hooks; even `build` modifies `.gitignore`. Proposed evaluation uses a pinned disposable clone, no automatic agent setup, structural mode only, telemetry disabled. Compare current source search plus saved research against same baseline plus Graft on fixed routing/receipt/cancellation/package/CI questions. Include graph build/refresh overhead and branch/edit/delete/worktree freshness; graph omissions cannot justify skipping mandatory tests. Proposed 20% median exploration-time or token gain is an experimental promotion criterion, not a proven benefit. Decide whether this is worth doing alongside the first wave or deferring.

## Existing implementation issue owners

- Push parity: `11e5ef49-5ae3-4cd0-a32e-0f233fc00ce8`, in_progress/validate.
- Package smoke: `48386b65-4cab-4e75-9363-07a352e5997e`, open.
- CI failure propagation: `ff0985f9-db02-482c-a08a-1a593e04cc88`, open.
- Budget: `e0cb0671-735c-4980-944b-286d6f78fe48`, open.
- Existing receipt reuse: `4aed2cc8-57eb-451b-bb3a-02bbdd93af49`, in_progress/review, source already present.
- Durable terminal aggregate: `204fbfee-82d0-4504-bc45-f70a831108a4`, in_progress/validate.
- Evidence ledger: `9072274f-a14f-4518-b7b1-15eae0eba97d`, open.
- Pipeline umbrella: `2e2dd4e8-5144-4d77-9c7d-67dee25d7c6b`, open and blocked by existing prerequisites.

## Required response

Address the current freshness-policy conflict, patch recovery, file and logical overlap, integrity of receipt reuse, smallest package-failure investigation, required negative tests, Graft pilot value, Windows/Linux measurement, and what actually blocks implementation. Prefer a small executable plan; a new architectural system is outside scope. A planning review cannot prove the proposed speedup or certify unrun behavior.
