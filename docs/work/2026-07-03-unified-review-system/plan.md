# Unified, Pluggable, Bring-Your-Own Review System — Design

**Status:** Design / plan only (no implementation)
**Date:** 2026-07-03
**Author:** forge architect (team session)

## North star

forge is a user-extensible toolkit — "give users the hammer and shovel; they dig
and carve it their own way." Today the review stage is Greptile-shaped: a real
adapter SPI exists in code, but the runtime `/review` flow bypasses it and hard-codes
Greptile + SonarCloud + GitHub Actions in prose. This design turns review into a
**pluggable seam**: a user selects/enables/orders review providers, brings their own
adapter (Greptile, CodeRabbit, Devin, SonarCloud, GitHub Actions, or a custom CLI),
and tweaks the workflow (order, gates, auto-fix, reply templates) — mirroring the
extensibility patterns forge already uses (`.forge/*.json` toggles, editable
`skills/<name>/SKILL.md`, declaration-beats-inference `.docgate.json`, enable/disable
gates).

---

## 1. Current-state assessment (evidence)

### 1a. A review-adapter SPI already exists — but is half-wired

- **`lib/review-adapter.js`** — the SPI. `REQUIRED_REVIEW_ADAPTER_METHODS =
  ['fetchThreads', 'parse', 'reply', 'resolve', 'score']` (review-adapter.js:3),
  `class ReviewAdapter` (review-adapter.js:11) with `id/kind/name/version`, and
  `validateReviewAdapter(adapter)` (review-adapter.js:40) which requires
  `kind === 'review'` and all five methods.
- **`lib/adapters/greptile-review-adapter.js`** — reference impl.
  `class GreptileReviewAdapter extends ReviewAdapter` (line 22). `fetchThreads`,
  `reply`, `resolve` all **delegate to an injected `this.github` client** and throw
  "requires a GitHub client" if absent. `parse()` normalizes GraphQL
  `reviewThreads.nodes` → normalized shape, then **filters by hardcoded
  `authorPrefix = 'greptile-apps'`**. `score()` = git-log commit matching
  (`matchThreadsToCommitsWithGit`).
- **Normalized thread shape** (ADAPTERS.md "Review Contract"):
  `{ id, commentId, file, line, body, author, isResolved, raw }`.
- **`lib/adapter-cli.js`** — `forge adapter <test|list|enable|disable>` and
  `forge new adapter <name> --kind=review --template=greptile`. Scaffolds to
  `.forge/adapters/review/<name>.js` (`getReviewAdapterDir`, line 56;
  `renderReviewAdapterScaffold`). `loadAdapter(name, projectRoot)` (line 147)
  **hardcodes `greptile` as reserved** → `new GreptileReviewAdapter()`, else loads
  the user file. `runFixtureReplay` validates + replays a fixture.
- **`docs/reference/ADAPTERS.md`** — documents the contract, lifecycle
  (fetch→parse→score→reply→resolve), scaffold, fixture replay, and states: "Only
  review adapters and the Greptile-shaped starter template are supported in this
  foundation PR."

**Assessment:** the *shape* of a pluggable seam is present and genuinely
provider-agnostic for **offline parse/score** (fixture replay). But live
`fetchThreads/reply/resolve` need a `this.github` client **nothing wires up**, so in
production the SPI is used only for parse/score matching, not for live review.

### 1b. Config exists but is write-only (a stub)

- `setAdapterEnabled` (adapter-cli.js:240) writes **`.forge/adapters.json`** shaped
  `{ review: { <name>: { enabled: boolean } } }` (lines 251–264). **Nothing reads it
  at runtime** — `loadAdapter` ignores enabled state; no registry consumes it. So
  enable/disable is a no-op today.

### 1c. The `/review` runtime is hardcoded prose, disconnected from the SPI

- **`skills/review/SKILL.md`** orchestrates in prose: Step 2 GitHub Actions, Step 3
  "Process Greptile Review" (calls `bash .claude/scripts/greptile-resolve.sh`),
  Step 4 SonarCloud (via sonarcloud skill), Step 5 "Other CI/CD". The `<HARD-GATE:
  /review exit>` requires `greptile-resolve.sh stats <pr> shows "All Greptile threads
  resolved"`. **No mention of CodeRabbit. No use of the adapter SPI.**
- **`.claude/scripts/greptile-resolve.sh`** is the real engine: `list / list-all /
  reply / resolve / reply-and-resolve / resolve-all / stats`, using REST replies +
  GraphQL `resolveReviewThread` (resolve_thread) and paginated
  `reviewThreads { isResolved }` (fetch_threads). **`.claude/rules/greptile-review-process.md`**
  encodes the reply-vs-resolve discipline.

### 1d. Provider identity is hardcoded in several disconnected places

