# Forge Skill Distribution Design — Mirror Org vs Allowlist vs Hybrid

**Date:** 2026-04-28
**Status:** Draft (decision document)
**Scope:** How Forge distributes/imports vetted external skills, stages, and extensions in its skeleton architecture.

---

## TL;DR

**Ship Option A (curated allowlist `marketplace.json` in the Forge repo, pinned by SHA) for v1.** It is the same pattern asdf-plugins ran successfully for years (1.4k stars, ~1,500 commits, volunteer-run) and it composes directly on top of Claude Code's existing `marketplace.json` primitive — Forge does not invent a new file format. Migrate toward Option C (tiered: official + community + private) only when concrete *behavioral* triggers fire. Option B (`forge-skills/*` fork-mirror) is what mise *retreated to* when upstream asdf plugin authors proved unmaintained — it is not a starting point. Option D (signed manifests) is a complement to whichever option is chosen, not an alternative; it folds into the configuration knobs.

---

## Comparison Table

| Criterion | A. Allowlist JSON in Forge repo | B. `forge-skills/*` mirror org | C. Tiered (official + community + private) | D. Decentralized + cosign attestations |
|---|---|---|---|---|
| **Maintainer cost (pre-launch / 100 / 10k users)** | ~0.5 / 1–2 / 4 hr/wk (PR triage on a single JSON) | ~2 / 6 / 20+ hr/wk (per-fork rebases, security backports) | ~1 / 3 / 10 hr/wk (split across tiers — community is unowned) | ~3 / 5 / 8 hr/wk (key mgmt + verifier + revocation infra) |
| **Trust signal (1–10)** | 5 (curator-vetted SHA pin, no signature) | 8 (Forge org owns code, can rebase) | 7 official / 4 community (clearly labeled) | 9 (cryptographic provenance, OIDC binding) |
| **User UX** | `forge add seo-skill` (resolves via allowlist) | `forge add seo-skill` (resolves to `forge-skills/seo-skill`) | `forge add seo-skill` (official) / `forge add @user/foo` (community) | `forge add gh:owner/repo` + verifier checks signature |
| **Failure modes** | Stale pin when upstream patches CVE; need bot to bump SHAs | Mirror diverges from upstream → confused users; rebase conflicts on every release | Tier confusion; community tier is a graveyard if discovery is weak | Sigstore Rekor outage blocks installs; revocation UX is hard |
| **Supply-chain attack surface** | Compromise of one upstream repo → bad SHA bumped via PR (defense: review + cosign) | Compromise of `forge-skills` org → all users; broader blast radius | Same as A for official tier; community = caveat emptor (documented) | Smallest — provenance is verified, but only as good as the trust root |
| **Decentralization (10 = max)** | 7 (anyone can fork the allowlist) | 3 (Forge maintainers gatekeep) | 6 (community tier open) | 9 (no central index) |
| **Migration path forward** | Easy → C (add tiers), easy → D (add `attestation` field next to `sha`) | Painful → A (have to deprecate forks) | Easy → D (layer signing onto official tier) | Already terminal — but still needs A-style discovery on top |

---

## Decision Tree — Behavioral Triggers, Not User Counts

User-count tiers are guesses. Migrate when one of these *measurable* signals fires:

