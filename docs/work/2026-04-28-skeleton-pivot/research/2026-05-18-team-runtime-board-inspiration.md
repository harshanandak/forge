# Team Runtime Board Inspiration Research

Date: 2026-05-18

## Local Anchor

Forge's board work is not just a kanban surface. The current release plan says `0.0.18` should consume issue adapters, run state, evidence, and review packets to ship a team runtime dashboard without a Forge-owned orchestration layer (`docs/work/2026-04-28-skeleton-pivot/release-plan.md:41`). The explicit `0.0.18` surface includes `forge board` / dashboard, `IssueAdapter` SPI, and external orchestrator compatibility (`docs/work/2026-04-28-skeleton-pivot/release-plan.md:230`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:234`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:235`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:248`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:249`).

Earlier releases already define the inputs the board should explain: graph primitives, evaluator regions, evidence, templates, install profiles, and insights proposals (`docs/work/2026-04-28-skeleton-pivot/release-plan.md:35`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:37`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:38`, `docs/work/2026-04-28-skeleton-pivot/release-plan.md:40`).

## Product Patterns Worth Borrowing

### 1. Saved Views Over One Board

GitHub Projects treats a project as table, board, and roadmap over issues and PRs, with custom fields, saved views, charts, templates, status updates, and automation. The important lesson is that the board is a view over linked work, not the source of truth.

Sources:
- https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects

Forge implication:
- `forge board` should expose saved named views over the same runtime state: `ready`, `blocked`, `review-risk`, `stale-evidence`, `adapter-errors`, `release-scope`, and `mine`.
- Every item should deep-link back to Beads/GitHub/adapter source records instead of becoming a second tracker.

### 2. Durable Filtered Views With Ownership

Linear's custom views are durable filters over issues/projects/initiatives. They can be shared, favorited, attached to teams/projects, subscribed to, and owned. Linear distinguishes curated initiatives from dynamic filtered views.

Sources:
- https://linear.app/docs/custom-views

Forge implication:
- Split "view definition" from "work membership":
  - Dynamic board views: query over runtime state.
  - Curated runtime packets: explicitly selected issues/runs/evidence for a release review.
- Add owner metadata to each board view so stale team dashboards have an accountable maintainer.

### 3. Audience-Specific Discovery Views

Jira Product Discovery has list, matrix, board, and timeline views for ideas, and emphasizes tailoring detail by audience. Matrix views are especially useful for comparing impact against effort.

Sources:
- https://www.atlassian.com/software/jira/product-discovery/guides/views/overview

Forge implication:
- Add a matrix view for workflow improvements and evaluator proposals:
  - X axis: implementation effort or blast radius.
  - Y axis: observed evidence frequency or risk reduction.
- Keep leadership/release views high-level while contributor/debug views show raw evidence, adapter metadata, and failed gates.

### 4. Execution Graph Plus Trace, Not Just Status

Dagger frames delivery workflows as programmable, local-first, repeatable, observable workflows. It emits OpenTelemetry spans and includes a live terminal UI, with traces exportable to OTel-compatible backends.

Sources:
- https://docs.dagger.io/

Forge implication:
- Board cards should carry an execution graph and trace summary:
  - What command/action ran.
  - Inputs and artifacts.
  - Evidence links.
  - Cache/re-run eligibility.
  - Current gate.
- A live TUI-compatible model matters as much as a web dashboard because Forge is CLI-first.

### 5. Evidence/Eval Surfaces From LLM Observability

Langfuse combines traces, sessions, timelines, user tracking, agent graphs, dashboards, prompt management, and evaluation. It explicitly positions tracing as a way to debug complex non-deterministic LLM systems.

Sources:
- https://langfuse.com/docs/

Forge implication:
- Treat every agent or stage attempt as an inspectable trace/session.
- Add an "evidence stack" panel per card: prompt/task, files touched, commands run, test output, reviewer notes, evaluator score, accepted/rejected proposal.
- Add agent graph view only where multiple agents/sub-skills actually participated.

### 6. Standardized Event Schema Before UI Polish

OpenTelemetry Semantic Conventions define common names and meanings for spans, metrics, logs, profiles, resources, and domains including CICD and generative AI.

Sources:
- https://opentelemetry.io/docs/specs/semconv/

Forge implication:
- Define Forge board events before building richer UI:
  - `forge.issue.claimed`
  - `forge.stage.started`
  - `forge.stage.completed`
  - `forge.evidence.captured`
  - `forge.evaluator.failed`
  - `forge.adapter.error`
  - `forge.proposal.accepted`
- Include schema version, source adapter, source id, actor, workspace, branch, issue id, artifact links, and correlation id.

### 7. Event-Triggered Automations With Missing-Event Detection

Prefect automations can trigger on state changes, absence of expected events, work pool status, work queue status, deployment status, metric thresholds, and custom events.

Sources:
- https://docs.prefect.io/v3/concepts/automations

Forge implication:
- Board usefulness jumps if it can surface missing events:
  - Claimed but no stage started.
  - Dev done but no validation evidence.
  - PR open but no review packet.
  - Adapter sync stale.
  - Run started but no completion event.
- Keep actions advisory first: notify, suggest, or create follow-up issue; do not silently mutate workflow state.

### 8. Durable Run History

Temporal's core pitch is durable execution that resumes after crashes or outages. Even if Forge does not own orchestration, the board should preserve runtime history strongly enough that external orchestrators can resume or explain state.

Sources:
- https://docs.temporal.io/

