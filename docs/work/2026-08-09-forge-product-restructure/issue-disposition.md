# Forge 0.1.0 Issue Disposition

Status: planning snapshot; no issue is closed, migrated, or deferred by this document.

Snapshot evidence:

- Kernel snapshot SHA-256: `6a534378e84d4588cb06667f0d9dac7ddc4771c3e2b46b60cac0c716557f5ce4`
- 1,168 total issues; 522 open or in progress; maximum issue revision 5
- 80 explicitly classified rows: 73 architecture/control candidates, four release/root rows, and three close/supersede audits
- Five architecture/control candidates are explicitly deferred
- The `0.1.0` train therefore contains 68 architecture/control issues plus three release-gate work issues: 71 actionable issue outcomes, consolidated into seven milestones/eight cohesive PRs—not 71 PRs
- The 71 are candidate issue records, including epics and their children; they are not 71 independent code changes and receive no double completion credit
- The stable-release root issue tracks promotion and is not counted as another implementation outcome
- The remaining 443 open/in-progress issues stay outside this train unless separately approved

Forty-seven implementation/migration candidates plus the stable-release tracking root currently lack explicit Kernel acceptance criteria. They remain unadmitted until the contracts in [acceptance-contracts.md](./acceptance-contracts.md) are approved, revision-checked, written to Kernel authority, and read back before code begins.

Actions are conservative. `verify-close` and `supersede` require evidence before any Kernel mutation. `defer` means outside `0.1.0`, not cancelled.

The original snapshot hash remains immutable. The user-approved post-snapshot addition `e8e72233-c31f-4a59-a4e4-deca433d00f8` was created with acceptance criteria and verified at revision 0; final release convergence must regenerate the full snapshot and admission ledger rather than rewrite historical evidence.

