# Stable Release Decisions

## Locked on 2026-07-28

1. **Do not gate stable on the entire backlog.** The tracker contains 407 open issues across P0–P4 and long-horizon product work. Only failures of the supported `0.1.0` contract can block release.
2. **Use `0.1.0-beta.5` as the feature-complete boundary.** It includes the full S0 cohort plus the post-beta.4 kernel, setup, clean, memory, CI, and test-isolation hardening. After beta.5, only reproduced release-stopper fixes may change behavior; features, commands, schemas, setup footprint, or breaking defaults reset the beta/RC clock.
3. **Make automatic skills and memory part of the stable contract.** A relevant Forge skill or memory that exists but is not surfaced without the user naming it is not operationally available. Stable requires bounded, automatic, observable selection and injection.
4. **Keep the stable surface narrower than the roadmap.** Advanced dashboard/live-link work, single-binary distribution, Graphiti enrichment, advanced skill composition, and cloud/team authority remain post-stable unless needed to make an advertised stable path truthful.
5. **Run a four-lane merge train with a WIP cap of four.** Each lane owns non-colliding files in an isolated Forge worktree. One coordinator controls merge order, head-SHA review settlement, and cleanup.
6. **Never retry a deterministic red as a flake.** Reproduce, diagnose, fix, and add a regression. A retry is allowed only after evidence identifies an external transient failure.
7. **Release evidence is journey-based.** Unit-green alone is insufficient. Release candidates must prove install → activate → orient → retrieve memory/skills → execute workflow → validate → ship/shepherd → close/cleanup on Windows and Linux with supported harnesses.
8. **The existing OIDC release workflow remains the publication authority.** The release tag must match `package.json`; readiness, package inspection, tests, and provenance publishing must pass before npm receives `latest`.
9. **Building Forge must continuously improve Forge.** Every issue records both delivery evidence and process friction. Repeated friction becomes a canonical Kernel issue and a substrate-level improvement; the stable program dogfoods Forge rather than maintaining a separate orchestration process around it.
10. **Operate at a four-PR-per-three-hour merge cadence.** Four isolated lanes fill one cycle with ready, non-colliding work. CI, review settlement, current-head verification, and cleanup happen inside the cycle rather than as a later batch. The cadence is a throughput target, never permission to weaken a gate or mislabel a deterministic failure as flaky.
