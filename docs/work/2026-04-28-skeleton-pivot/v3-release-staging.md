# Forge v3 Release Staging Strategy

**Status:** Proposal · **Date:** 2026-04-28 · **Epic:** `forge-besw`
**Inputs:** `beads-operations-manifest.md`, `v3-redesign-strategy.md`, `v3-skeleton-plan.md`
**Approach:** Map Option B (MVP-A, 4–5 wks) to alpha; Option A waves 2–3 to beta; waves 4–5 to GA; deferred items to v3.1+.

---

## 1. v3.0-alpha "Skeleton-MVP" — internal dogfood

- **Issues:** `forge-besw.1`, `.2`, `.3`, `.6`, `.7`, `.10`, `.12`, `.14` (partial: BUILDING_BLOCKS.md only).
- **User-visible promise:** "Forge runs on its own repo with the same 7 stages, but they are now driven by `.forge/config.yaml`; flipping `stages.validate.enabled: false` actually collapses the workflow."
- **Internal DoD:**
  1. `forge-core/` builds standalone; `Stage` contract is the only import site.
  2. `WORKFLOW_STAGE_MATRIX` deleted; runtime loads `.forge/config.yaml`; existing test suite green.
  3. One local-resolver extension (`./local`) installs, validates against `extension.yaml`, and runs.
  4. `forge insights --review-feedback` PoC runs against this repo's last 50 PRs and produces a reviewable plan.
  5. `forge migrate` round-trips this repo from v2 to v3 with no behavior change (compat mode on).
- **Entry gate:** Epic `forge-besw` accepted; `forge-besw.1` and `.2` design notes signed off; v2 master green.
- **Exit gate:** Dogfood checklist (Section 6) passes for **5 consecutive days** on this repo by **2 maintainers**; toggle thesis demonstrated (validate disabled → workflow still ships); audit log captures every `--force` bypass.
- **Audience:** Forge core team (2–3 maintainers). No external users. Not published to npm `latest`; tagged `next`.
- **Risk:** Stage contract proves wrong shape → forces re-extraction. Mitigation: keep v2 monolith on `master` behind compat flag; alpha lives on a long-running `v3` branch.
- **Calendar:** Weeks 1–5 from kick-off (matches Option B MVP-A).

## 2. v3.0-beta "Open" — friendly users + first external skill

- **Issues added:** `forge-besw.4`, `.8`, `.15`, `.5` (basic mode flags only), plus complete `.14` and start `.9`.
- **User-visible promise:** "Install Forge with `bunx forge@beta setup`, customize via `.forge/config.yaml`, and `forge add gh:owner/repo` pulls in a SHA-pinned extension from the seed marketplace."
- **Internal DoD:**
  1. `forge options stages|gates|adapters|diff|why|lint` all return real data; AGENTS.md generated from config.
  2. `forge.lock` committed; tampered SRI rejected; `forge audit verify` clean.
  3. `forge-marketplace.json` ships with ≥3 seed entries; nightly SHA-bump bot live.
  4. `--minimal | --standard | --full` flags resolve correctly (Path A only — defer profile sync).
  5. ≥1 third-party extension installed end-to-end by an external user.
- **Entry gate:** Alpha exit met; Track 2 (extension shell) merged; `forge migrate` passed on 3 distinct repos.
- **Exit gate:** 5 friendly users complete `setup` + `add` + 1 stage run with **zero P0/P1 bugs open >72h**; Greptile/Sonar pass on the v3 branch; CI matrix green on Win/macOS/Linux × Node 20/22.
- **Audience:** ~10 friendly alpha users (private Discord/issue list). Tag: `beta`.
- **Risk:** Marketplace policy disputes (collision rule, signing). Mitigation: collision-rule docs frozen pre-release; allowlist-only.
- **Calendar:** Weeks 6–10.

## 3. v3.0 GA — public release

- **Issues added:** `forge-besw.11`, `.13`, `.17` (docs reorg), full `.9` (multi-target sync v2).
- **User-visible promise:** "v3 is the default. Run `bunx forge@latest setup` on any repo (greenfield or brownfield via `/forge map-codebase`); upgrade existing v2 projects with `forge upgrade`."
- **Internal DoD:**
  1. `forge upgrade` is idempotent and produces a clean `forge doctor`.
  2. Brownfield onboarding (`/forge map-codebase`) generates a reviewable config on a public OSS repo.
  3. Docs reorg complete (work/reference/guides/adr); link-checker green.
  4. Migration guide + ADRs D1–D7 merged; v2 monolith removed from `master`.
  5. Telemetry shows ≥80% of new installs choose default standard mode.
