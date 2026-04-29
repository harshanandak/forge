# Marketplace + patch.md — Five Use Case Kits

**Date:** 2026-04-28
**Status:** Documentation
**Audience:** Forge users, contributors, maintainers
**Companion to:** `extension-system.md`, `skill-distribution.md`, `template-library-and-merge-flow.md`, `n1-moat-technical-deep-dive.md`

The two artifacts work as a pair:

- **`forge-marketplace.json`** — what is *available* to install (curated, SHA-pinned allowlist; same schema as Claude Code marketplace).
- **`.forge/patch.md`** — what *this* user/team *chose* and why (record of intent; survives upgrades via three-way merge).

Marketplace = inventory. patch.md = receipt. Neither alone is enough.

---

## Kit 1 — Swap Greptile for CodeRabbit on `/review`

**Day 1.** Default Forge `/review` calls Greptile. The team prefers CodeRabbit.

```bash
$ forge search reviewer
NAME                          TIER       AUTHOR    SHA       VERIFIED
adapter-pr-reviewer-coderabbit  official  forge     7f8e..    yes
adapter-pr-reviewer-greptile    official  forge     a91b..    yes  (default)
adapter-pr-reviewer-sonarcloud  official  forge     11dd..    yes

$ forge add adapter-pr-reviewer-coderabbit
→ Resolving from forge-marketplace.json (sha 7f8e..c11a, signed)
→ Installed at .forge/extensions/forge/adapter-pr-reviewer-coderabbit/
→ Wrote forge.lock entry
→ Audit: install,coderabbit,1.2.0,signed

$ forge patch record --anchor stage.review.adapter \
    --op replace --body 'adapter: coderabbit'
→ Recorded patch in .forge/patch.md (anchor stage.review.adapter, sha c3f1..)
```

**Before** `.forge/patch.md`: empty.
**After** (one new entry):

```yaml
- id: stage.review.adapter
  op: replace
  target_sha: c3f1...
  applies_to: ">=3.0.0 <4.0.0"
  body: 'adapter: coderabbit'
  reason: "team prefers CodeRabbit's inline conversation model"
  recorded_by: user@befach.com
```

**Gain:** `/review` now drives CodeRabbit; the *reason* is captured for the next teammate. Without Forge, this would be a fork or a custom shell wrapper.

**3 months later — `forge upgrade` to v3.1:** Forge ships a tweaked default `stage.review.adapter` block (now wraps adapter calls with retry). Three-way merge:
- `base` = v3.0 default body
- `theirs` = v3.1 default body (added retry)
- `ours` = `adapter: coderabbit`
- Result: clean diff3 merge — coderabbit retained, retry inherited.

**Failure mode:** CodeRabbit extension drops auth in v1.3.0. `forge.lock` pins SHA `7f8e..`; `forge update` flags the major bump and *refuses to bump* until the user reviews the changelog. Rollback: `forge remove adapter-pr-reviewer-coderabbit && forge add ...@1.2.0`.

---

## Kit 2 — Linear instead of GitHub Issues

```bash
$ forge add adapter-issue-tracker-linear
→ Installed; needs LINEAR_API_KEY
$ forge patch record --anchor stage.plan.tracker --op replace \
    --body 'tracker: linear\nworkspace: acme'
```

`patch.md` now records the team chose Linear, with workspace = `acme`. This is durable team intent, not just a config file.

**New teammate onboarding (Day 1):**

```bash
git clone repo && bunx forge setup
→ Reading .forge/patch.md
→ Detected anchor stage.plan.tracker → linear (acme)
→ Required env: LINEAR_API_KEY (not set)
→ See README §Onboarding for token issuance
forge sync
bd ready                     # Linear-backed beads issues hydrate
```

The new dev never asks "wait, do we use GitHub Issues here?" — `patch.md` is the answer.

**If Linear adapter has a bug:** `forge.lock` integrity hash + audit log mean the team can pin the previous good SHA in one command (`forge add adapter-issue-tracker-linear@1.2.7`). Marketplace-side, the curator opens a PR to bump the SHA forward when fixed; CI conformance must pass before merge.

---

## Kit 3 — Shorten `/plan` to one phase

The default `/plan` runs design Q&A → research → tasks (3 phases). A solo user wants design only.

```bash
$ forge patch record --anchor stage.plan.phases --op replace --body '
phases:
  - design
'
```

`patch.md` excerpt:

```yaml
- id: stage.plan.phases
  op: replace
  target_sha: a44c...
  body: |
    phases:
      - design
  reason: "solo project — research+tasks overhead not worth it for me"
```

No marketplace install needed — this is pure Layer-3 override against the L2 default block.

**`forge upgrade` 3 months later** ships a v3.2 default `/plan` with a new `phases.discovery` step. The three-way merge:
- base sha `a44c..` matches what was recorded → patch applies cleanly *on top of* the new default. The user keeps their one-phase override; the new `phases.discovery` exists in the default but is overridden.