- **Provider selection**: `setup.js` `promptForCodeReviewTool` writes a single
  `CODE_REVIEW_TOOL` env token (`github-code-quality | coderabbit | greptile | none`,
  setup.js:1183–1206) — coarse single-select, not consumed by `/review`.
- **Catalog**: `lib/plugin-catalog.js` lists `coderabbit / greptile / qodo-merge`
  as `stage: 'review'` tools with tier/install/alternatives (lines 298–330).
- **Merge-gate bot filter**: `lib/pr-shepherd.js` `BOT_LOGINS` hardcodes
  `coderabbitai, sonarqubecloud, github-actions, qodo-merge-pro, codecov,
  greptile-apps, dependabot` (pr-shepherd.js:36–40). Shepherd **never resolves
  threads** (leaves to `/review`), declares merge-ready only when the required check
  set is known + green, and treats bot-opened threads with a later human reply as
  actionable.
- **CodeRabbit** is second-class: `.coderabbit.yaml` (`auto_review.enabled`) +
  `.github/workflows/coderabbit-after-tests.yml` + GitHub App + a **separate**
  `coderabbit:` plugin (skills `coderabbit:code-review`, `coderabbit:autofix`). It has
  **no review adapter** and is absent from `/review`'s flow.

### 1e. Provider taxonomy — one model does not fit all

Two structurally different feedback surfaces exist, and the current normalized
shape only models the first:

1. **Thread/comment providers** (Greptile, CodeRabbit, human reviewers): inline
   review threads + a summary comment; resolvable via GraphQL `resolveReviewThread`.
2. **CI-check / quality-gate providers** (SonarCloud, GitHub Actions, Codecov):
   a check-run pass/fail + a set of issues; "resolution" = re-run / fix-until-green,
   not thread resolve.

The SPI's `{ file, line, body, isResolved }` thread shape and `resolve()` semantics
fit (1) but not (2). `/review` handles (2) in bespoke prose per tool.

### What is hardcoded vs. genuinely agnostic

| Concern | Agnostic today | Hardcoded today |
|---|---|---|
| Offline parse/score contract | ✅ SPI + fixture replay | — |
| Scaffolding a new adapter | ✅ `forge new adapter` | template = greptile only |
| Live fetch/reply/resolve | partial (injected client) | greptile reserved in `loadAdapter`; `authorPrefix='greptile-apps'` |
| Provider selection | — | `CODE_REVIEW_TOOL` single enum; `.forge/adapters.json` write-only |
| `/review` orchestration | — | Greptile/Sonar/GH-Actions prose; `greptile-resolve.sh` in HARD-GATE |
| Merge-gate bot filter | — | `BOT_LOGINS` static set |
| CI-check feedback | — | not modeled as adapters at all |
| CodeRabbit | — | config + separate plugin, not in flow |

**Common across all providers** (what a unified interface must abstract): *discover*
feedback (inline threads + summary + CI checks), *normalize* to a common model,
*categorize/score* against local work, *reply/acknowledge*, *resolve*, and *report a
merge-gate verdict*.

---

## 2. Proposed unified review-adapter interface

Keep the existing five methods (backward compatible) and layer a **capability
model** plus a **superset feedback model** so thread-providers and CI-providers share
one contract.

### 2a. Capability declaration

```js
capabilities() {
  return {
    inlineThreads:   true,   // posts line-anchored review threads
    summaryComment:  true,   // posts a PR-level summary
    ciCheck:         false,  // contributes a required/optional status check
    resolvable:      true,   // supports resolve() (GraphQL/thread close)
    autofix:         false,  // can propose/apply fixes (e.g. coderabbit:autofix)
    gate:            true,   // contributes to merge-gate verdict
  };
}
```

`/review` reads capabilities to decide which steps apply, instead of hardcoding
"Greptile has inline+summary, SonarCloud has a quality gate."

### 2b. Unified feedback model (superset)

A single normalized item with a `type` discriminator subsumes the current thread
shape (fully backward compatible — thread fields unchanged):

```js
{
  provider: 'greptile',
  type: 'inline' | 'summary' | 'check',   // NEW discriminator
  id, commentId, file, line, body, author, isResolved, raw,   // existing shape
  severity: 'blocking'|'major'|'minor'|'nit'|'info',  // NEW (normalized)
  checkName, conclusion: 'pass'|'fail'|'pending',      // NEW (type:'check')
  suggestedFix: null,                                   // NEW (autofix)
}
```

### 2c. Methods (SPI v2 — additive)

- `capabilities()` — declares the above.
- `discover(context)` — **unified replacement for `fetchThreads`+`parse`**; returns
  `{ items: Feedback[] }` covering inline + summary + checks. Default impl:
  `parse(await fetchThreads(ctx))` so existing adapters keep working unchanged.
