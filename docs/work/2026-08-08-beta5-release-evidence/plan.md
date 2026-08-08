# Beta.5 release evidence convergence

## Outcome

One reviewable PR prepares the beta.5 release candidate without publishing a release. It adds a Forge-audited path for protected workflow generation, makes npm publication consume exact-SHA full-suite evidence, and completes the executable behavioral-evaluation control plane needed to run the frozen 30/100/300 protocol. After merge, the release tag and GitHub release are created from the exact merged SHA and trigger the trusted npm publication workflow.

## Boundaries

- Keep the package version, changelog, and release docs aligned for beta.5, but do not create a tag or GitHub release or publish to npm from the PR.
- Do not claim a model winner or let evaluation code authorize merge.
- Do not store raw prompts, transcripts, tool payloads, secrets, or personal data.
- Reuse the behavior of local commit `5fbb3521`, but do not cherry-pick its unsanctioned protected-workflow edit.
- Keep unrelated failures and improvements in separate Forge issues and PRs.

## Design

### Protected release workflow

A narrow Forge release command owns deterministic generation of the npm publish workflow. Its protected-state authorization is bound to actor, workflow surface, path, and generated-content hash so a stale record cannot permit a later raw edit. The generated workflow resolves the release tag once, verifies and publishes the same immutable SHA, consumes a successful complete-suite receipt, and fails closed on absent or mismatched evidence.

### Behavioral evaluation

A controlled orchestrator joins the already-merged immutable corpus and privacy-safe evidence primitives. It executes matched opaque arms, records only allow-listed attributable evidence, and returns PASS, FAIL, or INCOMPLETE. A pure scorer implements the preregistered Wilson, risk-stratified paired-bootstrap, safety-veto, latency, and token rules. The CLI exposes the frozen 30/100/300 tiers; execution produces evidence but never selects a merge outcome.

## Ambiguity policy

Choose the smallest reversible option that preserves fail-closed behavior and current public APIs. Any change to security authority, persistent schema, public command semantics beyond the specified flags, or release publication behavior outside exact-SHA gating is blocked for explicit review. Actual model adapters and 100/300 promotion runs remain post-merge operations, not PR acceptance.

## Validation

- TDD RED/GREEN evidence for every production change.
- Focused command, protected-state, workflow, corpus/evidence, behavioral-runner, and scorecard tests.
- Deterministic workflow generation and YAML parsing.
- Current-base rebase, lint/type/security checks, and the supported full repository suite on the final SHA.
- PR checks, review threads, and quiet feedback window before merge consideration.
