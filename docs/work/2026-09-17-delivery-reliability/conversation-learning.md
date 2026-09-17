# Conversation evidence, failure detection and model evaluation

Prepared 2026-09-17 for planning issue `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`. Proposal only; no detector, model experiment or product implementation was run. This extends [plan.md](plan.md), not a competing architecture or tracker.

## Purpose and selection

Make the delivery wave prevent recurring mistakes and produce evidence for choosing future models and workflows. A stronger model may improve judgment; authorization, valid evidence and honest completion must not depend on that improvement.

The sample is deliberately selected from three known Forge delivery/planning threads, not a random sample of all conversations. It can identify reproducible incidents, not estimate their prevalence or rank models. Source anchors below refer to local append-only Codex records, identified by session and event line/time; no transcript is copied into the repository. Only user messages, assistant public output, tool actions/results and runtime attribution are eligible. Private model reasoning and unrelated project content are excluded.

| Sample | Selection reason | Inspection boundary |
|---|---|---|
| `01a09468-1746-75d3-b589-c126ec52c20a`, September 12-17 | Current architecture/delivery discussion, corrections and planning publication | Streamed 12,357 records at the initial snapshot; selected correction/action neighborhoods, not every event semantically reviewed |
| `01a0805f-52a7-7d71-a36f-8e8149525806`, September 8-15 | Account-routing delivery and post-merge Windows failure | 63,371 records structurally scanned; user corrections enumerated; selected Forge-delivery neighborhoods reviewed |
| `01a02fb4-84fb-7302-8389-fc81a880946f`, August 23-September 5 | Historical push repair and validation handoff | 15,291 records structurally scanned; selected Forge coordination neighborhoods reviewed; unrelated product implementation excluded |

The older August 5 model-evaluation design (`019fd119-7ebd-7322-a37e-41449499b22e`) was used through its saved research summary as orientation. Its historical counts are not reasserted as current measurements. The initial current-thread scan found 46 turn-context records with two model identifiers; that is not a complete model-to-action/PR join and does not identify the cause of any incident.

Success controls are required alongside failure cases: an explicitly authorized PR, valid unchanged receipt reuse, legitimate waiting, successful cleanup, and post-merge detection that correctly leaves work open. This retrospective is an incident case study, not a representative reliability benchmark. A future throughput sample must use a declared consecutive or stratified sampling rule and retain successes, failures and interrupted work.

## Verified current-thread incidents and interpretations

| Observed event | Evidence and limit | Smallest useful response |
|---|---|---|
| Saving a planning checkpoint became publication before agreement | Current thread line 7277, September 14 16:23:23 UTC: user objects to PR creation; line 7281: assistant acknowledges interpreting save as permission to finalize and publish. This proves a scope mistake, not which model caused it. | Carry the agreed task scope/action permissions into the existing mediated write check. Saving a document must not implicitly grant PR creation or turn recommendations into decisions. Test the legitimate explicitly requested PR counterpart. |
| Prior requirements were lost or interpreted inconsistently during plan revision | Public assistant output at lines 7052 and 7155 records missing release-proof and independence requirements; lines 7214/7287 give inconsistent importer interpretations. These are historical corrections, not a new decision about today's Beads policy. | Bind work to the current approved scope revision and retain supersession links. Exact acceptance changes get a visible diff; semantic disagreement remains a review signal. Do not use old memory or a keyword to settle ambiguous intent. |
| Repeated complaints about delay and missing discussion | User signals at lines 3945, 4599, 5916, 8235 and 8426. Complaints establish dissatisfaction; they do not measure active reasoning time or prove infrastructure/model causation. | Bound delegated tasks, report substantive progress and next evidence, and record elapsed categories. A supported heartbeat gap or repeated identical failing attempt warns the coordinator; legitimate approved waiting must remain valid. |
| Independent review consumed a long interval and ended with conflicting transport/result evidence | Saved [review.md](review.md): Fable result reports 916,304 ms and completed critique, while its stopped wrapper exits 1. | Preserve separate task-result and transport states. Inspect the actual artifact/receipt before classifying completion. Reuse existing timeout/cancellation mechanisms; don't restart a useful completed review just because transport failed. |
| Review found a workflow change had no legitimate writer | Fable finding, independently source-confirmed by Sol in review.md. The current pin writer cannot authorize the proposed general CI edit. | Preflight writer/capability availability before assigning mutation work. Keep the legitimate writer issue separate; no human exemption, blanket grant or hook bypass. |