- **Entry gate:** Beta open ≥2 weeks with ≥10 active users; ≤2 P1 bugs; rollback plan rehearsed once.
- **Exit gate:** 14-day beta soak with no Sev1; release notes + migration guide reviewed; `bunx forge@latest setup` installs v3 by default.
- **Audience:** Public. npm `latest` tag.
- **Risk:** v2-to-v3 upgrade corrupts user repo. Mitigation: `forge upgrade` snapshots → rollback (D7); compat mode shipped through v3.1.
- **Calendar:** Weeks 11–14.

## 4. v3.1+ — post-launch

- **Issues:** `forge-besw.16` (profile sync Path A), full `.5` (install modes with profile interaction), full `.13` (map-codebase enhancements), marketplace-beyond-seed, full skill-gen observability, team patches/overlays (D5/WS22), eval per-layer attribution.
- **User-visible promise:** "Sync your Forge profile across machines, share team standards via overlay patches, and discover community extensions in a richer marketplace."
- **DoD:** Each shipped behind a feature flag (`profile.enabled`, `team.overlay.enabled`, `marketplace.discovery.enabled`); per-feature beta first.
- **Entry gate:** GA stable for 30 days; ≤1 P1/week.
- **Exit gate:** Per-feature flags off-by-default-then-on after 2-week canary.
- **Audience:** Power users / teams.
- **Risk:** Scope creep. Each item gets its own mini-RFC.
- **Calendar:** Weeks 15+.

---

## 5. RELEASE SCOPE TABLE

| Issue | Title (short) | Alpha | Beta | GA | v3.1+ |
|---|---|:-:|:-:|:-:|:-:|
| `forge-besw.1` | forge-core contract | X | | | |
| `forge-besw.2` | L1 lockdown spec + audit log | X | | | |
| `forge-besw.3` | Migrate WORKFLOW_STAGE_MATRIX | X | | | |
| `forge-besw.4` | `forge options *` introspection | | X | | |
| `forge-besw.5` | Install modes (`--minimal/standard/full`) | | flags only | | full UX |
| `forge-besw.6` | extension.yaml + validator | X | | | |
| `forge-besw.7` | Source resolvers (5 schemes) | local only | all 5 | | |
| `forge-besw.8` | forge.lock + audit + `--allow-untrusted` | | X | | |
| `forge-besw.9` | Multi-target sync v2 | | start | finish | |
| `forge-besw.10` | patch.md + `forge patch record` | X | | | |
| `forge-besw.11` | `forge upgrade` self-heal | | | X | |
| `forge-besw.12` | `forge insights --review-feedback` PoC | X | | | rich obs |
| `forge-besw.13` | `/forge map-codebase` brownfield | | | X | enhancements |
| `forge-besw.14` | ROADMAP/BUILDING_BLOCKS/SKELETON_TEMPLATES | partial | finish | | |
| `forge-besw.15` | forge-marketplace.json + collision rule | | X | | beyond-seed |
| `forge-besw.16` | `forge profile` + git sync | | | | X |
| `forge-besw.17` | docs/ reorg | | | X | |

---

## 6. DOGFOOD STRATEGY (alpha proves itself on Forge)

The alpha must prove the toggle thesis on **this** repo before shipping anywhere else.

1. **Self-host:** Forge's own `master` branch flips to `.forge/config.yaml`-driven stages by end of Week 4. The repo stops using `WORKFLOW_STAGE_MATRIX` constants — eat-your-own-dog-food enforced by CI lint rule that fails if the constant reappears.
2. **Toggle proof:** Maintainers run a real PR through `stages.validate.enabled: false` and confirm `forge options diff` shows the collapse, audit log records it, and the workflow still produces a green PR. Capture as integration test `tests/v3/toggle-thesis.test.js`.
3. **Patch proof:** Override `/dev` via `patch.md` and run `/dev` on at least one beads-tracked feature; commit the patch + audit entry.
4. **Resolver proof:** Install one local extension (e.g., a custom `/lint` adapter) and run it through the workflow.
5. **PoC proof:** Run `forge insights --review-feedback` against last 50 PRs; auto-create one beads issue from a recurring Greptile category and ship it.
6. **Daily standup ritual:** Each maintainer posts which toggles/patches they used that day for 2 weeks. If nobody touches them, the thesis is unproven and alpha exit is blocked.

---

## 7. MIGRATION GUIDE per release

