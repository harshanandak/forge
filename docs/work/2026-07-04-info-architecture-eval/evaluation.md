# Information Architecture Evaluation — forge

Date: 2026-07-04
Scope: skill-testing, work-organization + kernel linkage, architecture-decision capture, OKF-friendliness — evaluated as one connected information system, not four islands.

## (a) The integrated picture — one pipeline, not four features

The four dimensions are a single information pipeline with the **kernel as the intended backbone**. The chain is: a Kernel **issue** spawns a **worktree**, the worktree owns a **work-folder** (`docs/work/YYYY-MM-DD-<slug>/` holding `plan.md` / `tasks.md` / `decisions.md` / `research/`), and the files inside are the grounded evidence. Per-work `decisions.md` entries **roll up** into the `docs/PROJECT_DESIGN.md` PD-registry, then get **grouped by component** into `docs/architecture/subsystems/<component>.md`, with the irreversible ones frozen as `docs/adr/`. Finally the whole documentation tree (plus memory) is **published** as an OKF bundle that agents navigate through an `AGENTS.md` nav block. The design intent: the kernel *records the linkage chain* (issue → worktree → work-folder → files) so every decision has queryable, grounded provenance, and OKF is the vendor-neutral read surface over it. **The reality is that every stage's engine/convention is built but the wiring between stages is not** — so today the linkage is filesystem-heuristic, the roll-up is a flat manual registry, publishing has never run, and skill verification has no data. The kernel — the piece that would make all of this queryable rather than guessed — is the least-built link.

## (b) Per-dimension: where we are + biggest gap

| Dimension | Planned | Built | Progress | Biggest gap |
|---|---|---|---|---|
| **Skill testing & eval** | Trigger evals (all skills) + behavioral command evals + LLM judge + CI gate | Full framework engine (`eval_win.py`, `run-command-eval.js`, `behavioral-judge.sh`, 5 lib modules, 10 CI unit tests). Data: **2 of 15** skills have trigger evals; **2 of 11** commands have behavioral sets | **22%** | Eval **data** is sparse — the engine runs but 13 skills / 9 commands have nothing to run. No CI-safe static "every skill has evals.json" check. |
| **Work org + kernel linkage** | Kernel records issue → worktree → work-folder → files | 90+ work-folders follow the convention on disk; `orientation.js` discovers them by heuristic. But `kernel_worktrees` is **schema-only (0 writes, always empty)**; `forge worktree create` creates no claim; no `work_folder` link; no machine-readable `issue_id` in folders | **18%** | The kernel **stores none of the linkage** — the backbone is a filesystem guess ("most-complete folder wins"), which breaks silently with parallel features. |
| **Architecture decision capture** | 3 tiers: work `decisions.md` → PD-registry → component `subsystems/*.md` → ADR | **60** `decisions.md` files; `PROJECT_DESIGN.md` with 20+ PD-entries (YAML + evidence back-links); governance specs written for `architecture/index.md`, `subsystems/README.md`, `adr/README.md` | **18%** | The component-grouped layer — the actual goal — has **0 content files**; **0 ADRs**; **no promotion mechanism** bridging 60 `decisions.md` into subsystems. |
| **OKF-friendliness** | `enable → generate → link` bundle + `AGENTS.md` nav; memory OKF-aligned | Complete tooling (`okf.js`, `okf-config.js`, `doc-gate.js` CLI). But **never activated**: no `.forge/doc-gate.json`, no `docs/kb/`, no nav block. Memory schema is non-OKF and lives outside git | **25%** | OKF has **never been run** — the tool is one command from a bundle, but there is no published KB and memory can't be included without a bridge. |

## (c) Integrated, prioritized progression plan

The layers must be built **bottom-up**: linkage backbone → roll-up content → verification → publish. Publishing last is deliberate — an OKF bundle is only worth generating once there is a wired-together, real architecture layer to publish.