No detector can guarantee correct interpretation of all dictated intent. Structured authorization makes an already agreed boundary enforceable; it does not turn uncertain language interpretation into fact. Previously granted authorization persists within its scope until changed or revoked; no mechanical permission prompts are added for every action.

## Additional delivery incidents and successful controls

Sol structurally scanned 78,662 records in the two assigned historical sessions and inspected selected public-message/tool neighborhoods. These five incidents have direct event anchors, but historical execution was not rerun. Counts of selected incidents are not failure rates.

| Observed event | Local evidence anchor | Prevention or detection |
|---|---|---|
| A requested combined change became two PRs | `01a0805f...5806`, lines 18446-18459, September 10 12:03 UTC: user corrects PR topology and assistant admits misreading it after the first PR merged | Include intended target PR/topology in the existing scoped action packet; another PR requires authority consistent with that scope. Do not assume decomposition authorizes extra publication. |
| A running monitor did not deliver failures to the active session | Same session, lines 9220/9316 and 20521-20550, September 9-10: fresh pulls expose failed checks; assistant acknowledges the journal updated without active-session notification | Readiness reports bind to current head/check snapshot and observation time. A watcher being alive does not prove delivered notification. Describe actual coverage; pull when delivery is unsupported. |
| Expensive validation preceded cheap import checks, with misleading aggregate interpretation | Same session, lines 23044-23049, September 10 17:58 UTC: assistant records two approximately nine-minute runs, missing dependency/import errors and a misleading zero/zero summary | Verify setup and a bounded import smoke before broad execution; terminal aggregate must preserve child failures and missing results. The time/cause account is a preserved diagnosis, not independently reproduced in this audit. |
| Four review findings expanded into speculative modules and flags, then were successfully narrowed | Same session, lines 47951-47963, September 14 18:40 UTC: assistant acknowledges expansion; lines 48029/48073 record reduction to implicated files, 170 focused passes and one commit/push | Require changed files to map to acceptance/review findings. Unmapped changes prompt scope review, not a blanket prohibition on legitimate new helpers. Preserve this recovery as a success control. |
| Coordination repository and target repository were confused in status reporting | `01a02fb4...946f`, lines 2124-2147, August 23 21:23 UTC: Forge operated as another repository's merge authority; user questioned scope and the assistant clarified it | Distinguish target repository, coordinator and artifact in existing event metadata and progress. This is observed communication ambiguity, not proof of an unauthorized repository mutation. |

Root turn metadata in these episodes identifies Sol with high or medium effort; it does not reliably attribute child suggestions or individual edits, and no matched alternative-model trial exists. These incidents therefore cannot support a Sol/Luna/Astra ranking. The prior review-batch recovery and correct detection of failed post-merge checks are useful positive controls; final readiness still requires live verification.

This audit also exposed an avoidable coordinator cost: an unprojected tracker listing produced oversized output before switching to structured filtering. Use field projection, bounded summaries and reusable source references for exploration; mark truncated evidence incomplete for claims needing omitted records. This is a local tool-use correction, not justification for another indexing service.

The save check supplied a live false-block example: the retired-command documentation guard treated a slash-separated planning-and-research phrase as a command. The initial push had 351 passes and one failure; a focused run reproduced the exact match, and clearer prose passed all six delivery-document cases. No guard was bypassed or changed. Separate bug `e00dc2ef-1b3c-4343-afef-521942959f1a` records the detector fix and requires both legitimate-prose and real-command fixtures. This is runtime evidence of a specific false positive, not an estimate of the guard's overall accuracy.

## Detection policy: enforce facts, evaluate judgment

