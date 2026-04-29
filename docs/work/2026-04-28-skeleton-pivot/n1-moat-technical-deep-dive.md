# N=1 Moat — Technical Deep Dive

**Date:** 2026-04-28
**Scope:** Production-grade design for the three sub-systems that make Forge defensibly N=1: (1) Beads+Dolt persistence, (2) L1 locked rails, (3) `patch.md` self-heal. References: `layered-skeleton-config.md`, `v3-redesign-strategy.md`, `beads-operations-manifest.md`, `BEADS_GITHUB_SYNC.md`, `lib/workflow/stages.js`, `lib/runtime-health.js`, `lefthook.yml`, `.beads/metadata.json`, `.beads/export-state.json`.

---

## Sub-system 1 — Beads + Dolt as solo-value persistence

**Current data flow (verified):**
1. `bd create` writes to embedded Dolt DB (`.beads/embeddeddolt`) via `dolt_mode: server` (see `.beads/metadata.json`).
2. `forge sync` shells `bd dolt pull && bd dolt push` against a remote Dolt repo (Beads' own `forge` DB; see `dolt_database: forge`).
3. Pre-push hook `team-sync` (`scripts/forge-team/lib/hooks.sh sync --quiet || true`) syncs Beads state alongside `git push`.
4. Export state lives in `.beads/export-state.json` (`last_dolt_commit`, `issues:228`); used to short-circuit re-export.
5. CI reflows GitHub issues into Beads via `.github/beads-mapping.json` (see `BEADS_GITHUB_SYNC.md`); loop-prevention via mapping-file SHAs.

**Cross-session resume (5-min onboarding):**
```
git clone <repo>            # gets .beads/issues.jsonl + metadata.json
bunx forge setup            # installs bd, starts embeddeddolt server
forge sync                  # bd dolt pull → hydrates 228 issues
bd ready                    # shows next unblocked work
```
State source on fresh clone = `.beads/issues.jsonl` (rehydrated into Dolt on first `bd` call) + remote Dolt three-way merge for anything newer than the JSONL snapshot.

**Failure modes & remedies (codified in `lib/runtime-health.js` style):**
| Mode | Detection | Remedy |
|---|---|---|
| Dolt server crash | `.beads/dolt-server.pid` orphaned, port unbound | `forge sync` auto-respawns; PID file gates re-entry |
| Conflicting pushes (two machines) | Dolt three-way merge fails | `bd dolt merge --abort` → JSONL re-export → manual resolve |
| Schema evolution | `forge: N` version bump in metadata | `forge upgrade` runs migration; `.beads/backup/<hash>.darc` snapshot first |
| JSONL/Dolt drift | `export-state.json` last commit ≠ HEAD | Auto re-export on next `bd list` |
| Port exhaustion (CI) | dolt-server.port collides | Ephemeral port + `dolt-server.lock` file lock |

**Latency budget:** local `bd dolt push` ≈ 200–800 ms (LAN); remote ≈ 1–4 s. Acceptable for pre-push tail.

---

## Sub-system 2 — L1 locked rails (the kernel)

**The 5 rails (locked, cannot be disabled):**

| Rail | Enforcement point | Bypass surface | Audit entry |
|---|---|---|---|
| `tdd-gate` | `lefthook.yml` pre-commit `tdd-check` → `.forge/hooks/check-tdd.js` | `--force-skip-tdd` | `{rail:"tdd-gate",actor,reason,files,sha}` |
| `branch-protection` | pre-push `scripts/branch-protection.js` | `--force-skip-branch` | `{rail,branch,target,sha}` |
| `hard-gate-runtime` | `lib/workflow/stages.js` stage-exit gate | none (refuse-only) | `{rail,stage,evidence_missing}` |
| `classification-router` | `enforceStageEntry` + `WORKFLOW_STAGE_MATRIX` (`stages.js:42-201`) | none | `{rail,from,to,classification}` |
| `stage-entry-guard` | `lib/workflow/enforce-stage.js` (`STATELESS_ENTRY_STAGES`) | none | `{rail,stage,health}` |

**Locked-vs-lenient implementation:**
- `.forge/config.yaml` `core:` block is parsed read-only; any `core.<rail>.enabled: false` triggers AJV schema error before runtime sees it (schema lives at `forge-core/schema/config.schema.json`).
- `gates:` block accepts `enabled`/`threshold` only — no `core.*` keys allowed by schema.
- `--force` flags exist only on bypassable rails (1, 2). Setting them writes one NDJSON line to `.forge/audit.log` *before* the bypass executes (write-then-bypass; if the write fails, the bypass fails).

**Audit log spec (`.forge/audit.log`, NDJSON, append-only):**
```json
{"ts":"2026-04-28T10:11:12Z","actor":"user@befach.com","rail":"tdd-gate","action":"force-skip","reason":"emergency hotfix CVE-2026-X","sha":"abc123","files":["src/auth.ts"],"pid":4123,"forge_version":"3.0.1"}
```
Retention: rotated at 10 MB → `.forge/audit.log.<ts>`. Integrity: appended via `O_APPEND` only; SHA-256 chain field `prev_hash` per entry (cheap tamper-evidence — not crypto-signed in v3).

**Conformance test suite (5 example tests for the published L1 contract):**
1. `core.tdd-gate.enabled=false` in config.yaml → AJV throws `LOCKED_KEY_MUTATION`.
2. Push to `main` without override → `branch-protection.js` exits 1, no audit entry.
3. Push to `main` with `--force-skip-branch` → exit 0, exactly one new line in `.forge/audit.log`.
4. `assertTransitionAllowed('plan','ship')` for `standard` classification → throws `ILLEGAL_TRANSITION`.
5. Stage entry into `dev` with `enforceStageEntry` while no active worktree → throws `STAGE_ENTRY_BLOCKED`.

**Publication of the L1 contract:** `forge-core/RFC-001-L1-rails.md` + `forge-core/schema/*.json` (JSON Schema 2020-12) + a TypeScript `interface ForgeRails` exported from `forge-core/types.d.ts`. Other harnesses implement it by passing the conformance suite (`forge conformance run`).

---

## Sub-system 3 — `patch.md` hybrid F3 + self-heal

**Anchor block schema (finalized):**
```yaml
# .forge/patch.md — single index, auto-extract bodies > 40 lines
- id: stage.review.body            # anchor declared in default L2 block
  op: replace                      # one of: replace | append | prepend | wrap | delete
  target_sha: c3f1...              # SHA-256 of original block content
  target_path: lib/stages/review.js:120-180  # optional precise location
  applies_to: ">=3.0.0 <4.0.0"     # semver range of forge-core
  body: |
    # ... ≤40 lines inline, else @include patches/review-body.md
  reason: "team prefers blocking on Sonar smell count"
  recorded_at: 2026-04-28T10:00Z
  recorded_by: user@befach.com
```

**Three-way merge (self-heal pseudocode):**
```
for patch in patch.md:
  base   = lookup_default_block(patch.id, forge_core_version_at_record_time)
  theirs = lookup_default_block(patch.id, current_forge_core_version)   # upstream
  ours   = patch.body                                                   # team override
  if sha256(base) == sha256(theirs):           apply ours cleanly
  elif anchor_renamed(patch.id):                resolve via anchor_aliases.json → retry
  elif structural_diff(base, theirs) is trivial: 3-way diff3 merge → apply
  else:                                         conflict → write .forge/conflicts/<id>.md, refuse-with-hint
```

**Conflict taxonomy & action:**
| Conflict | Action |
|---|---|
| Anchor missing in current core | Look up `anchor_aliases.json`; if rename found, rewrite patch in place; else mark `orphan`, surface in `forge doctor` |
| Checksum drift, semantically same | diff3 merge; write `audit.log` entry `kind:auto-merge` |
| Semantic drift (target rewritten) | Refuse, write `.forge/conflicts/<id>.md` with both versions |
| Target file renamed | Resolve via `git log --follow`; auto-rewrite `target_path` |
| `applies_to` semver out of range | Mark patch `dormant`; do not apply; warn |

**Worked example — three patches against today's `lib/workflow/stages.js`:**
1. `stages.dev.tdd.subagent_count`: `replace` `3 → 5` parallel subagents.
2. `stages.review.greptile.threshold`: `replace` `4 → 3.5`.
3. `stages.validate.gates`: `append` a new `forge-stage-license-scan@1.0` block.

`forge patch record --from-diff` flow: edit file → diff captured → anchor inferred from nearest `<!-- forge:anchor -->` marker → SHA recorded → entry appended to `patch.md` → re-apply → `git diff` clean.

**Performance budget:** `forge upgrade` with 50 patches × 1000-file repo = O(N patches × M anchor lookups). Target ≤ 2 s wall (anchor index pre-built, ~20k files indexed at 5MB/s). Memory: anchor table cap 500 entries × 256 B ≈ 128 KB.

**Testing strategy:** golden-file (record→re-apply), property-based (`fast-check` over op × conflict × semver), fuzz-on-anchor-IDs only (low surface). Skip full fuzzing — patches are author-controlled, not adversarial.

---

## Cross-cutting deliverables

### Technical risk matrix (top 5 per sub-system)

| # | Sub-sys | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| 1 | Beads+Dolt | Dolt server orphan PID blocks startup | M | H | PID liveness probe + auto-respawn in `forge sync` |
| 2 | Beads+Dolt | Cross-machine merge conflict on `issues.jsonl` | M | M | Three-way merge in Dolt + JSONL as source of truth |
| 3 | Beads+Dolt | Schema migration corrupts 228-issue history | L | H | `.beads/backup/*.darc` snapshot before migration |
| 4 | Beads+Dolt | CI without `bd` binary breaks GH→Beads sync | M | M | SHA-pinned `bd` install action |
| 5 | Beads+Dolt | Dolt push >5 s on slow networks blocks pre-push | M | M | Async non-blocking team-sync (`|| true` already in `lefthook.yml`) |
| 6 | L1 rails | Audit log tampering | L | H | `prev_hash` SHA-chain + permissions 0600 |
| 7 | L1 rails | Schema additions break existing v2 configs | M | M | Versioned schema; `forge upgrade` migrates |
| 8 | L1 rails | `--force-skip-*` becomes routine | M | H | Surface in PR template + Sonar alert at >2/week |
| 9 | L1 rails | Conformance suite drifts from runtime | M | M | Single source: tests *are* the contract |
| 10 | L1 rails | Cross-platform shell quirks bypass tdd-gate | M | M | Already enforced via `lib/runtime-health.js` Git Bash gate |
| 11 | patch.md | Anchor renamed silently → patches orphan | H | H | `anchor_aliases.json` + `forge doctor` warning |
| 12 | patch.md | Diff3 merge produces invalid syntax | M | H | Post-merge AST parse; reject if invalid |
| 13 | patch.md | 50+ patches accumulate, review burden | M | M | Auto-extract >40 LOC + `forge patch dedupe` |
| 14 | patch.md | `target_sha` mismatch on every upgrade | H | M | Refuse-with-hint, document re-record flow |
| 15 | patch.md | User edits `patch.md` by hand, breaks schema | M | M | AJV validate on every load; pre-commit lint |

### Three open decisions (data needed to lock)

1. **Audit log signing in v3?** Need: bench cost of HMAC-SHA256 per entry (target <1 ms). Decide: signed vs SHA-chain only.
2. **Beads remote: self-hosted Dolt vs DoltHub?** Need: 30-day uptime stats from one Dolt deployment + cost model. Decide: bundle hosted or BYO.
3. **Anchor declaration: explicit `<!-- forge:anchor X -->` markers vs heuristic AST detection?** Need: prototype both on `lib/workflow/stages.js`; measure false-positive rate. Decide: marker-based (explicit) vs hybrid.

### Estimated code volume (LOC ballpark)

| Sub-system | New | Modified | Tests |
|---|---|---|---|
| Beads+Dolt adapter hardening | 400 | 200 | 600 |
| L1 rails (`forge-core/`) | 1,200 | 300 | 1,500 |
| patch.md self-heal | 1,500 | 100 | 1,800 |
| **Total** | **3,100** | **600** | **3,900** |

### Recommended implementation order

**Order: L1 rails → Beads+Dolt hardening → patch.md.**
Rationale: L1 is the kernel — every other sub-system writes audit entries and depends on the schema. Beads+Dolt next because patch.md self-heal needs Beads to file orphan-anchor follow-ups. patch.md last because it depends on stable anchors in L2 default blocks, which only exist after L1 carve-out.

### Five benchmarks (lock the design only after these pass)

1. **B1**: `forge upgrade` with 50 patches on 1000-file repo. Target: <2 s, <50 MB RSS.
2. **B2**: `bd dolt push` cross-region (US↔EU). Target: p95 < 4 s.
3. **B3**: 1,000-iteration fuzz of `assertTransitionAllowed` over all 6 classifications × all stage pairs. Target: zero panics.
4. **B4**: Audit-log append under 100-concurrent-process write. Target: zero corruption, `prev_hash` chain intact.
5. **B5**: Cold-clone time-to-`bd ready` on a 228-issue repo. Target: <90 s including `bunx forge setup`.

### Kill criteria (drop sub-system from v3 if…)

- **Beads+Dolt**: B2 p95 > 8 s after optimization → drop hosted Dolt, fall back to JSONL+git-only.
- **L1 rails**: Conformance suite cannot be implemented by a second harness in 1 week → publish contract as docs-only, not enforcement.
- **patch.md**: B1 > 10 s OR conflict rate > 30 % across 5 real upgrades → ship patches as full file overrides instead of anchor-merge.

### Showcase demos (proof-of-life per sub-system)

1. **Beads+Dolt**: Two machines, simultaneous `bd update` on different issues → `forge sync` on both → both states converge in <10 s with no manual merge.
2. **L1 rails**: Live attempt to set `core.tdd-gate.enabled: false` → schema error; live `--force-skip-tdd` → audit entry visible in PR template within 2 s.
3. **patch.md**: Record a 3-patch override on `stages.js`; bump `forge-core` minor version (anchor-renamed scenario); run `forge upgrade`; show 2 patches auto-merged + 1 conflict surfaced with diff.

---

**Word count:** ~990
