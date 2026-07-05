# Forge Efficiency & Extensibility Strategy

Status: strategy / roadmap (research-backed, no code yet). Date: 2026-07-05.
Sources: two multi-agent research passes — skill optimization (`wfk5kakct`) and
whole-harness token efficiency + self-improvement (`w53k989g7`) — grounded in
forge's actual code and tools, plus verified external constraints.

---

## 0. North star & the balance

**Spend generously to get the work RIGHT; save aggressively on plumbing that adds
no value.** The goal is *better work at net-neutral-or-lower token cost* — not a
cheaper-but-worse agent. Context-rot research is the tailwind: less-but-right
context *raises* correctness, so cutting plumbing tokens improves the actual work,
not just the bill. Correctness is the primary axis; tokens are the tiebreaker.

Three governing constraints on every recommendation below:

1. **Agent- AND platform-agnostic.** Forge serves Claude, Codex, Cursor, and Hermes —
   not just Claude — and runs on **every platform its users are on: Linux, WSL,
   Ubuntu, macOS, Windows** — not just Windows. Every mechanism (script, verb, memory,
   skill field) must work across *both* axes: any agent × any OS. A user must be able
   to move between agents/machines and have the memory "pick up" so the experience is
   continuous. Design from the *union* of the agent specs, not Anthropic's alone.
   **Direct consequence:** prefer portable **`forge` verbs (Bun/Node, cross-platform)
   over bash `.sh` scripts** (bash is not guaranteed on Windows), and prefer a
   kernel-native **`forge recall`** over the Unix-only `ctx` binary — the earlier
   Windows-only framing of that finding was too narrow; the real bar is *all five
   platforms*.
2. **Hammer & shovel (deepening).** Give users editable canonical sources +
   toggles, not a fixed ladder — and deepen that forkability layer-on-layer so
   they can change *anything*. See §4.
3. **Easy, not overwhelming.** Power must not become a maze. Safe defaults ON,
   one-step setup, presets over raw config, toggles over YAML. The **setup
   experience** is a first-class deliverable, not an afterthought (§4).

---

## 0.5 Load-bearing corrections (Fable planning review)

A planning-review pass sharpened five things; they override the first-draft framing
where they conflict:

1. **Agent-agnosticism must be DONE by a pillar, not just stated.** The draft's
   enforcement is all Claude-only (PreToolUse hooks in P3/P4, the `context-mode` MCP,
   the `ctx_stats` ledger) — on Codex/Cursor/Hermes those degrade to prose in
   AGENTS.md that agents ignore under pressure, and "memory picks up across agents"
   silently assumes every host has `ctx` configured. **The cross-agent enforcement
   mechanism IS P2:** make the cheap path the *only* path — deterministic `forge`
   verbs with STATUS envelopes that every agent calls the same way — instead of
   advice + hooks. Add (a) a **host compatibility matrix** (what each of Claude/Codex/
   Cursor/Hermes actually enforces: description caps, allowed frontmatter, hooks, MCP)
   and (b) a **CI test that every per-host mirror actually parses/loads** on its host.
   The portability guard is a **test, not a concept**.