| Signal | Treatment | Required counterexample |
|---|---|---|
| Missing/revoked action authority, wrong issue/worktree/head, unsupported required execution capability | Existing deterministic authority checks at mediated action boundaries; add missing cases where justified | Correct authority and supported capability allow the intended action |
| Child failure, missing terminal result, targeted/zero-test output offered as full proof | Fail or return INCOMPLETE through the existing validator/receipt path | Complete successful required coverage produces valid proof |
| A new accepted scope revision conflicts with the packet's revision | Reject stale mutation authority; refresh only the affected authorization | Unchanged scope permits already authorized work without a new interview |
| Same expensive command/input fingerprint repeated without new evidence, heartbeat gap, unexplained scope expansion | Initially shadow/advisory; include reason, evidence and suggested next discriminating action | Authorized repetition, fresh inputs, diagnostics and approved waiting are not blocked |
| Plan quality, excessive reasoning, user frustration, questionable architectural abstraction | Human-calibrated review/evaluation; never a keyword-triggered hard gate | A justified long investigation or valid alternative implementation remains acceptable |

Fingerprint observations using normalized safe command identity and input revisions, not raw commands or environment values. Repetition alone is not failure: distinguish observation/polling from execution and intentional reliability trials from accidental reruns. No automatic cancellation or model rerouting solely from a heuristic score.

Coverage must name the enforced route. A Forge API check cannot stop arbitrary shell commands or unmediated harness tools. If a host cannot intercept writes, enforce cancellation or confirm delivery, report that capability as unavailable/unknown. Do not call a prompt instruction a sandbox. New transcript-derived detectors start in shadow mode; existing authorization/security requirements remain enforced.

Monitoring delivery maps to existing open issue `4439b12e-36d6-4e76-8b5a-a4c409c6c17e`, which asks for observable activation and truthful startup claims. Prior one-pass monitoring work is already marked done under a different issue; do not confuse process activation with delivery to a particular session. Status freshness needs a current head/check identity and fetch result, not only a timestamp from a worker clock.

## Reuse and minimal evidence contract

Extend the existing immutable corpus/oracle, model-neutral eval evidence, receipts and worker lifecycle work. Do not create a new transcript store, scheduler, general event bus or model-scoring service.

Luna inspected tracked `origin/master` (`bd1abbd8...`) and identified these existing seams. These are source-level findings, not fresh runtime certification:

| Existing surface | Source anchor | Reuse and verified limit |
|---|---|---|
| Event identity, dedupe and stale-revision quarantine | `lib/kernel/evaluators.js:120` | Reuse deterministic outputs; they do not by themselves join an incident to an attempted control-plane action |
| Immutable corpus and oracle | `scripts/lib/immutable-eval-corpus.js:14`, `:121`, `:220` | Already 300 pinned packets, 14 classes, 180 DEV/120 TEST and 30/100/300 tiers; retain hashes, safety checks and existing results |
| Model-neutral evidence/exact replay | `scripts/lib/eval-evidence.js:15`, `:65`, `:228`, `:252` | Allow-listed, hash-bound, Kernel-backed/idempotent; missing stable action/outcome-to-receipt linkage is the concrete extension candidate |
| Behavioral runtime/runner | `scripts/lib/behavioral-eval-runtime.js:40`, `:191`, `:335`; `behavioral-eval-runner.js:195` | Existing model-by-current/bounded arms and three trials; safe execution has zero tools and no persistence, so it tests decisions, not live tool effects |
| Promotion scorecard | `scripts/lib/promotion-scorecard.js:38`, `:227` | Existing complete-pair/split/safety requirements; `mergeAuthorized` remains false. A score is never write authority |
| Capability observations | `lib/capabilities/probes.js:195`, `:245`; `lib/capabilities/model.js:88` | Preserve UNAVAILABLE versus INCOMPLETE; successful help probing is not behavioral proof of cancellation or cloud execution |
| Work packet and terminal receipt | `lib/commands/merge.js:484`, `:522`, `:769` | Existing scope/lease/action/evidence/receipt references can be joined; evaluator output remains separate from authority |
| Generic audit | `lib/audit-evidence.js:103`, `:203` | Use only safe provenance pointers; don't copy prompt/response material into the stricter evaluation envelope |