**If Forge ships breaking change** (e.g., renames `phases` to `stages`): anchor SHA mismatch. Self-heal looks up `anchor_aliases.json`; if the rename is recorded there, patch is rewritten in place. Otherwise the patch goes `dormant`, `forge doctor` surfaces it, and the user is prompted to re-record.

---

## Kit 4 — Add a required Snyk gate to `/build`

```bash
$ forge add gate-snyk
→ Installed forge/gate-snyk@2.0.1 (signed)
$ forge patch record --anchor stage.validate.gates --op append --body '
- name: snyk
  required: true
  threshold:
    severity: high
'
```

The marketplace provides the *capability*; `patch.md` makes it *required* for this team.

```yaml
- id: stage.validate.gates
  op: append
  body: |
    - name: snyk
      required: true
      threshold: {severity: high}
  reason: "SOC2 control AC-7 — block on high-sev CVE"
```

**L1 interaction:** `core.hard-gate-runtime` (a locked rail) consults `gates:` config at stage exit. The L2 default gate set is *appendable* via patch.md, but the rail itself cannot be disabled — schema rejects `core.hard-gate-runtime.enabled: false` with `LOCKED_KEY_MUTATION`. So this team can *add* a required gate but cannot accidentally turn off the gate runtime.

**Failure mode:** Snyk extension's API quota runs out. Gate flips to `error`. Hard-gate-runtime refuses stage exit. User options: fix quota (right answer), or `--force-skip-gate snyk` (bypass on rail #2 — writes audit entry with reason). PR template surfaces the audit row; reviewer sees the bypass and asks why.

---

## Kit 5 — Personal `/ship` deploys to Vercel

Team default: `npm publish`. One developer wants their `/ship` to also `vercel deploy --prod` for previews. This is *personal*, not team policy.

Forge supports per-user overlays at `.forge/patches/<gh-handle>.md` composed *on top of* `.forge/patch.md`:

```bash
$ forge patch record --user --anchor stage.ship.postPublish --op append --body '
- exec: vercel deploy --prod
'
→ Recorded in .forge/patches/harsha.md (user overlay)
```

`.forge/patch.md` (team, committed):

```yaml
- id: stage.ship.publish
  op: replace
  body: 'publisher: npm'
```

`.forge/patches/harsha.md` (user, *not* committed — gitignored by default):

```yaml
- id: stage.ship.postPublish
  op: append
  body:
    - exec: vercel deploy --prod
```

**Composition order at runtime:** L1 rails → L2 defaults → team `patch.md` → user overlay. Same anchor in both team and user → user wins (locally only). Same anchor patched twice in the same file → schema error at load time.

**Failure mode:** Vercel CLI missing on a teammate's machine. The user overlay is gitignored, so it does not exist on the teammate's clone. Their `/ship` runs the team-default `npm publish` and stops. No phantom failures.

---

## Synthesis

### Why marketplace alone isn't enough
A signed extension list tells you *what is safe to install*. It does not record *which extensions this team chose, with what config, and why*. Without `patch.md`, a fresh clone of a team repo would have no way to know that "we use CodeRabbit, not Greptile" except via `README` prose, which drifts.

### Why patch.md alone isn't enough
A patch file with `body: 'adapter: coderabbit'` is meaningless if `coderabbit` isn't installed. `patch.md` references *names from the marketplace*. The marketplace supplies trust (SHA + signature + curator review); `patch.md` supplies intent. Without the marketplace, every patch would have to inline its dependency source — a supply-chain nightmare.

### The unique value of the pair
Marketplace = **what is allowed**. patch.md = **what was chosen, by whom, when, why**. Together: a Git-tracked, three-way-mergeable, audit-trailed configuration that survives Forge upgrades and team turnover. Closest analogue: Helm chart (marketplace) + values.yaml (patch.md) — but with anchor-based merging instead of value-key merging, so structural changes upstream don't blow up.

### 3 anti-patterns to avoid

1. **Editing extension files in `.forge/extensions/<author>/<name>/` directly.** They get clobbered on `forge update`. Always patch via `patch.md`.
2. **Inline-pinning a private fork URL in `patch.md`.** Bypasses the marketplace's signature/SHA verification. Add it to a private marketplace JSON instead (`forge config set marketplace.extra acme/forge-private.json`).
3. **Recording a patch without a `reason:`.** In 6 months no one will know why. Schema should require it for `op: replace` and `op: delete`.

### One thing existing tools do that Forge should copy
**Homebrew's `brew bundle dump` / `Brewfile`.** A single command that snapshots *what is installed + what is configured* into a committable file, and `brew bundle` re-applies it on a new machine. Forge should ship `forge bundle dump` that emits a normalized `forge.lock` + `patch.md` review summary, and `forge bundle apply` for one-shot environment reproduction. This makes onboarding deterministic in a way none of the per-file flows above guarantee.

---

**Word count:** ~1,510