| ID | Title | Status | AC | Bucket | Primary owner | Delivery | Validation owner | Action |
|---|---|---|---|---|---|---|---|---|
|16b75ba8-7c70-4749-a4f6-fe1d42c82837|Publish Forge v0.1.0-beta.5|open|yes|close/supersede-audit|Release|separate|Release tag/npm artifact audit|verify-close|
|183dc7ca-f631-4e00-8867-9e0b793e3ce8|[epic] Skills as a first-class system — reasoning-driven auto-trigger, sub-skill composition, progressive adoption, and skill eval/scoring|open|no|architecture/flow|Flow|PR4A|Flow runtime/skill-eval suite|migrate|
|2c4dff71-4cb0-4530-be49-ebb2cb281039|Add Shepherd shadow replay and non-circular control-plane break-fix lane|open|yes|architecture/flow|Flow (Memory authority dependency PR1)|PR4B|Flow replay + Kernel authority integration|implement|
|4265026c-3764-4ff2-a150-7aba74996aa5|Resolve resurfaced js-yaml and qs audit advisories|open|yes|release/root|Release|PR7|Security audit + dependency suite|implement|
|4a32d61b-8e86-481b-b8c1-f77d464e445e|Cross-harness Shepherd auto-wake adapters and capability truth|open|yes|architecture/flow|Facade (Flow dependency PR4)|PR5|Facade harness/capability integration suite|implement|
|4ee7f9a9-4fa0-42c1-bd96-96638cc9feff|Require executable issue contracts before ready|open|yes|control-plane/debt|Memory|PR1|Memory Kernel contract/authority tests|implement|
|4f436ee2-d51f-456e-ada2-eab6220383b1|Collapse release critical path with adversarial worker swarms and durable transition control|in_progress|yes|architecture/flow|Flow (Release dependency PR7)|PR7|Flow transition + release convergence suite|implement|
|5037a7da-d49b-4015-a3fa-aac34425078e|[memory] Formalize the MemoryBackend adapter interface (pluggable memory layer; local floor + opt-in enrichers)|open|no|architecture/memory|Memory|PR2|Memory contract compatibility suite|implement|
|57fb8889-e234-4115-a9e1-6235f1dd7360|[epic] Autonomous shepherd — PR-owned, session-independent monitoring via a reconcile loop (never invoked, self-healing, agnostic)|open|no|architecture/flow|Flow|PR4B|Flow Shepherd replay suite|migrate|
|6b56673a-ff47-4532-8a51-c4a73011a12c|[memory] Supersession + staleness/dedup hygiene (fixes the 296-issue auto-file flood)|open|no|architecture/memory|Memory|PR3|Memory retention/recall suite|implement|
|8a3ee1f0-2669-4878-9565-c1c50791b302|Implement durable release transition controller and critical-path telemetry|open|yes|architecture/flow|Flow (Release dependency PR7)|PR7|Flow release telemetry + exact-SHA suite|implement|
|8e634347-4562-4570-bc81-c22b210507d9|Cut 0.1.0 release (version bump + CHANGELOG + ~7-doc version sweep + tag/publish)|open|no|release/root|Release|PR7|Release exact-SHA/full-suite evidence|implement|
|9af1ee0a-a090-48ca-9d89-5c06a0a67fc9|[shepherd] Comprehensive defect audit (Fable) -- gaps beyond PR #366|open|no|architecture/flow|Flow|PR4B|Flow Shepherd replay suite|implement|
|9b69a551-f5a0-4057-9d9f-96fb0d744fd3|Safely reconcile claims left by dead Forge-owned runs|open|no|control-plane/debt|Memory|PR1|Memory claim-reaping/authority suite|implement|
|af79e102-a8d7-4271-b7d5-62318eb984c5|npm release workflow can publish without full repository test coverage|in_progress|yes|release/root|Release|PR7|Release exact-SHA gate|implement|
|c2d398e5-26cf-4963-b47a-70b4102636bb|[epic] Constant agent-agnostic PR monitor -- forge shepherd watch/events (pushes events every ~60s)|open|no|architecture/flow|Flow|PR4B|Flow Shepherd event/replay suite|migrate|
|d362bd71-cd0c-4178-a11e-0069382ae949|Behavioral eval tier + holdout improvement loop|open|yes|release/root|Release|PR7|Release evaluation/holdout suite|implement|
|eed58484-42a7-4081-842a-60e635c3482c|Version provider lifecycle envelopes and fail closed on format drift|open|yes|architecture/contracts|Memory|PR2|Memory protocol compatibility suite|implement|
|f1af41ef-7fcb-4a55-8c24-4ff7a41f1239|[epic] Shepherd merge-safety redesign — one trustworthy agent-agnostic verdict|open|no|architecture/flow|Flow (Memory authority dependency PR1)|PR4B|Flow verdict replay + Kernel gate suite|migrate|
|00eef22d-0556-443d-9fa7-154bf51637d4|Fix Shepherd BLOCKED-THREADS verdict when zero threads remain|open|no|architecture/flow|Flow|PR4B|Flow Shepherd verdict suite|implement|
|0f6ce951-2493-4c08-ac61-2a158b363a79|Pin Forge feedback intake and idempotent receipt contract|open|yes|architecture/contracts|Memory|PR2|Memory receipt/idempotency compatibility suite|implement|
|1390e1d1-9b49-43e3-b6f8-2dbf3473a8f2|EPIC: Forge lifecycle self-enforcement — kernel-authoritative hygiene|open|no|control-plane/debt|Memory|PR1|Memory Kernel hygiene/authority suite|migrate|
|18bee669-dd71-46c8-ac24-b36cf1a613b2|Phase B: forge context verb -> retire the 28 beads-context.sh shell-outs + delete fallback forks (single highest-leverage item)|open|no|control-plane/debt|Memory|PR6|Memory Beads migration/parity suite|migrate|
|2286ede8-f60f-4f33-9229-8d8de64e8a68|Fix Shepherd bot-comment blocker projection|open|yes|architecture/flow|Flow|PR4B|Flow Shepherd verdict suite|implement|
|265774da-f615-4d66-999d-564b8e4a11ce|Fix Shepherd false behind-base blocker|open|no|architecture/flow|Flow|PR4B|Flow ancestry/verdict suite|implement|
|2b71e189-43b1-4e17-89ba-fabd9175c829|[activation] Self-initiating, adaptive Forge skill flow modeled on the superpowers brainstorming->plan->execute chain|open|no|architecture/flow|Flow|PR4A|Flow skill-chain evaluation suite|migrate|
|2d51a6de-848e-41f0-9fdb-61e5641099c8|[shepherd] Reap duplicate watcher registrations across reconcile ticks|open|yes|architecture/flow|Flow|PR4B|Flow Shepherd reconcile replay suite|implement|
|33d6dce9-7295-4657-9034-46fab19af669|[memory] Attention-following injection -- PreToolUse:Read hook injects notes about the file being read|open|no|architecture/memory|Memory|PR3|Memory injection/recall suite|implement|
|3b863d8b-1e42-4f75-bb45-6a5a8da0de6b|Smith: harness execution capability adapter for spawn, message, interrupt, resume, and isolation|open|yes|architecture/flow|Flow|PR4A|Flow harness adapter suite|implement|
|52ebe3fd-a717-4466-add5-3874311386e2|[shepherd] De-CodeRabbit-center the docs/skill/examples — present shepherd as ANY-review-bot (fix the dependency PERCEPTION)|open|no|architecture/flow|Flow|PR4B|Flow review-adapter evaluation suite|implement|
|5ded6d2a-6e6c-41b3-aa73-251cf9bd6987|[BETA] Implement forge design CLI (check/sync/list)|open|no|close/supersede-audit|Facade|separate|Facade source/PR completion audit|verify-close|
|7268bc9b-4a64-4ff5-bd83-4ec92481211c|[control-plane] Hook adapter consults controls (warn/deny/deny-unless-approved) + honest per-harness downgrade|open|no|control-plane/debt|Facade|PR5|Facade harness-control integration suite|implement|
|765a4cd8-65c1-4edc-87e0-42d607a046fb|Merge authority must ignore successful skipped and neutral optional checks|open|no|control-plane/debt|Memory|PR1|Memory merge-authority/Kernel gate suite|implement|
|7da81cbd-f890-49dc-b237-9ce4729ed6be|smith orchestrator v1 — thin super-skill composing stage sub-skills with gate events + planning-phase autonomy calibration (size x importance x complexity)|open|no|architecture/flow|Flow|PR4A|Flow orchestrator/skill evaluation suite|migrate|
|7f8c8471-9933-458f-af43-66bd753dc847|Smith and claim-safety skills require missing CLI adapters and Smith reference asset|open|no|control-plane/debt|Memory (Flow dependency PR4)|PR1|Memory claim authority + Flow adapter suite|implement|
|894f0b0d-032f-4053-a7fa-1b036d64c829|Shepherd: bounded complete review-thread handoff without GitHub refetch|open|yes|architecture/flow|Flow|PR4B|Flow review-thread replay suite|implement|
|931d73f5-d966-420d-899e-dcf64302b23b|[shepherd] Mechanism-first review-bot classification — retire REVIEW_BOT_LOGINS name-list for authorTypename/[bot] detection|open|no|architecture/flow|Flow|PR4B|Flow review-bot classification suite|implement|
|94f782e0-0d5e-476c-a93f-cb8624d21f1f|Stabilize reconcile-executor foreign-lease child exit on Windows|open|no|control-plane/debt|Memory (Flow dependency PR4)|PR1|Memory lease authority + Flow Windows suite|implement|
|9658c21a-f31e-4a5d-b9de-157065013473|[control-plane] MCP registry section + render/drift/consent wiring (render-time locus, honest SEAM)|open|no|control-plane/debt|Facade|PR5|Facade capability/consent integration suite|implement|
|9a3dc574-d96c-4f15-b85f-baf0dca4c129|Decision: PostgreSQL or libSQL for Forge team authority after representative load proof|open|yes|control-plane/debt|Memory|defer|Memory authority load evidence|defer|
|9df80006-adea-4e9c-9204-0316d32ccb50|Shepherd emits BLOCKED-THREADS with empty blocker evidence|open|no|architecture/flow|Flow|PR4B|Flow Shepherd verdict replay suite|implement|
|9f6ffb42-6ee0-4a9c-a2ac-ca428866f6e9|P0 kernel linkage: issue->worktree->work-folder->files provenance (kernel_worktrees writes)|open|no|control-plane/debt|Memory|PR1|Memory Kernel provenance/authority suite|implement|
|a696e954-af9f-4dc0-b659-23804b7eeb55|forge shepherd events --all — cross-PR digest for out-of-repo orchestrator sessions (make the LOCAL tier the primary surface)|open|no|architecture/flow|Flow|PR4B|Flow Shepherd events suite|implement|
|addf5297-ef13-4209-afa4-02d46d44a3fa|[shepherd] Auto-trigger Tier-2 -- verdict_clean merge rule + gate toggle + forge ship nudge|open|no|architecture/flow|Flow|PR4B|Flow auto-trigger/gate suite|implement|
|b4a63278-8f95-4c98-9b79-9b31526ff805|Smith: bounded worker contracts, lifecycle events, and scope-drift enforcement|open|yes|architecture/flow|Flow (Memory contract dependency PR2)|PR4A|Flow scope/lifecycle evaluation suite|implement|
|b6bdf122-9945-4fa3-a73f-38f9fa2eec6d|EPIC: Knowledge architecture / OKF (info-arch 2026-07-04)|open|no|architecture/memory|Memory|PR3|Memory knowledge/recall suite|migrate|
|b811a974-a866-47e0-8f83-3f5d2423aded|Eliminate Kernel-to-plan artifact split-brain across projects|open|yes|control-plane/debt|Memory|PR1|Memory Kernel plan-authority suite|implement|
|b977b0a2-11f6-40d7-a230-8e2ff5f79115|Keep permission approvals issue-bound on forge gate events|open|yes|control-plane/debt|Memory|PR1|Memory approval-authority suite|implement|
|bec40cf9-05ed-47df-93af-9eb10969ef12|Phase B: forge recall -- cross-platform kernel-native history/memory recall (ctx-inspired; optional ctx adapter; NOT a ctx dependency; kernel corpus)|open|no|architecture/memory|Memory|PR3|Memory recall compatibility suite|migrate|
|c29f3952-1229-4f13-afd7-416a426c916a|[online] Presence/lease surfacing -- agent live / holds lease on N / last-seen|open|no|control-plane/debt|Memory|PR1|Memory lease/presence suite|implement|
|c66f076e-70a8-4f94-80e6-e98536ea1c9b|[shepherd] Retire .claude/scripts/review-resolve.sh into agent-agnostic forge verbs|open|no|architecture/flow|Flow|PR4B|Flow review-verb compatibility suite|implement|
|d2c3cce3-7cfb-45bf-b946-7cf9a61df513|Shepherd: expose daemon lifecycle status through an existing bounded read surface|open|yes|architecture/flow|Flow|PR4B|Flow Shepherd lifecycle suite|implement|
|d4a60823-e08e-4ed3-b069-96d053cb11ec|Fix Shepherd false behind count on current PR branches|open|yes|architecture/flow|Flow|PR4B|Flow ancestry/divergence suite|implement|
|da14d0fd-2ea3-4d47-8299-f6ff76a7f269|Stabilize SQLite FTS5 recall filtering on Windows|open|yes|architecture/memory|Memory|PR3|Memory FTS5 recall suite|implement|
|dd77fcbb-e6bd-45de-8fff-d1002f0c6d13|Add zero-token post-merge backlog triage and next-work handoff|open|yes|control-plane/debt|Flow (Memory record dependency PR1)|PR4B|Flow post-merge handoff + Kernel evidence suite|implement|
|ea6c7b14-9a46-45ef-a940-653b56f64ea4|[epic] Beads full retirement — runtime-free, keep only an opt-in migrator (D44 endgame)|open|no|control-plane/debt|Memory|PR6|Memory Beads retirement migration suite|migrate|
|eea2f9ce-065f-49e8-9e65-4bfbb6092428|claim-safety skill — verify lease ownership (show --json.claimed_by == own actor & not expired) before working; refuse foreign duplicate-collapsed claim|open|no|control-plane/debt|Memory|PR1|Memory claim-safety/lease suite|implement|
|f8712b8e-4d85-401b-8bb4-dad884e6ef68|Shepherd: acquire external or fork PR head before divergence checks|open|yes|architecture/flow|Flow|PR4B|Flow external-head/ancestry suite|implement|
|forge-titl|Forge v2 Master Tracking: 13-15w with 2 engineers OR 22-26w solo OR 3 sequenced releases|open|no|close/supersede-audit|Facade|separate|Facade N1/v2 issue-graph audit|supersede|
|028a149e-29c3-4892-8867-c277855c7299|Skill invocation convention: standardize Skill("name") handoffs|open|no|architecture/flow|Flow|PR4A|Flow skill invocation suite|implement|
|205a8106-bf54-44b7-9129-6f3f111b9103|Workflow: generate all projections from one canonical runtime contract|open|yes|architecture/contracts|Memory|PR2|Memory protocol compatibility suite|implement|
|4a65c50f-c10c-480b-9956-b52cc66c10e0|[shepherd] Auto-trigger Tier-3 -- fork-PR maintainer path + verdict history + pr.verdict_changed event|open|no|architecture/flow|Flow|PR4B|Flow maintainer/verdict replay suite|implement|
|50929aee-b925-41f0-a951-aa2ab8d40042|Conditional auto-merge RULES ENGINE (opt-in onPass/shepherd Tier-B) — composable built-in conditions (settle_min/idle_min/checks_green/threads_resolved/actor-scoped) + custom-predicate seam|open|no|architecture/flow|Flow (Memory authority dependency PR1)|defer|Flow policy simulation + Memory gate evidence|defer|
|67ecc083-91e9-47b0-b1b1-833d93fa510d|Strengthen ship<->shepherd<->review relationship (PR lifecycle handoffs)|open|no|architecture/flow|Flow|PR4B|Flow ship/review lifecycle suite|migrate|
|6c7ee76a-7199-4811-8040-eedf6d4733af|[control-plane] Per-rule control -> alwaysApply rendering + rail-backed delegation|open|no|control-plane/debt|Facade|defer|Facade routing/control rendering suite|defer|
|6d5ed439-c7a1-416e-8d4a-afb3f61f71b0|[memory] Prompt agent to write session LEARNINGS at exit (nudge tier)|open|no|architecture/memory|Memory|PR3|Memory session-capture suite|implement|
|920a086a-99ca-425f-a666-890447711c6e|[beads-retire] Docs + D44 ledger update: record full-retirement (2026-07-15) + scrub Beads from AGENTS.md/skills/reference (except the migrator)|open|no|control-plane/debt|Memory|PR6|Memory Beads docs/parity suite|migrate|
|9aac4554-3eb0-4244-8217-5e1e36720119|forge loop: agent-agnostic tick driver for bounded-pass tasks (shepherd first consumer)|open|no|architecture/flow|Flow|PR4A|Flow bounded-tick/Shepherd suite|implement|
|9c343cdb-0a41-4933-8296-d29a0f4174c4|[memory] Rerank over FTS5 BM25 (+ optional local embeddings, opt-in vector-light)|open|no|architecture/memory|Memory|defer|Memory ranking benchmark|defer|
|b03ddbf2-1f9f-4713-8538-bb3b2844d4a0|Shepherd --pull: surface actionable direct PR comments + review-level summaries (item 6)|open|no|architecture/flow|Flow|PR4B|Flow Shepherd read/review suite|implement|
|b34dfc57-3768-43c2-92d0-5f979c889b58|[shepherd] Daemon restart must adopt the reclaimed lease's watcher set|open|no|architecture/flow|Flow (Memory lease dependency PR1)|PR4B|Flow restart replay + Memory lease evidence|implement|
|c3952ba5-10ae-42ca-9626-413fd21a33fa|Close the kernel graph: auto-register PRs, instantiate sessions, persist shepherd verdicts|open|no|architecture/flow|Memory (Flow dependency PR4)|PR1|Memory Kernel graph + Flow Shepherd integration suite|implement|
|d9cb9823-d002-4657-8d0e-194875f85f63|Beads-removal: add slice exit-criteria DoD appendix to the plan|open|no|control-plane/debt|Memory|PR6|Memory Beads migration exit-criteria suite|migrate|
|dae18794-662c-4bb2-a94c-d0897739723d|[memory] Progressive disclosure + scoped recall (ranked index first; scope by worktree/issue)|open|no|architecture/memory|Memory|defer|Memory scoped-recall benchmark|defer|
|e2420489-b4cb-487a-918b-a5de0938c9e4|[shepherd] Compact verdict read-interface: forge shepherd <pr> --verdict --json|open|no|architecture/flow|Flow|PR4B|Flow verdict read-interface suite|implement|
|ffbdb6b7-570c-4c30-b984-b6f4df6c3ab7|[shepherd][test-quality] Seam-helper discipline for reconcile-executor tests (fafCtx/daemonOpts)|open|no|architecture/flow|Flow|PR4B|Flow Shepherd test suite|implement|
|28d67d69-c175-4542-bc29-f6091a784330|[memory] Add an end-to-end node bin/forge.js memory smoke test (the --type-vs-real-CLI class)|open|no|architecture/memory|Memory|PR7|Memory CLI hardening/smoke suite|implement|
|bb5b054c-c8e1-45aa-a42d-3e57140c5dd9|[memory] recall --kind scans only the newest 1000-note window then filters — misses older typed notes while claiming capped:false|open|no|architecture/memory|Memory|PR3|Memory recall cap regression suite|implement|
|f21279f4-473a-4d20-95d4-533ddbb1d102|Add an event-driven efficiency supervisor for Flow runs|open|yes|architecture/flow|Flow (Memory evidence dependency PR1)|PR4A|Flow efficiency thresholds/recommendation + Kernel evidence suite|implement|
|e8e72233-c31f-4a59-a4e4-deca433d00f8|Expand forge doctor into manifest-driven health coverage|open|yes|architecture/facade|Facade|PR5|Facade doctor schema/coverage/portability suite|implement|