The existing behavioral-eval issue (`d362bd71...`) is open; model-neutral evidence (`02f5ea90...`) and immutable corpus (`762ae3b7...`) are marked done. Worker-contract work (`b4a63278...`) is open and blocked, so its proposed runtime extensions are not an immediately ready parallel implementation lane. Shepherd shadow replay (`2c4dff71...`) is already in progress. Reuse these owners and dependencies. The old self-improving-loop design file is not on the inspected remote baseline; its historical ideas are not evidence of shipped functionality.

An incident card needs: local source reference and capture cutoff; observed outcome; suspected causes separately; the discriminating experiment; a synthetic reproduction with initial state and expected result; detector/coverage boundary; valid counterpart; existing owner issue; and evidence status. Use existing corpus fields where possible. Add only fields an actual consumer needs.

The initial join extension carries identifiers and reference hashes only, using existing typed result fields. A terminal worker status is not a completion receipt. Keep decision scores, deterministic boundary-test results and actual tool-enabled outcomes as separate evidence categories. Where the full join depends on blocked worker-contract work, instrumentation may prepare but end-to-end verification remains pending. Development fixtures cannot be relabeled as held-out tests without a separately recorded evaluation-design change.

For an experimental action, retain the existing run/attempt join plus action ID and parent attempt, issue and scope/policy revisions, repository/head and worktree or remote executor identity, requested and observed provider/model revision, role, effective effort policy, harness/adapter/tool versions, capability snapshot, packet/prompt/skill/tool hashes, safe input identity, start/terminal states, authoritative evidence references, usage, retries, and result attribution. Missing observations remain unknown; model self-identification is not runtime proof. Hashes do not make sensitive data safe to publish.

Record model usage and orchestration configuration rather than inventing an intelligence score. The model, harness, prompts, tools, context, task difficulty and environment can all affect results. The user-facing claim should be about a measured route on a task family, with its uncertainty and limits.

## Bounded model-versus-workflow experiment

1. **Freeze cases and graders first.** Start with six failure families and one legitimate counterpart each: scope authorization, stale scope/head, false completion, duplicate execution, unavailable capability, and interrupted result/cleanup. These 12 development fixtures test instrumentation; they are not a replacement for the existing 300-case corpus or its required tiers/split. Reuse existing case classes where they fit. Any corpus extension gets a new version/manifest/hash with old evidence preserved, not an in-place rewrite of frozen packets. Reserve unseen variants outside candidate input/context as holdout. Add Windows-install and review-convergence cases as their fixes become reproducible. Include fresh and compacted-context variants as a separate condition.
2. **Freeze the intervention.** Define a baseline bundle and a treatment bundle by exact revisions. Proposed treatment is bounded packets, evidence-linked completion and advisory repetition/progress reporting. Keep mandatory authorization and security gates on in both arms; replay unsafe proposals only against synthetic, non-mutating boundaries. Do not add unrelated workflow improvements mid-trial.
3. **Run a same-harness 2x2.** Model route A/B crossed with baseline/treatment. Use the same task snapshots, tools, available context, effort policy, validation criteria, environment and declared budgets. Keep the existing three-trial policy; randomize arm order and reset state. First use the existing zero-tool behavioral runtime for decision cases and deterministic fixtures for authority boundaries. It cannot establish real tool-execution behavior. Later isolated tool-enabled trials require an explicit executor/capability contract and their own evidence; do not silently enable tools in the safe runner. Numeric effort labels across providers need not mean equal compute. Report effective settings; unsupported controls create a different stratum, not an equivalent arm.
4. **Measure outcomes, not confident prose.** Grade verified task outcome, unauthorized/stale actions, required-evidence completeness, regression/escape severity and false blocks first; then correction batches, repeat executions, user intervention, time and cost. Review model-assisted judgments against a human rubric; model votes cannot authorize a merge. Count legitimate solutions that take a different path.
5. **Retain every attempt.** Separate behavioral failure, infrastructure failure, timeout, interruption, missing attribution and unverifiable result. Report denominators and joins. Break elapsed time into coordinator/model-active estimate when observable, tool execution, queue, approved waiting and user interruption; unknown time stays unknown. Do not subtract slow failures to improve a score.
6. **Report matched effects.** Compare models under the same workflow, workflow within each model, and their interaction. Cluster uncertainty by case: repeated attempts are not independent new tasks. If the harness/tool environment changes, report an additional system comparison rather than attributing the effect to model intelligence.
7. **Promote conservatively.** Preserve the shipped 30/100/300 tiers, split, complete-pair and safety gates. Passing a tier is necessary under current policy, not automatically sufficient evidence for a new causal claim. Choose a material effect, risk strata, sample size and uncertainty method before a promotion decision; amend existing evaluation policy explicitly if a different design is justified. Any critical authority/security escape is a veto for that proposed route. Recheck the holdout, then use a bounded canary with a recorded rollback path. No model ranking or production experiment was performed in this planning turn.

