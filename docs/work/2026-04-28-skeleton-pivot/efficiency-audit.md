# Forge v3 — Efficiency Audit (cut effort 2-10x)

**Source evidence:** `locked-decisions.md` (D1-D20), `v3-redesign-strategy.md`, `n1-moat-technical-deep-dive.md`, `reality-check-audit.md`, `scripts/sync-commands.js:201-249`, `lib/workflow/{stages,enforce-stage}.js`, `lib/runtime-health.js`, `lib/project-memory.js`, `.beads/embeddeddolt/`, `lib/greptile-match.js`.

---

## TOP 10 EFFICIENCY WINS (ranked by saved-effort × likelihood-of-cutting)

| # | Win | Saved | Confidence |
|---|---|---|---|
| 1 | **Defer Wave 2-4 entirely; ship N1-moat-only v3.0** (N1/N2/N3/N4/N11/N13). Reality-check confirms marketplace, 5-resolvers, multi-target translator, and agentskills.io adapter are N>1 infrastructure. | **~7-8w** (14.5w to 6-7w solo) | High |
| 2 | **patch.md self-heal: shell out to `git merge-file -p` + diff3.** N1 deep-dive's pseudocode literally describes diff3; `git merge-file` is on PATH. Replace merge engine with a spawn call + conflict-file write. Conflict taxonomy table shows only "anchor renamed" needs custom handling (alias map lookup) — diff3 covers the rest. | **3-5d** | High |
| 3 | **Translator: extend `AGENT_ADAPTERS` (sync-commands.js:201), don't rewrite.** 8 adapters already exist; 6/8 are 1-line transforms. Add 2 emitters (Cursor `.mdc` frontmatter, OpenCode `opencode.json`) + golden fixtures. Reality-check called this 4-5w; reality is ~1w. | **3-4w** off N7+N10 | High |
| 4 | **Collapse three logs into one `.forge/log.jsonl` with `kind:` discriminator.** D17 audit + D19 agent + existing `.beads/interactions.jsonl` are all NDJSON append-only solo-user logs. One writer, one `prev_hash` chain, one redaction pipeline (reuse `lib/project-memory.js` redactor). | **2-3d x 3 sites = ~1w** | High |
| 5 | **N13 pattern detector: `jq | sort | uniq -c | head` against `lib/greptile-match.js` output.** Acceptance is "<30s, top 3, evidence trails" — that's `count desc`, not a clusterer. ~50 LOC bash + node wrapper. | **3-4d** | High |
| 6 | **Resolvers: ship `gh:` + `./local` only for v3.0.** Plan has 5 (gh/npm/https/gist/local). Marketplace is deferred to v2 per template-library doc; solo user only uses `gh:` + `./local`. Reduces N8 (L to S). | **~1w** | High |
| 7 | **Drop `forge-marketplace.json` allowlist from v3.0.** D1 builds JSON nobody reads at N=1. Template-library doc already classifies marketplace as "BONUS, only after one external user publishes." | **2-3d + ongoing maintenance** | Medium |
| 8 | **`forge migrate` = same code path as `forge sync`.** Both shell `bd dolt push/pull` against the same DB. Migration writes a default `.forge/config.yaml` once, then resumes normal sync. No separate command. | **2d** | Medium |
| 9 | **`forge insights` v0.5: just `forge log report` showing top-N tool sequences.** Skip recommendation system. User reads `.forge/log.jsonl` ranked output, decides themselves. | **3d** off N13 | Medium |
| 10 | **Schema validation IS the L1 rail enforcement.** Don't write a separate `lib/core/rails.js` enforcement layer. The schema validator at config-load time + the existing `enforce-stage.js` runtime check is enough. Two layers, not three. | **2-3d** | Medium |

---

## 5 PIECES OF PLANNED CODE THAT ALREADY EXIST

1. **patch.md three-way merge** -> `git merge-file -p base ours theirs` (in PATH).
2. **Audit log redaction** -> `lib/project-memory.js` already redacts emails/paths; reuse the same pipeline.
3. **Per-harness translator skeleton** -> `scripts/sync-commands.js:201` `AGENT_ADAPTERS` already dispatches to 8 targets; only 2 need real shape work.
4. **`forge insights` data extraction** -> `lib/greptile-match.js` already pulls Greptile categories from PR comments.
5. **Beads sync transport** -> `bd dolt pull && bd dolt push` already runs from `forge sync`; `forge migrate` doesn't need a new transport.

---

## 3 SYSTEMS THAT SHOULD MERGE INTO ONE

1. **`.forge/audit.log` (D17) + Agent log (D19) + `.beads/interactions.jsonl`** -> `.forge/log.jsonl` with `kind: audit|agent|interaction`. One append-writer, one rotation policy, one redactor, one `prev_hash` chain.
2. **Protected Path Manifest + schema validation + `lib/core/rails.js`** -> schema validation at load + `enforce-stage.js` at runtime. Schema IS the manifest.
3. **`forge sync` + `forge migrate` + `bd dolt push/pull`** -> one command, one code path. Migration is a one-time YAML write before the normal sync flow.

---

## THE BIG SIMPLIFICATION (whole thing in 1/3 the code)

**Ship "Forge v3-N1": N1/N2/N3/N4/N11/N13 only.** Defer N7/N8/N10/N12/N14/N16/N17 to v3.1 once an external user appears.

The N=1 moat is exactly four pieces: (a) Beads+Dolt persistence — **already shipped**; (b) one append-only `.forge/log.jsonl` — **~1 file**; (c) `patch.md` overrides via `git merge-file` — **~1 file + spec**; (d) `forge insights` PoC over existing `greptile-match.js` — **~50 LOC**.

Everything else (marketplace JSON, 5 resolver schemes, multi-target translator beyond the existing `AGENT_ADAPTERS`, agentskills.io adapter layer, `/forge map-codebase`) is N>1 infrastructure the user explicitly deprioritized.

**Plan delta:** **14.5w solo -> ~5-6w solo.** ~65% reduction. Wave 2-4 issues stay in Beads as `deferred-v3.1`, not deleted — they reactivate on first external adoption signal.

**Honest framing:** the user asked for "5-10x" cuts. Code-reuse wins alone deliver 30-40%. Hitting 5-10x requires deferring scope, not just refactoring — and the deferred scope is exactly what the N=1 framing already says is non-essential.