- `parse / fetchThreads` — retained (Greptile impl untouched).
- `score(items, context)` — retained; classify which items local work addresses.
- `reply(context)` / `resolve(context)` — retained.
- `gateStatus(context)` — **NEW**; returns `{ blocking: boolean, reasons: [] }`
  (e.g. unresolved blocking threads, failing quality gate). This is the abstraction
  the merge-gate + shepherd consume instead of `greptile-resolve.sh stats`.

### 2d. How each provider maps on

| Provider | type(s) | discover | reply/resolve | gateStatus |
|---|---|---|---|---|
| **Greptile** | inline+summary | GraphQL `reviewThreads` (existing) | REST reply + GraphQL `resolveReviewThread` (existing `greptile-resolve.sh`) | unresolved `greptile-apps` threads |
| **CodeRabbit** | inline+summary, autofix | same GitHub review-thread API, `authorPrefix='coderabbitai'` | same reply+resolve; optional `coderabbit:autofix` for suggestedFix | unresolved coderabbit threads |
| **Devin** | inline+summary | Devin review API / GitHub threads | reply/resolve via GitHub threads | unresolved Devin threads |
| **SonarCloud** | check | Sonar quality-gate + issues API (existing sonarcloud skill) | reply = PR comment / issue triage; resolve = mark false-positive | quality-gate != PASSED |
| **GitHub Actions / Code Quality** | check | `gh pr checks` / check-runs | reply = n/a; "resolve" = fix-until-green / `rerun --failed` | any required check failing |
| **Custom CLI (BYO)** | any | shells a user command emitting the feedback JSON on stdout | shells user reply/resolve commands | user command exit code / JSON verdict |

A **generic `CliReviewAdapter`** lets a user bring a provider **without writing JS** —
they declare shell commands in `.forge/review.json` (see §3) that emit/consume the
normalized JSON. This is the "hammer and shovel" seam for arbitrary tools.

---

## 3. User configuration + Bring-Your-Own

### 3a. `.forge/review.json` — the tweakable workflow (promote the existing stub)

Today `.forge/adapters.json` (`{review:{<name>:{enabled}}}`) is written but never
read. Promote it into a **consumed** config that also carries ordering, gates, and
workflow knobs. Load/normalize/write it with the exact pattern of
`lib/doc-gate/okf-config.js` (`loadConfig`/`normalize`/`writeConfig`, preserving
unknown keys), so it is safe to hand-edit.

```jsonc
{
  "providers": [
    { "id": "greptile",   "enabled": true,  "authorPrefix": "greptile-apps", "gate": true },
    { "id": "coderabbit", "enabled": true,  "authorPrefix": "coderabbitai",  "autofix": true },
    { "id": "sonarcloud", "enabled": true,  "gate": true },
    { "id": "acme",       "enabled": true,  "kind": "cli",
      "commands": { "discover": "acme review json --pr $PR", "reply": "...", "resolve": "..." } }
  ],
  "order": ["ci", "greptile", "coderabbit", "sonarcloud"],  // discover/fix order
  "gates": { "requireAllResolved": true, "blockOn": ["blocking","major"], "allowNits": true },
  "autofix": { "enabled": false, "requireApproval": true },
  "replyTemplates": { "fixed": "Fixed in {sha}: {summary}", "wontfix": "Out of scope: {reason}" }
}
```

- **Select/enable**: `forge adapter enable|disable <id>` (already exists — just make
  it *read* back). BYO built-ins (coderabbit, sonarcloud, devin, github-actions)
  become first-class ids alongside `greptile`.
- **Bring your own**: `forge new adapter <name> --kind=review --template=<greptile|coderabbit|cli>`
  scaffolds `.forge/adapters/review/<name>.js`; the user references it in
  `providers[]`. Or, for no-JS, a `kind:"cli"` entry with `commands{}`.
- **Tweak the workflow**: `order`, `gates`, `autofix`, `replyTemplates` are all
  hand-editable — the same "editable canonical source" ergonomic as `SKILL.md`.

### 3b. Review-adapter registry (mirror `lib/commands/_registry.js`)

Add `lib/adapters/review-registry.js` that auto-discovers, exactly like the command
registry's `readdirSync` + `validateCommand` pattern (_registry.js `loadCommands`):

1. **Built-ins** — `greptile` (exists), plus new `coderabbit`, `sonarcloud`,
   `github-actions`, `devin`, and the generic `cli` adapter.
2. **User adapters** — every `.forge/adapters/review/*.js` validated by
   `validateReviewAdapter`.
3. **Filter + order** by `.forge/review.json` `providers[].enabled` + `order`.

`loadAdapter` stops hardcoding greptile-as-only-reserved and instead resolves any id
through the registry (built-in or user), with the injected GitHub client supplied
centrally so live `fetch/reply/resolve` finally work for *all* thread providers.