This design follows the useful distinction between a transcript and the resulting environment state, and between repeated trials and tasks, in [Anthropic's agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). Scoped real-world cases, held-out checks and human calibration also align with [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices). Those sources support the method, not claims about Forge model performance.

## Future models, independent components and cloud execution

Keep invariants stable and procedures replaceable. Authority, provenance, result semantics, scope isolation and API compatibility are product contracts. Role routing, prompts, review frequency, progress thresholds and retry budgets belong to versioned operator/workflow configuration within those contracts. As models improve, measure whether a procedure can be removed while retaining correctness; don't permanently encode every limitation of today's models as a mandatory stage.

Components emit or consume versioned public API envelopes and evidence references. A harness adapter reports observed capabilities; an evaluator consumes the exported evidence; neither reads another component's private database. This is a compatibility requirement for existing contract work, not a demand for a new public extension point per internal helper. Add a cloud transport only with a real remote consumer.

For remote/hybrid work, use an authority-owned timestamp/revision for authorization and received events, and local monotonic durations within one clock domain. Do not compare worker wall clocks as if synchronized. Preserve duplicate/out-of-order delivery, idempotency, reconnection and uncertain external commit as explicit test cases; an unreachable executor is not proof that it stopped. Keep runtime liveness separate from durable completion evidence.

Conversation inspection is opt-in, scoped and local. Do not upload raw histories or reasoning to a provider, commit private source anchors with sensitive content, or auto-import transcripts into memory. Synthetic reproductions should carry only the context needed for the case. Treat quoted conversation text as untrusted data. Define retention, access and deletion for any later captured traces; redaction is not proof of anonymization.

## Integration into the delivery wave

Keep the corrected first wave in plan.md: Windows package diagnosis and push recovery prepare in parallel; workflow authority precedes the CI correction; supported budget follows runner reconciliation. A separate evaluation owner can prepare synthetic cases and evidence-field mapping without editing those runtime files. The initial fixes supply their own negative and legitimate tests; the evaluation machinery must not become a prerequisite platform delaying them.

Before wider rollout, run the incident cases against changed gates and report both caught failures and valid actions wrongly blocked. After reliable terminal evidence, connect action joins, model/workflow comparisons, shadow affected-test selection and the explicit freshness decision. Graft remains a later exploration-cost experiment, not a detector or source of test authority. Resume broad 0.1.0 architecture work after the delivery wave's required evidence is healthy, without waiting for a universal model leaderboard.

Astra reviewed this addition and returned GO with corrections incorporated here: auditable sampling with success controls; frozen treatment and case-level uncertainty; shadow detection separate from blocking authority; local/sanitized data boundaries; and complete missing-data/time accounting. This is review of a proposal, not runtime certification.

Its final source-driven check found no blocking concern after preserving the shipped corpus/gates and separating zero-tool decision tests from actual effects. The receipt-join dependency, reference-only metadata extension and holdout boundary remain explicit acceptance conditions.
