# Forge v3 — Unconventional Alternatives (Out-of-the-Box Critical Research)

**Date**: 2026-04-29
**Status**: Critical research companion to locked-decisions.md
**Purpose**: Stress-test the v3 thesis with 10 deliberately unconventional reframings.

The locked plan (D1–D14) is internally consistent. This doc deliberately attacks
the framing assumptions to surface ideas worth stealing, sacred cows worth
questioning, and one bold alternative worth seriously considering.

---

## Alternative 1 — Forge for a Single Team (opposite of N=1)

**Description**: Reframe Forge as a multi-tenant, single-codebase product for
5–20 devs sharing one repo. Drop the "harness-agnostic, every-solo-dev"
framing. Instead: one team picks one harness (Claude Code), Forge runs as a
shared service at the repo level, audit log lives in Postgres, gates enforced
via a single team-managed daemon. Personal overlays (D5) become first-class;
solo use becomes a degenerate case of single-team-of-one.

**Cost vs current plan**: Smaller (kills 6-harness translator, kills marketplace,
kills L4 user profile sync). 4 weeks instead of 14.

**Kills**: D11 (6 harnesses), D12 (agentskills.io), D14 (translator work), most
of WS19 (profile), most of WS16 (marketplace).

**Adds**: Team server (auth, audit, gate daemon), repo-scoped extension install
(no marketplace needed), team policy console (Slack/PR webhook driven).

**Strategic risk**: Forge becomes a "pay-per-seat enterprise tool" not an
open-source agent harness. Different GTM, different community story, different
moat. But: this is where revenue actually lives.

**Moat change**: Yes — moves from "skill ecosystem" to "team policy lock-in."
Stickier per-team, weaker community flywheel.

---

## Alternative 2 — Forge as Pure Runtime Library (no CLI)

**Description**: Ship `forge-runtime` as an importable package:
`import {validate, audit, patch, classify} from 'forge-runtime'`. Each harness
calls these functions inside its own process. No `forge setup`, no
`.forge/config.yaml`, no `forge migrate`. The harness owns config; Forge owns
the algorithms. Skills live wherever the harness puts them.

**Cost vs plan**: Smaller (-40%). Kills CLI, install, marketplace client,
upgrade tooling, migrate command, snapshot/rollback.

**Kills**: D6 (migrate), D7 (snapshots), most of D1 (marketplace client),
WS21 (migrate workstream), WS17 (patch.md tooling).

**Adds**: Per-harness adapter packages (`@forge/claude-code-adapter`), library
versioning discipline, semver pain.

**Strategic risk**: Loses the "one tool, all harnesses" pitch. Each harness
maintainer has to integrate Forge — adoption now depends on their willingness.
Also: hard to audit if every harness embeds it differently.

**Moat change**: Weaker — the moat moves to library API design, which is
copy-able. But integration cost for harnesses goes from "weeks" to "hours."

---

## Alternative 3 — Agent Log on Dolt (not NDJSON)

**Description**: Beads already runs Dolt. Make the agent log a Dolt table:
`CREATE TABLE agent_events (ts, session_id, harness, event_type, payload JSON,
prev_hash, this_hash)`. Free SQL queries (`SELECT * WHERE harness='codex' AND
ts > now() - interval 7 day`), free versioning (every commit is a snapshot),
free cross-machine sync (Dolt push/pull already exists in Beads).

**Schema sketch**:
```sql
agent_events(id PK, session_id, ts, harness, stage, event, payload JSON, sha)
agent_sessions(session_id PK, started_at, ended_at, harness, repo, branch)
agent_skills_used(session_id, skill_id, ts) -- for the self-improvement loop
```

**Pros**: SQL beats `jq` for every analysis question. Cross-machine sync free.
Audit trail is git-native. Self-improvement queries become joins.

**Cons**: Dolt becomes a hard dependency on every install (currently optional).
NDJSON is cat-able from any tool; Dolt requires a binary. Schema migrations are
now a real concern. Potential write-throughput limits at high event rates.

