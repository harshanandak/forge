# Release

Owner setup:

- Add npm's GitHub Actions trusted publisher for `forge-workflow`: user `harshanandak`, repo `forge`, workflow `release.yml`, environment `release`. Enable direct `npm publish` and **Allow npm dist-tag** separately; no stored token or token fallback.
- Create GitHub's `release` environment with the owner as required reviewer, self-review disabled and main-only deployments. An environment name alone provides no approval gate.

[npm requirements](https://docs.npmjs.com/trusted-publishers/): hosted runners, npm >=11.5.1, Node >=22.14. OIDC dist-tags need npm >=11.21.0 (11.x) or >=12.2.0 (12.x) and separate permission. We pin npm 11.21.0 on Node 24; the owner must fix missing permission before promotion.
Public repo/package OIDC generates provenance; we request it, require registry attestations and audit signatures.

Run: merge the intended version, await successful main CI, dispatch Release on main with its numeric `run_id` at that same commit. Review verify's version/hash, approve publish to `next`, inspect all three readbacks, then approve `latest`.
Failures before promotion leave `latest` unchanged. Versions are immutable: redispatch rejects existing versions; investigate before recovery.
Locally build, `npm pack --ignore-scripts`, create the `.sha256` sidecar, then `bun run release:dry-run <tarball>`. Offline checks skip explicitly locally; CI fails closed.

Manual IDs cost a lookup but bind tested bytes; tag triggers are out of scope. Second approval costs time but separates promotion. Windows/macOS coverage warrants runner capacity (public minutes are free). No job rebuilds/repacks; this lane performs no owner setup or publication.