| From → To | Action | Breaking? | Compat mode |
|---|---|---|---|
| v2 → alpha | None for external users (alpha is internal). For maintainers: pull `v3` branch, run `forge migrate` on a worktree. | N/A | Full v2 surface intact via `compat: true` in config. |
| alpha → beta | `bunx forge@beta setup` on a fresh checkout; `forge migrate` on existing. AGENTS.md regenerates from config — review the diff. | No (additive). | `compat: true` default. |
| beta → GA | `forge upgrade` (idempotent). Rollback snapshot created automatically. Review `forge options diff`. | Possibly: deprecated v2 commands removed if marked in beta release notes. | `compat: true` warns; off in v3.1. |
| GA → v3.1+ | Per-feature flags; `forge profile init` opt-in. | No | Each feature flag flips after canary. |

---

## 8. ROLLBACK PLAN per release

- **Alpha:** Branch-level. If alpha is bad, abandon `v3` branch — `master` (v2) is untouched. Cost: 0 user impact.
- **Beta:** `npm dist-tag rm forge beta`; friendly users instructed to `bunx forge@2.x setup`. `forge.lock` SRI lets users freeze on a known-good extension set. SLA: rollback within 4 hours of confirmed Sev1.
- **GA:** Two paths. (a) Soft rollback: `npm dist-tag add forge@2.x latest` reverts npm default; existing v3 installs unaffected. (b) Hard rollback per project: `forge upgrade --rollback` restores pre-upgrade snapshot (depends on D7 snapshot infra — must land in `forge-besw.11`). SLA: 24 h.
- **v3.1+:** Feature-flag flip. Each post-launch feature ships with a kill-switch in `.forge/config.yaml`.

---

## 9. TELEMETRY / SUCCESS SIGNALS (3 metrics per release)

**Alpha (internal):**
1. `# of stage transitions executed via config.yaml` (target: 100% of maintainer activity by Week 4).
2. `# of toggle/patch usages per maintainer per week` (target: ≥1 — proves the thesis is used, not just buildable).
3. `forge migrate round-trip success rate on test repos` (target: 3/3).

**Beta:**
1. `# of friendly users completing setup → add → 1 stage run` (target: 8/10).
2. `Mean time from install to first successful PR` (target: <30 min).
3. `# of P0/P1 bugs open >72h` (target: 0 at exit).

**GA:**
1. `Weekly active installs` (target: ≥100 by week 4 post-GA).
2. `forge upgrade success rate (idempotent + green doctor)` (target: ≥95%).
3. `% of installs choosing default standard mode without overrides` (target: ≥80% — proves defaults are sane).

**v3.1+:** Per-feature: adoption rate of the flag among existing GA installs (target: ≥20% in 30 days for any flag to graduate from canary).

---

## 10. GO/NO-GO QUESTIONS before alpha kick-off

1. **Contract finality:** Is `Stage` (`forge-besw.1`) genuinely the smallest contract, or are we one critic-pass away from re-extracting it? (If unsure, run one more anti-architect pass before Week 1.)
2. **Compat budget:** How long do we keep v2 commands working via compat mode — through GA only, through v3.1, or longer? Decision affects every migration message.
3. **Marketplace scope discipline:** Are we genuinely shipping the *seed* allowlist at beta and nothing more? If anyone on the team has scope-creep on marketplace discovery/ratings/etc., surface and defer it now.

---

## 11. WHAT NOT TO INCLUDE (deferrals users will request at alpha)

Users will ask for these. Politely defer.

- **Profile sync across machines** (`forge-besw.16`) — no. v3.1.
- **Three install-mode UX with profile interaction** — no, v3.1. Beta ships flags only.
- **Skill-gen full observability dashboard / metrics UI** — no. v3.1. Beta has the PoC only.
- **Marketplace search/discovery/ratings/categories beyond seed allowlist** — no. v3.1+.
- **Team overlay patches (`D5/WS22`)** — no. v3.1+.
- **`/forge map-codebase` advanced brownfield (multi-language detection, framework matrix)** — no, GA ships v1 only; enhancements v3.1+.
- **Per-layer eval attribution** — no. v3.1.
- **Rich plugin catalog / pricing modes** (current ROADMAP Phase 3 v2 wording) — out of scope for v3 entirely; revisit post-v3.1.
- **Custom signing keys / non-allowlist extensions without `--allow-untrusted`** — no. Security posture stays locked.

If a deferred request comes in 3+ times during alpha, file a v3.1 beads issue under `forge-besw` parent — do not expand current release scope.