**Moat change**: Stronger — pairs Forge tightly to Beads/Dolt stack which the
team already owns. Competitors copying NDJSON is trivial; copying a Dolt-backed
analytics surface is not.

---

## Alternative 4 — Forge as Server-Side Git Hook

**Description**: Forge runs only as `pre-receive` on the remote (GitHub Action
or self-hosted git server). No client install. No CLI. A push that violates
TDD/secret/classification rails is rejected server-side with a one-line hint.
The agent's local state doesn't matter — the gate is at the boundary.

**Simplest version**: A GitHub Action `forge-check@v3` that runs on
`pull_request`, reads `.forge/config.yaml` from the PR branch, and posts blocking
review comments on violations.

**Kills**: Everything client-side except `.forge/config.yaml`. No `forge setup`,
no marketplace, no harness translator, no patch.md merge engine.

**Strategic risk**: Loses the "shape the agent's behavior" pitch — agents can
still write garbage locally, they just can't push it. The self-improvement loop
has no hook. The skill ecosystem has no host.

**Moat change**: Weaker on lock-in (server hooks are commodity), but stronger
on "drop-in adoption" — any team can adopt without changing tooling.

**Verdict**: Bad as the *whole* product, great as a *fallback adoption tier*.
Anyone unwilling to install Forge client-side gets the server-side gate for
free.

---

## Alternative 5 — patch.md as Literal Git Patches

**Description**: Drop the anchor-ID + frontmatter format. `.forge/patches/`
holds `git format-patch` outputs. Replay = `git am`. Self-heal on upgrade =
`git rerere`. Conflict markers are real git conflict markers, which every
developer already knows how to read.

**What breaks**:
- Anchor stability across upgrades (D2 § 40-line auto-extract) becomes
  meaningless — patches are line-anchored, not symbol-anchored.
- Renaming a default skill breaks every patch that touches it (vs anchor-ID
  surviving).
- `forge options why <id>` (D8) becomes much harder — patches don't carry
  semantic IDs, just diffs.

**What's better**:
- Zero new format to learn.
- `git rerere` actually works at solving merge conflicts on repeat upgrades.
- Patches are commits — full git tooling available (`git log`, `git blame`,
  `git revert`).

**Net**: Trades semantic stability for tooling familiarity. Worth it if our
users are git-fluent (they are) and our default skills don't churn often (TBD).

**Moat change**: Weaker — anchor-ID was a defensibility play. Git patches are
universal.

---

## Alternative 6 — Self-Improvement on the Prompt, Not as Skills

**Description**: Skip SKILL.md generation entirely. Pattern detector finds
repeated sequences in the agent log and *appends rules* to AGENTS.md / CLAUDE.md
on the next session: "Last 3 sessions you re-read the same 4 files at start of
/dev. Cached file paths: [...]". No skill files, no skill management, no
distribution problem.

**Pros**: Zero ceremony. Cheaper to build (one detector + one appender vs full
SKILL.md pipeline). User just sees their own AGENTS.md grow with their patterns.
No "skill marketplace" question.

**Cons**: AGENTS.md grows unbounded. No way to share patterns across users (the
whole point of a skill ecosystem). Loses the agentskills.io interop story (D12).
Patterns specific to one project leak into agent behavior project-wide.

**Moat change**: Much weaker — no skill ecosystem to defend. But if the skill
ecosystem isn't actually defensible (free-to-copy SKILL.md files), this admits
that honestly and ships in 1/4 the time.

**Verdict**: Worth piloting as Phase 1 of WS18 before building the full
SKILL.md pipeline. If 70% of value comes from prompt-level rules, the SKILL.md
work is over-engineered.

---

## Alternative 7 — No L1 Rails, Pure Recommendations

**Description**: Forge doesn't enforce anything. It observes, scores, suggests.
The audit log is feedback, not a gate. "Refuse-with-hint" (D3) becomes
"warn-with-hint." Users self-select into compliance.