1. **Stay on Option A while:** maintainer review queue ≤ 2 h/week, no supply-chain incident in any installed skill, < 5 name collisions in the registry.
2. **Migrate to Option C (tiered) when any of:** review queue > 2 h/week for 3 consecutive weeks; > 5 skills with overlapping names; or a community contributor requests a curated-but-unowned tier explicitly.
3. **Migrate to Option B (mirror) only when:** an upstream skill ships a CVE/regression and its maintainer is unresponsive for > 7 days (this is the exact mise scenario). Mirror that *one* skill — do not blanket-fork.
4. **Layer Option D (signing) when:** first install reaches an enterprise/regulated user, or a supply-chain incident occurs anywhere in the ecosystem (not just Forge's).

---

## Recommended Path

- **v1 (now):** Option A. A `forge-marketplace.json` in the repo, schema-compatible with Claude Code's marketplace format (so the existing install plumbing — `github`/`url`/`npm` sources, `ref`+`sha` pinning, `strict` mode — is reused). Each entry: `name`, `source`, `sha` (mandatory), `version`, `verified` (curator flag), optional `attestation_url`. Bot opens PRs to bump SHAs nightly; humans merge.
- **v1.5:** Add a `tier` field (`official` | `community`) and a separate `forge-community.json`. No mirror org yet.
- **v2 (only on trigger 3 above):** Stand up `forge-skills/*` for the *specific* skills whose upstreams are unmaintained. Document why each fork exists and its rebase cadence — copy mise's "asdf-plugins are legacy" note pattern.
- **Always-on:** Option D's verification (cosign / SLSA provenance / PEP 740 attestations) layered on top — implemented as a verifier in `forge add`, not a separate option.

---

## Top 3 Prior-Art Lessons to Copy

1. **asdf-plugins shortname registry pattern.** A single repo of `<name>/repository` files, PR-reviewed, no forks. 1.4k stars and zero documented supply-chain incidents over years of operation. This is the Option A blueprint. (`https://github.com/asdf-vm/asdf-plugins`)
2. **PyPI Trusted Publishers + PEP 740 attestations.** OIDC-bound short-lived tokens replace long-lived API keys; in-toto SLSA Provenance binds artifacts to source. Forge's verifier should accept the same predicates rather than inventing a new signing scheme.
3. **Claude Code marketplace `ref` + `sha` dual pinning + `strict` mode.** Already shipped. Forge consumes this — does not reimplement it. Pin by `sha` for vetted entries; use `ref` only for trusted-org auto-update channels.

## Top 3 Anti-Patterns to Avoid

1. **mise's blanket retreat from asdf into a fork-mirror org.** Justified for them given specific unmaintained upstreams, but expensive to run and reduces decentralization. Do not start here.
2. **GitHub Actions Marketplace's "verified creator" badge with no objective criteria.** A partner-email process is unscalable and arbitrary; Forge should use an automatable check (signature present + SHA pinned + curator-approved PR).
3. **Artifact Hub's "official" badge requiring software-vendor ownership.** Over-restrictive for a workflow harness — most Forge skills will be authored by users, not vendors. Use "verified" (curator-reviewed) without an "official" tier.

---

## 5 Configuration Knobs (Required Regardless of Option)

1. **Pinning policy:** `sha` (default for `verified`), `ref` (allowed for `trusted-org`), `version` (semver for npm-source skills only). Never allow unpinned `main`.
2. **Signature verification:** `forge.skills.verify_signatures = "required" | "warn" | "off"` — checks cosign / SLSA provenance / PEP 740 attestations. Default `warn` until D lands, then `required` for official tier.
3. **Allowlist vs blocklist mode:** `forge.skills.install_mode = "allowlist" | "any-with-warning"`. Default `allowlist` (only registry entries installable). `any-with-warning` for power users who pass `--from-url`.
4. **Telemetry / audit log:** every install logs `{name, source, ref, sha, signature_verified, installed_at, installer}` to a local audit file; opt-in upload for security incident response.
5. **Auto-update cadence:** `forge.skills.update = "manual" | "weekly" | "on-pin-change"`. Default `on-pin-change` (re-resolve when `forge-marketplace.json` SHA bumps).

---

## The Edge Case That Bites Naive Implementations

**Name collision / shadowing across sources.** Day one, two skills are both called `test-runner` — one in the official allowlist, one a user wants to install from a private GitHub URL. Naive implementations either silently shadow (security risk: typosquatting) or hard-fail (poor UX). Forge must pick *now*:

- **Adopt Homebrew's fully-qualified-name fallback:** short name (`test-runner`) resolves only via the registry; ambiguous installs require `forge add owner/repo/test-runner`. The shortname is reserved on a first-PR-merged basis (asdf-plugins enforces global uniqueness via PR review — copy this).
- **Reserve a `@scope` prefix** for community-tier skills (npm pattern), e.g. `forge add @harsha/test-runner`, so the official `test-runner` short name is never accidentally shadowed.

Retrofitting either rule after users have installed conflicting skills is painful (rename migrations, broken `forge.config.json` files, breaking changes to existing PRs). Decide before v1 ships.

---

## Appendix: Sources Indexed

`asdf-plugins-org`, `homebrew-taps`, `homebrew-core-contributing`, `mise-registry`, `claude-plugin-marketplaces`, `github-actions-marketplace`, `artifacthub-repos`, `pypi-trusted-publishers`, `pypi-attestations`, `docker-verified-publisher`. Searchable via `ctx_search(source: "<label>")`.