2. **Sequencing fix:** ship the **context-cost CI gate (A#3) before/with the
   description trim (A#1)** — otherwise the trim regresses on the next skill edit
   (#292 already proved descriptions drift upward). Verify *which* hosts truncate the
   over-cap descriptions today and record it. **`forge context` (B#5, retiring the 28
   `beads-context.sh` shell-outs + fallback forks) is the single highest-leverage item
   in the whole doc — every session pays that tax; do not let it slip behind the
   router (B#7).**
3. **Don't build (yet):** (a) the P5 **bounded-library manager / auto-retire /
   activation-count machinery is governance for a library that doesn't exist** — ship
   DETECT as an end-of-session **human-readable digest of proposed assets** first;
   build the manager only once proposals prove good and the library exceeds ~15
   assets. (b) **Cut the memory-first PreToolUse gate** (latency + false hits +
   Claude-only) — make "memory first" a line in the router table instead. (c) The
   8–20k token budget is arbitrary — **measure, don't enforce**. (d) **Don't design a
   preset taxonomy upfront** — ship toggles, derive presets from observed usage.
4. **Missing (must add):** (a) **Fork/update (eject) semantics** — once a user forks a
   canonical skill, how do upstream forge updates merge back? Unaddressed, this kills
   "hammer and shovel". (b) **Discoverability** — a `forge customize` / `forge explain`
   entry point so users learn what's forkable. (c) **Global/local mechanics** need
   explicit **shadowing (local overrides global)**, **per-project disable of a global
   asset**, and **sync semantics when a global asset updates**. (d) P5 needs
   **rollback/attribution** (trace a bad run to the asset that caused it) and an
   **install rate limit**.
5. **Autonomy line = blast-radius × reversibility** (supersedes the looser P5 text):
   *auto-install* only project-local memory notes + read-only locator scripts;
   *propose-only* for skills, verbs, any hook rule, and anything global; *never auto*
   for BLOCK rules or edits to user-authored assets. **Anti-rot for the global
   library: the miner never writes global directly — promotion is EARNED, requiring
   evidence from ≥2 projects or repeated activations**, plus a zero-activation-in-30-
   days auto-flag with human-confirmed retirement.

## 1. Where forge already is (so we build, not rebuild)

Forge already owns ~80% of the substrate: the `context-mode` MCP as a sandbox
firewall (raw bytes stay out of context), the SQLite kernel with durable gate
events, canonical `skills/` + per-skill `evals/` with progressive disclosure, a
file-backed auto-memory, and hookify-style guardrails. **The gaps are
orchestration, not infrastructure.** Two levers do most of the work: a *retrieval
router* (cheapest correct tool for plumbing) and a *self-improvement loop* (each
struggle makes the next run cheaper).

---

## 1.5 Cross-platform readiness (audited + verified 2026-07-05)

Verdict: **substantially there, but verified-yet-not-enforced.** The core is genuinely
portable (`os.tmpdir()`+mkdtemp, `path.join`/win32/posix, `where.exe`-vs-`which` with
CRLF-safe splitting, junction-vs-symlink fallback, `chmod` guarded on win32, arg-array
`execFile`), and CI **already runs a full 3-OS matrix** — `test.yml` runs `bun test` on
ubuntu+macos+windows × Node 22/24 (`test.yml:47`). The earlier "CI is Linux-only" read
was a scouting error; cross-platform is *run*, not theoretical.

**Keystone gap (verified via `gh api …/branches/master/protection` + rulesets):** the
cross-OS matrix RUNS but does not GATE. The only required status checks on master are
**CodeQL + ESLint**; Full Matrix / Windows Smoke / macOS Smoke are **not** required and
no ruleset adds them — so a red Windows or macOS run would not block a merge at the
GitHub level. (This session's merges stayed safe only because the settle-merge watcher
independently gated on *all* checks — enforcement lives in a person/tool, not the repo.)

Fixes (ranked):
1. **[keystone · low]** Make a stable cross-OS aggregate (`needs: [windows-smoke,
   macos-smoke]`) a REQUIRED status check on master, and fix the name drift in
   `required-checks-bypass.yml` ("Test Suite" has no matching job; "Test Dashboard" vs
   the real "Test Dashboard (PR)"). Converts the passing matrix into a durable guarantee.
   Stage: Windows blocking now (highest-risk for this bash-heavy tool), macOS
   non-blocking for ~1 week flake burn-in.
2. **[medium] Windows Git Bash resolution mismatch** — `runtime-health.js` detects bash
   from 3 hardcoded absolute paths while `pr-state-adapter.js:184` invokes a BARE `bash`
   off PATH; a default Git-for-Windows install has git on PATH but not `bash.exe` →
   health-green then ENOENT at runtime. Add one `resolveGitBash()` (hardcoded → `where.exe
   bash` → `git --exec-path` → scoop) and invoke its absolute path everywhere.
3. **[medium] Skill inline-shell on the hot path** — default-branch detection uses
   `$(...) | sed/grep/awk` in status/ship/validate SKILL.md; if the agent runs PowerShell
   directly (not routed through Git Bash) it fails on the first stage of a normal run.
   Route it through a portable `forge` verb (e.g. `forge default-branch`) or guarantee the
   git-bash shell for helper flows.

Also cheap: add the fixtures step to the smoke lanes (so path/skills-sync regressions show
up in the gating lane), and gate the heavy 6-way `full-matrix` behind `if: github.event_
name != 'pull_request'` so it certifies on push/schedule while smoke gates every PR.

## 2. The seven pillars

### P1 — Skill token economy (progressive disclosure)

The only permanent per-skill cost is the **description**, which loads into every
session. Two verified facts:

- **The 1024-char description cap is real** (Anthropic Agent Skills spec,
  corroborated by the official docs, skill-creator, and superpowers best-practices).
  **17 of 19 forge descriptions currently exceed it** (hermes-forge 1737, research
  1628, sonarcloud-analysis 1598 are worst). The recent optimization pass traded
  char-budget for discrimination; we now tighten prose while keeping the "use X
  not this" routing. *Correction to the research's framing:* forge itself has **no
  matcher truncation** — the only `truncate()` is cosmetic (`skills list` table
  display). The risk is downstream **host runtimes** that enforce the 1024 cap, so
  this must be fixed for the multi-agent target, not just Claude.
- **Bodies:** only 2/19 skills use `references/`, while rollback (736 lines), plan
  (604), and review (494) blow the ~500-line body budget that loads on every
  trigger. Split them: SKILL.md becomes a table-of-contents; detail moves to
  `references/*.md` loaded on demand.

**Super-skill / sub-skill progressive loading** is the same idea across a
hierarchy: `smith` (thin orchestrator) already pulls in stage sub-skills only as
the work demands; deepen this so depth reveals step-by-step (references + sub-skill
composition) — full capability, no upfront context cost.

### P2 — Execute-don't-reason substrate

The pattern half-exists but is scattered at repo-root and partly legacy. `beads-
context.sh` is shelled out **28×** across 5 skills (each wrapped in a defensive
`if [ -f … ] else forge …` fork), `dep-guard` 15×, `pr-coordinator` 8×, `greptile-
resolve` 9× — and **no skill bundles its own `scripts/`** even though the loader
already mirrors subdirs recursively. Make deterministic multi-step logic
*executable*, not re-derived:

- **Retire `beads-context.sh` → a kernel-native `forge context` / `forge stage-
  transition` verb**, and delete the fallback forks (biggest single re-derivation +
  Beads-era liability).
- **Bundle per-skill `scripts/`** for skill-local helpers (greptile-resolve→review,
  pr-coordinator→ship, dep-guard→plan, smart-status→status, conflict-detect→plan/
  status). SKILL.md says *"Run `scripts/x`"*, never narrates the steps; the script
  source never enters context.
- **Promote reused (2+ skill/agent) helpers to first-class `forge` verbs** (`forge
  dep-guard`, `forge pr coordinate`, `forge review threads`, `forge conflict-detect`).
  `run forge pr-coordinate` is agent-agnostic; `run scripts/pr-coordinator.sh`
  assumes bash + repo layout. This is the north-star "push capability into the
  substrate" made concrete — Codex/Cursor/Hermes inherit one implementation.
- **Every bundled script emits a machine-readable STATUS envelope + exit code** so
  the agent reacts to a verdict, not re-reasons over verbose logs.

### P3 — Efficient repo interaction (the retrieval router)

Make the cheapest correct tool the *default* for plumbing so repo search, symbol
lookup, and big command output never enter reasoning context. The decision table
(codify in AGENTS.md + optionally a PreToolUse hook):

| Situation | Do | Instead of |
|---|---|---|
| Fact/location/procedure seen before | `ctx_search` memory FIRST | grep / re-derive |
| Symbol: where defined / callers / rename-safe | **LSP** go-to-def/find-refs, and **trust it** | grep + open every hit |
| Exact literal / TODO / config key | ripgrep (Grep) | semantic/embedding search |
| Read to **analyze** | sandbox `ctx_execute_file`, return summary | read whole file into context |
| Read to **edit** one region | read only that span (offset/limit) | read whole file "for context" |
| Command output >~20 lines | `ctx_batch_execute`, batch cmds+queries | cat/tail raw into context |
| Open-ended multi-file hunt (>3 queries) | Explore subagent (cheap model), **don't peek** | read a dozen files yourself |
| Conceptual "where's the code that does X" | expand to intent sentence → Explore/semantic | raw 2-word semantic query |
| Long-horizon run | externalize state to kernel; compact every ~10–15 calls | keep whole trajectory resident |

Key rule: **no vector index over live forge code** (drift-prone, and for
<1M-line/high-churn repos the index crossover is never reached). Reserve FTS/ctx
indexing for *static external corpora* (docs, specs). The #1 anti-pattern to ban:
re-reading files to "confirm" an LSP result — it erases the 30–84% saving.

### P4 — Memory / tool balance

Route each question to the cheapest tool that answers it — **memory → grep → LSP →
Explore → semantic → RAG** — as a line in the retrieval-router table (P3), *not* a
separate Claude-only PreToolUse hook. Enforce a **persist-vs-re-derive test**:
persist durable decisions/rationale, prefs, gotchas, stable IDs — REFUSE volatile
state (copying code or live state into memory/index guarantees drift).

**Two Luca tools, kept distinct (verified):**

- **`context-mode` plugin = context-window PROTECTION** — sandbox execution + FTS5
  index that keep raw bytes out of context. Already active and measured (~694K
  tokens saved / 2.1× in a single long session; 9-agent configs incl. Claude/Codex/
  Cursor/Gemini/OpenCode — **not Hermes**). Keep it as the always-on efficiency
  layer; this is proven value, not a plan.
- **`ctx`/`ctxrs` (Luca King) = the cross-agent HISTORY-RECALL layer** — a Rust CLI
  (not yet adopted) that indexes your *existing* local agent history (Claude/Codex/
  Cursor logs) into normalized SQLite (`ctx_sessions`/`ctx_events`/touched-files +
  FTS), searchable via `ctx search`/`ctx sql`, returning ranked cited snippets **~50×
  cheaper than raw transcript search (917 vs 45,734 tokens)**. Local-first, no cloud,
  no API keys, doesn't touch repos. Distinct from the `context-mode` protection plugin.
  **Best fit in forge:** (a) the retrieval-router's history-first step — `ctx search`
  before re-deriving or re-searching (don't repeat a prior failed attempt); (b) the
  self-improvement loop's **DETECT** stage (P5) — `ctx sql`/`ctx search` over sessions/
  events *is* the cross-agent friction-miner, so we don't hand-build a transcript
  scanner. **Blocker found (2026-07-05, verified from the installer):** ctx's prebuilt
  binary is **Unix-only** — the installer supports linux-x64 / macos-arm64 / macos-x64
  / freebsd-x64 and hard-fails "unsupported platform" on Windows; there are no GitHub
  release binaries and no Windows target, so on Windows it is cargo-build-from-source
  only (needs the Rust toolchain, absent here). Since the user is on Windows and forge
  is cross-platform + agent-agnostic, **"adopt ctx as-is" would strand Windows users**,
  so the recommendation **flips to the roadmap's "ctx-inspired, kernel-native" option**:
  reimplement the small high-value slice (normalize agent-session history -> SQLite FTS
  -> cited-snippet search + sql) as a **portable `forge recall` / `forge history` verb**
  that runs everywhere, with the **kernel as the durable git-synced cross-DEVICE store**;
  durable learnings get *promoted* into kernel memory. Adopt ctx as-is only where the
  host is Unix (a convenience, not the substrate). We copy the 50x-cheaper-than-raw-
  search *design*; we do not depend on the Unix-only *binary*.
  **Spike validated (2026-07-05, real data):** a cross-platform Node proxy over this
  project's actual history (179MB / 26 sessions / 74k events) showed raw search
  returns 1–17M tokens per common query (exceeds any context window and grows
  unbounded with history), while ranked cited-snippet recall is a **fixed ~600-token
  payload** — a realistic ~17x saving here (ctx's published apples-to-apples is ~50x),
  same order of magnitude either way. Recall's payload does NOT grow with history size;
  that is the core win. The proxy ran in Node → the kernel-native `forge recall`
  approach is portable to all five target OSes where the ctx binary is not.

  **DECISION (recorded 2026-07-05) — build-by-corpus, adopt-ctx-opportunistically.**
  ctx and `forge recall` index DIFFERENT corpora, so they are not "the same tool twice":
  ctx = local per-agent *transcript* history (one machine); `forge recall` = the durable,
  git-synced *kernel* memory (decisions / events / work-folders — all devices + all
  agents). Therefore:
  - **Do NOT build a ctx clone** (a general cross-agent transcript search). For the
    transcript / DETECT slice, wire ctx as an **optional adapter** — use it if installed
    (any OS), fall back to a built-in miner otherwise (hammer-and-shovel: use the best
    tool when present, degrade gracefully).
  - **DO build the thin `forge recall`** over the kernel corpus — kernel-native, zero-
    install, portable to all five OSes, and covering **Hermes** (which ctx never will).
  This decision is **robust to ctx's Windows timeline**: even if ctx goes cross-platform
  it still won't index the git-synced kernel memory or reach Hermes, so the thin forge-
  native slice remains warranted; and if ctx later covers transcripts everywhere, the
  optional adapter simply lights up — we lose nothing either way. Caveats: ctx covers Claude/Codex/Cursor (Hermes unverified — the §0.5
  coverage gate applies), and it preserves secret-shaped strings in transcripts, so
  scrub before any output leaves the machine.

**Cross-agent memory must NOT live in a per-agent store.** The `~/.claude/context-
mode` DB is Claude-only; leaning on it for "memory that picks up across agents" fails
the north star. Per the locked roadmap decision (L4b): **cross-agent memory lives in
the agent-agnostic KERNEL** (git-synced via export↔hydrate; it already holds events/
interactions/comments + migrated memory records), with **ctx as the recall/query
layer over it** for agents + the front-end. Lean: **kernel-native store + ctx-inspired
recall (no hard external dep)**; sequenced downstream (P3, needs the memory→git
bridge). Coverage caveat: whatever recall layer we adopt must reach *every* target
agent (Hermes included), or it silently becomes a Claude/Codex-only feature — which
is exactly the agent-agnostic trap §0.5 warns about.

### P5 — The self-improving loop (friction → codify → gate → install)

Turn each repeated mistake/search/re-derivation into a cheap future hit:

- **DETECT** — an end-of-session friction-miner (read-only Explore subagent, cheap
  model) scans transcript + `ctx` logs + kernel events for signals: identical
  repeated tool errors, retrieval thrash, re-reads/re-fetches, token/step spikes,
  backtracking, explicit user corrections, low `ctx_stats` savings, gate rejections.
- **CODIFY by asset TYPE** (never default-to-skill): repeated search/over-read → a
  memory note or tiny locator script; repeated multi-step logic → a bundled script
  or `forge` verb; a recurring *mistake* → a hookify guardrail; a missing
  capability → a skill.
- **VALIDATE (the gate — highest leverage).** Build the eval BEFORE the asset,
  baseline the friction cases without it, require a held-out improvement. Skill-
  writing *without* a gate measured no better than no skills at all (40% vs 88.8%
  in GRASP). Trust the gate, not the writer (auto-reflections confabulate).
- **INSTALL into a BOUNDED library** — at capacity, ADD is blocked unless paired
  with REMOVE/MERGE; attach provenance + activation count + last eval-delta; auto-
  retire assets that don't pay their load cost (net-token ledger). Require human/
  agent confirmation before any hookify BLOCK rule (a wrong block halts valid work).

**Scope routing — global vs project (a second routing axis, decided at CODIFY).**
Forge runs many projects from one desktop, so every codified asset must also be
scoped, not just typed:

- **Global (user-level, reusable everywhere)** — a general technique, a cross-cutting
  gotcha, a portable `forge` verb, or a workflow habit that would help in *any*
  repo. Promote it to the global library/memory so future projects inherit it.
- **Project-local** — anything tied to *this* repo's stack, conventions, file layout,
  domain, or one-off quirks. It stays in the project and never pollutes the global
  surface.

The decision test: *"Would this help a different project of the same user?"* If yes
and it carries no project-specific assumptions → global; if it references this repo's
paths/APIs/domain → local. When uncertain, default **local** (promotion is cheap and
reversible; a wrong global asset adds noise to every project). This mirrors what
already exists — global `CLAUDE.md`/`AGENTS.md` + user memory vs per-project
`.forge/`, skills, and project memory — and makes the promotion path explicit and
governed. The friction-miner tags each candidate with a proposed scope; promotion to
global is a gated step (higher bar than a local install) so the global library stays
small, high-signal, and portable across agents.

### P6 — Measurement & governance

- **Upgrade evals from trigger-accuracy → a GRASP-style acceptance gate** scored on
  *correctness-at-a-token-budget* with a hard regression budget. Today `evals.json`
  holds only `{query, should_trigger}`; add a held-out probe of previously-failing/
  passing cases. This gate is what makes P5 safe and what protects P1's manual work.
- **Context-cost CI gate**: fail when a SKILL.md body >500 lines or a description
  >1024 chars; print a per-skill line/token estimate so cost is visible at review.
- **Net-token ledger + per-task effective-token budget** (target ~8–20k): record
  `ctx_stats` bytes-into-context and savings ratio; attribute each installed asset's
  savings against its always-on cost. Correctness stays primary; never reward
  terse-but-wrong.

### P7 — Extensibility & experience (cross-cutting)

Every mechanism above must be **forkable** and **easy**, layered so a user meets
only as much power as they want:

- **Layer 0 — Presets.** Safe defaults ON; named presets (e.g. "lean/CI-gated",
  "standard", "high-oversight"; "professional" vs "casual"). One choice, done.
- **Layer 1 — Toggles.** `forge gate enable|disable`, per-skill on/off, model
  routing — flip a switch, not edit YAML.
- **Layer 2 — Config.** `.forge/config.yaml` for roles/ideology/onPass knobs.
- **Layer 3 — Editable canonical sources.** `skills/`, bundled `scripts/`, gates —
  fork the hammer itself.
- **Layer 4 — New verbs/skills.** Author a `forge` verb or a skill; the self-
  improvement loop (P5) can *propose* these automatically.

**Setup experience** (first-class): interview → pick agent(s) → pick a preset →
done, with advanced knobs revealed progressively (never front-loaded). A
**portability guard** separates open-standard skill fields from host-specific
extensions (`context:fork`, `disable-model-invocation`, `model`, `${CLAUDE_SKILL_
DIR}`) so `.codex`/`.cursor`/`.hermes` mirrors stay valid — the same skill degrades
gracefully across agents rather than breaking.

---

## 3. Prioritized roadmap (impact / effort)

**Phase A — cheap, always-on wins (do first):**
1. **Trim the 17 over-cap descriptions to ≤1024** (what+trigger first), gated by the
   eval loop so trimming can't hurt triggering. *Fixes a real issue in the just-
   shipped #292.*
2. Split rollback/plan/review bodies into `references/` (TOC style).
3. Context-cost CI gate (body ≤500 lines, desc ≤1024). LSP-first + "trust the LSP,
   don't re-read" clause in AGENTS.md. Explore-subagent output contract + "don't peek".
4. Quick wins: `allowed-tools` on hermes-forge/parallel-deep-research; `disable-
   model-invocation` on rollback; document/park non-standard frontmatter keys.

**Phase B — substrate (medium):**
5. `forge context` verb → retire `beads-context.sh` + delete fallback forks.
6. Bundle per-skill `scripts/` with STATUS envelopes; promote 2+-skill helpers to
   `forge` verbs. Single source of truth (avoid repo-root + bundled drift).
7. Retrieval-router skill + memory-first PreToolUse gate.

**Phase C — self-improvement (higher effort, highest ceiling):**
8. GRASP-style acceptance evals + net-token ledger.
9. Friction-miner → codify-router → eval-gate → bounded-install pipeline (kernel-
   backed), with a bounded-library manager (cap + paired REMOVE/MERGE + provenance).

Each phase is independently shippable and leaves forge better; nothing here is
big-bang.

---

## 4. Risks & mitigations (carried from both research passes)

- **Trimming descriptions can lower trigger accuracy** → gate every rewrite through
  the eval loop; never ship a trim that drops a `should_trigger` case.
- **Two copies of a script (repo-root + bundled) drift** → pick one source of truth
  before bundling; generate the other.
- **Host-only frontmatter breaks non-Claude mirrors** → portability guard (P7).
- **Bad auto-generated assets** (confabulated memory, overfit reflection, wrong
  BLOCK rule) → the gate is mandatory; human confirm for BLOCK rules; bounded library.
- **LSP savings evaporate if the agent re-reads to confirm** → ban the re-read
  anti-pattern explicitly.
- **Windows/bash assumption** → bundled `.sh` needs guaranteed Git Bash per agent
  target, or ship the logic as a `forge` verb (portable) instead.
- **Retiring `beads-context.sh` must not orphan a still-live path** — a Beads plugin
  may still be present; sequence the verb + fallback-removal carefully.
- **Router/miner add moving parts** → run the miner out-of-band (end-of-session,
  cheap model); keep the router a thin decision table, not a heavy service.

---

## 5. Open decisions for the user

1. **Sequencing:** ship Phase A now (it fixes the #292 descriptions), or bundle A+B?
2. **Substrate vs bundle:** for hot helpers, prefer new `forge` verbs (portable,
   slower — needs a release) or bundled `scripts/` (faster, bash-bound)? Recommend:
   verbs for 2+-agent helpers, bundled scripts for skill-local ones.
3. **Self-improvement autonomy (P5):** how much can the loop install without a human
   OK — auto-install memory notes, but human-gate skills/hooks? (Recommended.)
4. **Preset taxonomy (P7):** which named presets ship by default?