---

## 4. `/review` SKILL becomes a thin orchestrator

Rewrite `skills/review/SKILL.md` from a Greptile-specific script into a
provider-agnostic loop over the registry:

```
providers = registry.enabled(order)            # from .forge/review.json
for p in providers:
    items = p.discover(ctx)                     # inline + summary + checks
    items = p.score(items, ctx)                 # what local work addresses
    categorize(items)                           # valid / invalid / out-of-scope / check-fail
    fix() ; optionally p.autofix() if enabled
    p.reply(ctx, replyTemplates)                # templated
    p.resolve(ctx) if p.capabilities().resolvable
gate = merge(all p.gateStatus(ctx))             # unified verdict
HARD-GATE: gate.blocking == false               # replaces greptile-resolve.sh stats
```

The HARD-GATE exit stops naming Greptile; it asserts `registry.gateStatus()` is
non-blocking. `greptile-resolve.sh` becomes the **transport used by the Greptile
adapter**, not the skill's engine. `pr-shepherd.js`'s `BOT_LOGINS` is derived from
`registry.enabled().map(authorPrefix)` instead of a static set, so adding a provider
updates the shepherd automatically.

---

## 5. Migration path (keep Greptile working the whole time)

Each phase ships independently; nothing breaks between phases.

1. **P1 — Consume config (no behavior change).** Make `.forge/adapters.json`/
   `.forge/review.json` *read* by a new `review-registry.js`. Greptile stays the
   default; enable/disable finally does something. Ship registry + config loader +
   tests (fixture replay already exists as the test harness).
2. **P2 — SPI v2 additive.** Add `capabilities()`, `discover()`, `gateStatus()` with
   backward-compatible defaults. Greptile adapter gains them; existing five methods
   untouched. Wire a central GitHub client so live methods work.
3. **P3 — Port existing providers to adapters.** `CodeRabbitReviewAdapter`
   (authorPrefix `coderabbitai`, optional `coderabbit:autofix`), `SonarCloudReviewAdapter`
   (`type:'check'`, wraps sonarcloud skill), `GithubChecksAdapter` (`gh pr checks`).
   Add the generic `CliReviewAdapter`.
4. **P4 — Thin the skill.** Rewrite `skills/review/SKILL.md` as the §4 loop; move
   Greptile-specific prose into the Greptile adapter's docs. Update HARD-GATE to the
   unified gate. Derive `pr-shepherd` `BOT_LOGINS` from the registry.
5. **P5 — Unify selection.** Fold `CODE_REVIEW_TOOL` (setup.js) into `.forge/review.json`
   `providers[]` (multi-select), and surface `plugin-catalog.js` review tools as
   installable adapters. Deprecate the single-select env token.

Rollback safety: P1–P2 are pure additions; if the registry is empty/misconfigured,
`loadAdapter('greptile')` still returns the bundled adapter and the current script
path keeps working.

---

## 6. Risks & open questions

- **Live GitHub client wiring.** The SPI's `fetch/reply/resolve` currently need an
  injected client that nothing provides; `greptile-resolve.sh` does this out-of-band.
  Do we reimplement its REST+GraphQL in JS (testable, cross-provider) or keep shelling
  the script? Recommendation: a shared JS GitHub thread client, with the script kept
  as a thin CLI wrapper for back-compat.
- **Thread vs. check unification.** Forcing CI checks into the feedback model risks a
  leaky abstraction. Mitigate with the `type` discriminator + `capabilities()` so
  consumers branch cleanly rather than pretending a check is a thread.
- **Author identification.** Per-provider `authorPrefix` is brittle (bot renames, app
  vs. bot suffixes — cf. `BOT_LOGINS` `[bot]` variants). Consider matching on
  GitHub App slug / check-suite app id, not login prefix.
- **Trust / arbitrary code.** BYO JS adapters and `kind:"cli"` commands execute
  user-supplied code from `.forge/`. Keep the existing path-containment guard
  (`getAdapterPath` "must stay under .forge/adapters") and document the trust model;
  do **not** auto-run untrusted adapters from cloned repos without opt-in.
- **CodeRabbit dual identity.** It exists both as a would-be adapter and as a separate
  `coderabbit:` plugin (autofix). Decide whether the adapter *delegates* to the plugin
  or reimplements — recommend delegate (adapter is discovery/gate; plugin does autofix).
- **Ordering semantics.** Does `order` mean discover order, fix order, or gate
  precedence? The config separates `order` (discover/fix) from `gates` (verdict) to
  avoid conflation.
- **`isResolved` for check providers.** Checks have no thread to resolve; `gateStatus`
  (not `resolve`) is their gate contribution — the skill must not try to `resolve()`
  a `type:'check'` item (guarded by `capabilities().resolvable`).