**P0 — Kernel linkage backbone (unblocks all three downstream layers).**
1. `forge worktree create` INSERTs into `kernel_worktrees` (id, path, branch, git_common_dir, state) — zero schema change, gives a live registry. (`lib/commands/worktree.js`)
2. Add a `work_folder` column (migration) + write machine-readable `issue: beads-NNN` front-matter into each work-folder `README.md` via `/plan`; make `orientation.js` select the folder by `issue_id` instead of the most-complete heuristic. (`lib/kernel/schema.js`, `lib/orientation.js`, `skills/plan/SKILL.md`)
3. `/plan` creates a claim (`forge issue claim <id> --worktree <slug>`) so `kernel_claims.worktree_id` populates — closes issue → worktree.

**P1 — Seed the roll-up so an architecture layer exists to publish.**
4. Hand-seed `docs/architecture/subsystems/kernel.md` and `knowledge.md` from the existing PD-entries grouped by `topic:`; write the first ADR (`001-sqlite-local-authority.md`). Proves the pattern with no new tooling. (uses templates already in `subsystems/README.md`, `adr/README.md`)
5. Add a promotion-tag footer to the `decisions.md` template (`[local-only] | [promoted to PD-xxx] | [promoted to subsystems/xxx.md]`) so the roll-up gap is visible at close time; later back it with a `forge architecture check` script that surfaces unpromoted cross-cutting decisions.

**P2 — Verify the skills that drive the pipeline (do the highest-leverage ones first).**
6. Add trigger evals for the pipeline-critical skills first — `plan`, `dev`, `ship`, `validate`, `kernel` — then the rest; add a **CI-safe static test** asserting every `skills/*` has a non-empty `evals/evals.json` (file-existence + JSON parse, no API cost).
7. Add behavioral eval sets for `/plan` and `/ship` — the two commands that must write the kernel linkage (P0) and perform the roll-up (P1). Wire the existing `behavioral-judge.sh` rubric as the `/plan` grader.

**P3 — Publish (OKF) — the capstone.** Prerequisites: P1 content seeded (else the architecture layer publishes empty) and P0 `issue_id` front-matter (else bundle cross-links don't resolve).
8. Run `forge doc-gate okf enable / generate --source docs --out docs/kb / link`; commit bundle + `AGENTS.md` nav.
9. Add a `memory-to-OKF` projection (`name→title`, `metadata.type→type`) since memory lives outside git and isn't OKF-shaped; add `docs/reference/OKF.md`.
10. Wire OKF regen into the `/ship` pre-merge gate so the bundle stays current.

**Prerequisites for "publishing," explicitly:** (i) real content in the architecture layer — P1, currently 0 files; (ii) machine-readable `issue_id`/`work_folder` linkage so bundle cross-references resolve — P0; (iii) a memory bridge — memory is outside the git tree that OKF reads from; (iv) eval-gated doc-producing skills — P2 — so published content is trustworthy.

## (d) Already done — do NOT rebuild

- **Skill-eval engine is complete.** `eval_win.py`, `run-command-eval.js`, `behavioral-judge.sh`, 5 lib modules, and 10 CI unit tests already exist and pass. Only eval **data** is missing — this is data-entry, not engineering.
- **OKF tooling is complete and one command from a bundle.** `okf.js` generator, `okf-config.js` toggle, and the `forge doc-gate okf status|enable|generate|link` CLI are all built. Nobody needs to write a generator.
- **The roll-up registry already exists.** `PROJECT_DESIGN.md` holds 20+ PD-entries with YAML front-matter and `evidence:` back-links, plus **60** granular `decisions.md` files. The raw material for subsystem files is already written — P1 is regrouping, not authoring from scratch.
- **All governance scaffolding is written.** `docs/architecture/index.md` (taxonomy, record types, scope map), `subsystems/README.md` (per-file template), and `adr/README.md` (trigger rules + template) exist — only the content files are missing.
- **Partial kernel wiring exists.** `kernel_claims.worktree_id` column and its broker/driver write-path (`schema.js:134`, `broker.js:617`) are already there; P0 just needs to *trigger* them. `orientation.js` already discovers work-folders and injects `work_folder` into agent context.
- **Structural skill tests are green in CI** (`stage-skills.test.js`, `skills-structure.test.js`, `forge-skills-pack.test.js`) — frontmatter/naming/tool-declaration validation is done.
