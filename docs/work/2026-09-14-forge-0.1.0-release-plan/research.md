# Research snapshot

**Captured:** 2026-09-14  
**Forge remote evidence:** `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`  
**Evidence level:** tracked-source and live Kernel inspection. Archived test evidence is identified separately and is not promoted to current release proof.

## Current product state

The approved restructure has already landed the package skeletons and most early integration work. The live epic is still `in_progress`, while its Memory, Flow, and PR4B parent lanes are marked done. The release is now blocked by usable public assemblies, a bounded facade/capability slice, migration and release convergence, and validation/release hygiene.

The root package is `forge-workflow@0.1.0-beta.7`. `@forge/contracts`, `@forge/memory`, and `@forge/flow` remain at `0.1.0-beta.6` with exact internal dependency pins. The source graph is directionally separated, but standalone usability is incomplete:

- Memory still needs caller-created broker/backend infrastructure.
- Flow still needs an injected run function and lacks a supported public runner assembly.
- Existing package smoke coverage installs the packages together and therefore does not prove independent use.
- The concrete SQLite/Kernel composition still lives under root `lib/**`.
- The root CLI remains a broad composition root rather than a thin facade.

## Live release graph

The current critical path is:

```text
standalone Memory ─┐
standalone Flow ───┼─> PR6 migration/cutover ─> PR7 release convergence
PR5 facade ────────┤
claim reconciliation┘

hook controls ────────────────┐
MCP registry/consent ─────────┴─> PR7
```

Current issue state:

| Outcome | Issue | Live state | Finding |
|---|---|---|---|
| Product restructure | `d6a74dc8` | P0 `in_progress` | Parent release program |
| Standalone Memory | `12d92893` | P0 open, ready | Required public product journey is missing |
| Standalone Flow | `1ff3d2f9` | P0 open, ready | Required public runner journey is missing |
| PR5 facade/capabilities | `5f4da13f` | P0 open, ready | Preserved worktree exists; AC2 adapter delivery is intentionally incomplete |
| Claim reconciliation | `9e31a2f0` | P1 open, ready | Required before migration |
| PR6 migration/extraction | `f2a96ff1` | P0 blocked | Waits for the four rows above |
| Hook control projection | `7268bc9b` | P1 open, ready | PR7 side gate |
| MCP registry/consent | `9658c21a` | P1 open, ready | PR7 side gate |
| PR7 release convergence | `eb2f1753` | P0 blocked | Waits for PR6 and both control-plane gates |
| Stable release promotion | `8e634347` | P0 blocked | Fourteen of fifteen legacy dependencies are done; skills evaluation remains open |

The PR4B parent (`1eddb71d`) is marked done while monitor durability (`6ddd30c6`), restart-safe watchers (`c5112cd4`), skill mirror authorization (`209d80bc`), and mirror recovery (`c94f36f9`) remain open. This is a graph inconsistency. Each child must either receive current exact-head acceptance evidence and close, or re-enter implementation. The parent status alone is insufficient.

The release graph also omits several practical gates: published-package runtime completeness (`95372af8`), Bun global install behavior (`66e6890a`), Sonar security-rating disposition (`247ec784`), process-tree test isolation (`50d3f2c3`), and bounded Windows process-heavy shard scheduling (`fd64f6c9`). They need explicit PR7 dispositions even when they do not become new dependency edges.

## Preserved implementation state

The only current restructure candidate near the current master line is `.worktrees/pr5-integration`, branch `codex/pr5-integration`, at `065be8593d0cc71611a4562bbe9eae0b2ae77165`. It is clean, seven commits ahead and two behind `origin/master`, with no remote branch or PR. Its bounded facade work has focused evidence, but concrete T0-T4 delivery adapters are absent. The branch should be rebased and shipped as the truthful facade/capability slice; adapter expansion belongs to separate issues.

The preserved PR2 through PR4 worktrees are older beta.5-era stacks. They are evidence and possible commit sources, not branches to merge wholesale into current master.

The shared root is 14 commits behind `origin/master` and dirty with user-owned files. It must not be reset, cleaned, or used as an integration base.

## Agent Companion

Agent Companion is a separate repository. Its committed `main` and `origin/main` are both `3cdcc0fc4d31a16658a3a7c52d3919884d9ad236`. The live checkout contains 70 modified tracked files and 20 untracked paths beyond that commit. There is no clean external branch or PR to import. An interrupted test run exposed failures in parallel batch settling and command-storm ordering; because the run was stopped before its aggregate, its status is `INCOMPLETE`.

The existing Companion adapter shape is suitable for an execution provider:

```js
adapter.run(request, { signal, onProgress })
adapter.control(command)
```

Forge currently has no tracked Companion bridge. The live bridge issue is `8d14651d`, blocked by authority, adapter certification, lifecycle semantics, Agent Config policy, and Windows backpressure work. Companion is therefore an independent, optional provider lane. It is not a Forge 0.1.0 release dependency.

## Stability and performance evidence

Recent merged fixes prove that validation false-greens and Bun subprocess launch cost are real concerns, but they do not prove the release candidate. The current runner already has unit, subprocess, and exclusive resource lanes plus weighted Windows scheduling. The next release work should close correctness and contention gaps before redesigning the runner.

Release-relevant open stability work includes resource-aware push/full-suite execution, durable aggregate results across caller timeouts, Windows shard contention, selected Memory recall persistence, Flow monitor tail stability, Windows child-process cleanup, and SQLite FTS5 filtering.

General cache redesign, impact-aware validation, broad CI deduplication, and startup micro-optimization lack a release-candidate baseline. They should be measured after 0.1.0 unless a current failure demonstrates that they block reproducible release evidence.

The approved release matrix remains broader than package development smoke: Ubuntu, macOS, Windows, Node 22 and 24, Memory-only, Flow stateless, Flow connected, facade installs, all supported harness projections, migration/rollback, monitor lifecycle, package integrity/provenance/OIDC/dist-tags, and a sequential merge-train simulation. RC acceptance requires immutable prerelease artifacts published under `next`, at least 50 distinct clean journey/environment pairs, every G0-G8 lane, and seven cumulative automated observation days without an unresolved S0/S1 event.

## Confusion and low-value surfaces

The highest-value simplifications are architectural convergence rather than immediate deletion:

- Keep `@forge/contracts` as a small physical package, but document it as Memory-governed infrastructure rather than a fourth product.
- Make `packages/memory` the single implementation owner; root Memory/Kernel modules become compatibility delegates before later deletion.
- Make Flow's monitor runtime the single engine; Shepherd remains a specialization over it.
- Simplify the one-backend issue selector after beta.5 migration behavior is proven.
- Keep Beads import/rollback compatibility through the stable migration window; retire live export/runtime surfaces afterward.
- Keep current binary aliases through 0.1.x, then remove obsolete aliases with a announced migration.
- Keep one canonical skill source and generate harness mirrors atomically; do not delete required tracked mirrors until clean-install discovery is proven.
- Treat Graphiti and other graph/vector systems as optional enrichment projections. Remove or correct configuration documented as having no runtime effect.
- Supersede unparented auto-stub issues that duplicate canonical restructure lanes.
- Audit the very large worktree inventory after ownership checks; never bulk-delete dirty or active worktrees.

Physical deletion before consumer, migration, and replay evidence would increase release risk. The 0.1.0 goal is one owner per behavior and truthful diagnostics; most compatibility-file deletion belongs to a post-0.1 cleanup release.