**Would users still find value?**: Solo users — yes (the workflow shape is
useful even without enforcement). Teams — no (the value of a gate is that you
can't bypass it). Enterprise — no (compliance demands enforcement).

**Pros**: Removes the "bypass tax" arms race. Removes the audit complexity for
`--force-skip`. Friendlier to first-time users. Lower install friction.

**Cons**: Removes the strongest moat — enforcement is harder to copy than
recommendations. Loses the "structural enforcement" pitch in CLAUDE.md.

**Moat change**: Much weaker. But: maybe the moat was never "we enforce
better" — maybe it's "we observe more comprehensively." If the audit log is
the moat, gates are decoration.

---

## Alternative 8 — AI-Generated Translator at Install Time

**Description**: Forge ships the meta-spec (manifest + skill format + handoff
schema). At `forge setup`, an LLM call (one-time, with caching) generates the
per-harness emit code from the manifest. Each harness adapter is ~200 lines of
LLM-generated TS. Updates to a harness format → regenerate.

**Pros**: D11/D14 (~2 weeks of translator engineering) becomes ~2 hours of LLM
work. Adding a 7th harness costs nothing. Drops 6-harness scope debate entirely.

**Cons**: Generated code quality is variable. Bugs in translator = silent skill
corruption across harnesses. Hard to debug when the generator's prompt changes.
Anthropic API dependency at install time.

**Strategic risk**: The "meta-spec is the product" framing is cleaner. But
shipping LLM-generated code as a load-bearing component during install is novel
and untested at scale.

**Moat change**: Stronger — meta-spec defensibility is higher than per-harness
adapter defensibility. Competitors copying 6 hand-written adapters is feasible;
copying a meta-spec that 6 adapters can be regenerated from is harder to fake.

---

## Alternative 9 — Sell the Agent Log, Not the Workflow

**Description**: Reposition Forge as "the standard observability layer for AI
coding agents." Workflow is a hook to capture the data. The product is the
log format, the analysis surface, and the ecosystem of tools that consume it
(eval, dashboards, fine-tuning datasets, compliance reports).

**What changes**: Marketing. Pricing. The feature tree. Analytics, replay, and
fine-tuning surfaces become the focus. The 7-stage workflow becomes "one
opinionated reference workflow that emits logs in our format."

**Pros**: Different competitive moat — log format adoption beats workflow
adoption. Forge becomes infrastructure, not a tool. Way more enterprise-friendly.
Naturally compatible with all harnesses (anyone can emit our format).

**Cons**: Day-one solo user gets less concrete value (an audit log doesn't help
them ship code). The workflow is what hooks people; without it, no on-ramp.

**Moat change**: Much stronger long-term. "Forge agent log" as a verb is
defensible; "Forge 7-stage workflow" is forkable.

**Verdict**: This is the *strongest* alternative framing on this page. Worth
serious consideration even if we don't fully pivot.

---

## Alternative 10 — 48-Hour Working v3 MVP

**Description**: Skip Wave 0 spikes. Aggressively scope a 48-hour MVP that
proves the v3 thesis with one harness, one skill, one extension, one rail.
Get user feedback before any Wave 1 work. The MVP-A 6-week plan is itself
over-cautious.

**Smallest demo**: 
1. `.forge/config.yaml` with one toggle.
2. `forge run /validate` reads it.
3. One L1 rail (TDD gate) enforced; refuse-with-hint emitted.
4. `forge audit log` shows the gate event.
5. One Claude Code adapter that emits SKILL.md.

That's the thesis. 48 hours.

**Pros**: Real user feedback in 2 days vs 6 weeks. De-risks the *concept*, not
just the migration. Forces brutal scope discipline. Burns far less budget if
the thesis is wrong.

**Cons**: Skips D10 (migrate PoC NO-GO gate). Brittle demo, not a product. Risk
of premature commitment to bad early choices.

**Moat change**: None directly. But faster validation = better choices = better
moat eventually.

---

# UNDER-800-WORDS SYNTHESIS

## TOP 5 IDEAS WORTH STEALING

1. **Server-side gate as adoption tier** (Alt 4). Even if the main product is
   client-side, ship a `forge-check` GitHub Action that runs the L1 rails on
   any repo with a `.forge/config.yaml`. Zero-install adoption funnel for teams
   not ready to install client-side.

2. **Agent log on Dolt** (Alt 3). Beads already ships Dolt. Pivoting the audit
   log from NDJSON to a Dolt table costs ~3 days of schema work and unlocks
   SQL analytics, free cross-machine sync, and a stronger moat. Should be a
   Wave 1 RFC, not a v3.1 deferral.

3. **Prompt-level self-improvement first, SKILL.md second** (Alt 6). WS18
   should be sequenced: ship "patterns appended to AGENTS.md" in Phase 1,
   measure adoption, *then* decide whether SKILL.md generation is worth the
   ceremony. This delays the agentskills.io commitment (D12) until evidence
   shows skills are actually portable in practice.

4. **Meta-spec + AI-generated translator for tier-2 harnesses** (Alt 8). The
   6 active harnesses get hand-written translators. Tier-2 (PI, Hermes, Aider,
   Roo) get LLM-generated translators at install time. D13 stops being a
   hard cut and becomes a tiered support model.

5. **48-hour thesis demo BEFORE Wave 0** (Alt 10). One weekend. One skill, one
   rail, one harness, one log entry. Show it to 5 users. *Then* do Wave 0.
   This is cheaper than Wave 0 and tells you the same thing the migrate PoC
   tells you, plus whether anyone wants the thesis.

## ONE BOLD ALTERNATIVE — Replace 30% of the Plan

**Sell the Agent Log, Not the Workflow** (Alt 9, in part). Reframe Forge as
the *observability standard* for AI coding agents; the 7-stage workflow is the
reference implementation that emits the format. Ditch ~30% of plan: most of
WS16 marketplace, half of WS17 patch tooling, the harness translator's
ambition (drop to 3 harnesses). Add: log analytics surface, replay tool,
publish format spec as RFC. The locked decisions D1, D11, D14 all get
re-scoped. The moat moves from "best workflow" (forkable) to "log-format
adoption" (network effect).

## 3 SACRED COWS WORTH QUESTIONING

1. **6-harness scope (D11)**. Is this the *right* number, or the *defensible*
   number? Three first-class targets (Claude Code + Cursor + Codex) plus a
   meta-spec for everything else may dominate the moat-vs-cost tradeoff.

2. **`forge migrate` as Wave 0 NO-GO gate (D10)**. The PoC validates one
   workload (this repo). It does not validate the *concept*. A 48-hour user
   feedback demo is a stronger NO-GO gate.

3. **agentskills.io as the canonical format (D12)**. We're betting on a spec
   with limited momentum. The cheaper bet is "Forge format ↔ agentskills.io
   shim" — emit ours, translate at the edge. If agentskills.io wins, we adapt;
   if it dies, we don't.

## 1 ABSURD IDEA THAT MIGHT ACTUALLY WORK

**Forge ships zero default skills.** The product is the meta-spec, the
ecosystem mining, and the audit log. Every skill in `.forge/` came from
*your* sessions or *your team's* sessions. No "v3 reference skills." This
solves the "default skills become a maintenance burden" problem by simply not
having defaults. Users get a working empty harness; the value compounds with
use. Forge becomes more like a CRDT-style local-first product than a
"batteries-included framework."

## 1 USER MISCONCEPTION THE PLAN REINFORCES

**That layered config (L1→L4) is what users care about.** Users care about
"can I customize my workflow without forking." The L1/L2/L3/L4 layering is an
*implementation* answer to that, not the *user-facing* answer. The plan keeps
elevating the layering as a feature (D8 `forge options why`, D5 overlays,
the diagram in §2 of the strategy doc) when really the user just wants
"override this one thing" to work. Selling the layering as a feature reinforces
the misconception that it matters; users will skip to the override and never
consult `forge options why`.
