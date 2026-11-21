# Release

Owner setup:

- Add npm's GitHub Actions trusted publisher for `forge-workflow`: user `harshanandak`, repo `forge`, workflow `release.yml`, environment `release`. Enable direct `npm publish` and **Allow npm dist-tag** separately; no stored token or token fallback.
- Create GitHub's `release` environment with required reviewers, main-only deployments, and administrator bypass turned off so admins also wait for approval. An environment name alone provides no approval gate. With a single owner, leave "Prevent self-review" off, or the owner's own dispatch can never be approved; the gate is then a deliberate pause, not a second person. Turn it on once a second reviewer exists.

[npm requirements](https://docs.npmjs.com/trusted-publishers/): hosted runners, npm >=11.5.1, Node >=22.14. OIDC dist-tags need npm >=11.21.0 (11.x) or >=12.2.0 (12.x) and separate permission. We pin npm 11.21.0 on Node 24; the owner must fix missing permission before promotion.
Public repo/package OIDC generates provenance; we request it, require registry attestations and audit signatures.

Release readback installs its pinned ecosystem fixture tools and requires every installed journey, including Vitest, Jest, pytest and Make. Missing tools, skipped tests, failed tests or an absent native test report block promotion. Developer pack smoke may still report optional ecosystem skips; release acceptance cannot.

Run: release `0.0.11` as the local-only stable version and promote it to `latest` after readback and the second approval. The next prerelease line is `0.1.0`. Require an unused version, successful main CI, and dispatch Release with its numeric `run_id` at that same commit. Review verify's version/hash, then approve publish to `next`.

Before promotion, require all three OS readbacks: exact registry version and `next` tag, approved archive integrity, native installed version/clean build commit, npm-verified signatures and provenance from this repository's main release workflow, and the full registry-installed journey. Retain the run logs.

The second approval promotes a stable version (one without a hyphen) to `latest` and a prerelease to `beta`. Before giving that approval, the owner reviews the `packed-package` artifact and the SHA-256 printed by the `Pack artifact` job in successful main CI at the release commit. In that same CI run, confirm that the `Pack smoke` step passed in every verification job that runs it. The step checks the archive against that SHA-256. Review the three OS registry readbacks above. Retain the digest and the CI run link with the readback logs. Never promote from version/help output alone or substitute phase names for acceptance.

Forge 0.0.11 supports local project storage only. Cloud projects are outside this release. Live two-machine tracker and restore acceptance returns with the v3 cloud launch. The automated journey uses isolated fixtures; it does not prove live restore or tracker cutover.

Prereleases publish to `next`, and promotion moves `beta`; stable versions move `latest`. Moving `beta` switches anyone installing `forge-workflow@beta` from old to new Forge.

Failures before promotion leave `beta` and `latest` unchanged. Versions are immutable: redispatch rejects existing versions. If readback fails after publish, fix the cause, then use "Re-run failed jobs" on the same run: it reruns readback and promote with the earlier verify and publish outputs, and promote still waits for `release` approval. "Re-run all jobs" and a new dispatch both fail in verify because the version exists.
Locally build, `npm pack --ignore-scripts`, create the `.sha256` sidecar, then `bun run release:dry-run <tarball>`. Offline checks skip explicitly locally; CI fails closed.

Manual IDs cost a lookup but bind tested bytes; tag triggers are out of scope. Second approval costs time but separates promotion. Windows/macOS coverage warrants runner capacity (public minutes are free). No job rebuilds/repacks; this lane performs no owner setup or publication.