Forge implication:
- Board state should be reconstructable from append-only events plus adapter snapshots.
- Do not make the dashboard's local cache authoritative.
- Add "why is this here?" provenance for every card.

### 9. Team Health Scorecards

Compass and OpsLevel both point toward service/component scorecards, dependencies, activity feeds, and maturity/rubric views. OpsLevel also separates global rubrics from team-owned scorecards.

Sources:
- https://www.atlassian.com/software/compass/software-catalog
- https://docs.opslevel.com/docs/scorecards

Forge implication:
- Add configurable workflow scorecards rather than one global health score:
  - TDD evidence completeness.
  - Review closure hygiene.
  - Adapter freshness.
  - Documentation link coverage.
  - Validation pass rate.
  - Stale work age.
- Let teams define scorecards without changing L1 rails.

### 10. Parallel Agent Task Consoles

Codex cloud, Cursor background agents, Devin, and Factory all emphasize background or asynchronous coding work. Factory's Code Droid report is especially relevant because it describes task decomposition, environment grounding, multiple candidate trajectories, test validation, auditability, and logged explanations.

Sources:
- https://developers.openai.com/codex/cloud
- https://docs.cursor.com/en/background-agents
- https://docs.devin.ai/get-started/devin-intro
- https://factory.ai/news/code-droid-technical-report

Forge implication:
- `forge board` should have a "parallel runs" lane:
  - Task decomposition.
  - Agent/sub-skill owner.
  - Current phase.
  - Last evidence.
  - Validation result.
  - Handoff status.
- Do not hide candidate attempts. Show rejected/failed trajectories when they explain final decisions.

## Recommended Forge Board Split

Build the board as six targetable surfaces instead of one large dashboard.

### A. Work Intake Board

Purpose: answer "what should we do next?"

Data:
- Beads/GitHub issue adapter records.
- Dependency and priority metadata.
- Claimed owner.
- Stage readiness.

Views:
- Ready now.
- Blocked by dependency.
- Needs planning.
- Needs review.
- Needs verification.

First useful feature:
- `forge board --view ready --json`

### B. Runtime Run Board

Purpose: answer "what is running, stuck, or resumable?"

Data:
- Stage events.
- Command runs.
- workspace/branch.
- artifacts.
- correlation ids.

Views:
- Active runs.
- Stuck runs.
- Recent failures.
- Resumable sessions.

First useful feature:
- `forge board --view runs --since 24h --json`

### C. Evidence Board

Purpose: answer "what proof exists?"

Data:
- Test output references.
- Lint/type/security summaries.
- Review packets.
- evaluator reports.
- source artifact links.

Views:
- Missing evidence.
- Evidence stale.
- Evidence failed.
- Evidence accepted.

First useful feature:
- `forge board --view missing-evidence --json`

### D. Evaluator/Proposal Board

Purpose: answer "what should improve in the workflow?"

Data:
- `forge insights` proposals.
- accepted/rejected history.
- review failure clusters.
- evaluator regions.

Views:
- High-frequency failures.
- Low-effort/high-impact improvements.
- Accepted proposals pending implementation.
- Rejected proposals with rationale.

First useful feature:
- matrix export: `forge board --view proposals --format matrix-json`

### E. Adapter Health Board

Purpose: answer "which external systems are drifting?"

Data:
- Beads, GitHub, CI, review provider, local logs.
- sync timestamps.
- error normalization.
- divergence checks.

Views:
- stale adapters.
- sync errors.
- snapshot disagreement.
- upstream unavailable.

First useful feature:
- `forge board --view adapter-health --json`

### F. Team Standards Scorecard

Purpose: answer "are we following our standards without forcing one team's process onto all teams?"

Data:
- Configured checks.
- scorecard definitions.
- evidence metrics.
- issue/stage age.

Views:
- team scorecard.
- release scorecard.
- L1 rail compliance.
- team-owned optional checks.

First useful feature:
- `forge board --view scorecard --team <team> --json`

## Product Decisions To Avoid

- Do not make the board a second issue tracker. GitHub Projects and Linear work well because views sit on top of linked work.
- Do not start with a rich web UI before defining event schema and reconstructability.
- Do not collapse evidence, issue state, and run state into one status field.
- Do not over-index on kanban columns. Matrix, timeline, trace, scorecard, and adapter-health views are more important for Forge.
- Do not let AI proposals mutate workflow policy automatically. Start with proposal, evidence, accept/reject, and audit trail.

## Suggested Implementation Slices

1. Board event schema and JSON renderer.
   - Output: stable event vocabulary, `forge board --json`, provenance per item.
   - Inspired by: OpenTelemetry, GitHub Projects.

2. Saved views over adapter state.
   - Output: `ready`, `runs`, `missing-evidence`, `adapter-health` views.
   - Inspired by: Linear, GitHub Projects.

3. Evidence stack per item.
   - Output: card payload includes proof links and missing proof reasons.
   - Inspired by: Langfuse, Dagger.

4. Missing-event/stale-state detection.
   - Output: stuck and stale cards without owning orchestration.
   - Inspired by: Prefect, Temporal.

5. Proposal matrix.
   - Output: effort/risk-frequency matrix for evaluator and workflow proposals.
   - Inspired by: Jira Product Discovery, Factory.

6. Team scorecards.
   - Output: configurable health checks independent of global rails.
   - Inspired by: Compass, OpsLevel.

## Bottom Line

The most useful Forge board is a runtime evidence cockpit, not a prettier task board. The core should be a reconstructable event model with saved views. Once the event model is solid, the UI can expose several surfaces: intake, active runs, evidence, evaluator proposals, adapter health, and team scorecards.

