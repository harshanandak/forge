# Research: Superpowers Integration Possibilities for Forge

**Feature slug**: `superpowers-integration`
**Date**: 2026-02-26
**Prerequisite**: Read `docs/research/superpowers.md` first for Superpowers overview.
**Sources**: All claims cite exact URLs.

---

## The Core Question

> Can we install Superpowers as a base layer and build Forge on top of it?
> Or should we cherry-pick specific ideas and add them to Forge's workflow?
> What are all the possibilities, and what are the real pros and cons?

---

## How Claude Code Plugin Stacking Works

Multiple plugins can coexist simultaneously. Claude Code installs plugins to `~/.claude/plugins/` and loads all of them. As of 2026-02-14, there are 50+ official plugins available and people routinely run several at once.

**Source**: https://www.reddit.com/r/ClaudeAI/comments/1r4tk3u/there_are_28_official_claude_code_plugins_most/

Official docs confirm two deployment modes:
- **Standalone**: `.claude/` directory, slash commands like `/hello` — project/personal-specific
- **Plugin**: Named prefix, shareable, installed via marketplace — cross-project

**Source**: https://code.claude.com/docs/en/plugins

**No built-in conflict resolution mechanism exists.** Conflicts arise only from:
1. Identical slash command names
2. Overlapping auto-trigger logic (the more dangerous one)

Superpowers uses `/command` prefix namespacing (e.g., `/superpowers:brainstorm`) in some usage patterns, but its skills also auto-trigger without commands via the `using-superpowers` skill.

---

## The Auto-Trigger Problem (Critical to Understand)

The `using-superpowers` skill contains a non-negotiable rule:

> "Invoke relevant skills before any response — even with only a 1% chance of applicability."
> "Red flags to avoid: treating questions as simple, seeking context before skill verification, characterizing tasks as not needing formal skills."

**Source**: `skills/using-superpowers/SKILL.md` — https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md

This means: if Superpowers is installed, **it will auto-trigger `brainstorming` every time a user requests a new feature** — before Forge's `/research` stage runs. The Superpowers `brainstorming` skill then hands off to `writing-plans`, creating its own planning artifact at `docs/plans/YYYY-MM-DD-<topic>-design.md`. This runs in parallel to Forge's `docs/research/<slug>.md`.

The result of installing both without coordination:

```
User: "Let's build feature X"
→ Superpowers brainstorming auto-triggers (HARD-GATE: no code until approved)
→ Superpowers writing-plans creates docs/plans/2026-02-26-feature-x.md
→ User runs /research
→ Forge creates docs/research/feature-x.md  ← duplicate effort
→ User runs /plan
→ Forge creates Beads issue + branch
→ User runs /dev
→ Superpowers subagent-driven-development might auto-trigger  ← possible collision
```

Two independent planning artifacts, two review flows, ambiguity about which governs. This is the core compatibility risk.

---

## The 5 Integration Options: Full Analysis

---

### Option 1: Install Superpowers as Base + Run Forge Commands on Top

**What it means**: Install Superpowers plugin via marketplace. Forge commands remain in `.claude/commands/`. Both active simultaneously.

**How technically**:
```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
# Forge commands already in .claude/commands/ — stay as-is
```

**What you get**: All 14 Superpowers skills auto-available + all Forge commands available.

**Pros**:
- Zero changes to Forge — install and go
- Immediately gets brainstorming HARD-GATE, systematic-debugging, git worktrees, two-stage code review
- Superpowers auto-updates via `/plugin update superpowers`
- Superpowers handles gaps Forge doesn't cover (debugging, verification, worktrees)
- Jesse Vincent actively maintains it (v4.3.1, last push 2026-02-21)

**Cons**:
- **Workflow collision**: Superpowers brainstorming auto-triggers before Forge's `/research`. Two parallel workflows compete for the same stages.
- **Duplicate artifacts**: `docs/plans/` (Superpowers) + `docs/research/` (Forge) created for every feature
- **Stage confusion**: User runs `/plan`, Forge creates Beads issue. But Superpowers has already created a plan via `writing-plans`. Which is authoritative?
- **No cross-system awareness**: Superpowers doesn't know about Beads. Forge doesn't know about Superpowers design docs.
- **Suppression difficulty**: Telling Claude "don't auto-trigger Superpowers for stages Forge handles" requires adding explicit suppression rules to AGENTS.md/CLAUDE.md — fragile, relies on soft instructions.

**Verdict**: Works for exploratory use. Not production-ready without explicit coordination layer in AGENTS.md that defines which system governs each stage. Medium friction in practice.

**Source on workflow collision pattern**: https://www.reddit.com/r/ClaudeCode/comments/1q9nx3d/workflow_questions_superpowers_speckit_custom/ (people already hitting this with Superpowers + SpecKit stacking)

---

### Option 2: Superpowers as Base + Forge Overrides (Coordinated Stack)

**What it means**: Install Superpowers AND add explicit coordination rules in AGENTS.md that suppress Superpowers auto-triggers for stages Forge owns, and delegate to Superpowers only for stages Forge doesn't cover.

**Division of labor**:
| Stage | Owner | Why |
|-------|-------|-----|
| Pre-feature brainstorming | Forge `/research` | Forge's research is deeper (web search, OWASP) |
| Planning | Forge `/plan` | Beads + OpenSpec integration |
| TDD development | Forge `/dev` | Parallel Task agents |
| Validation | Forge `/check` | OWASP security scan included |
| Shipping | Forge `/ship` `/review` `/premerge` `/verify` | Full PR lifecycle |
| Debugging | **Superpowers** `systematic-debugging` | Forge has no equivalent |
| Git worktrees | **Superpowers** `using-git-worktrees` | Forge has no equivalent |
| Verification before done | **Superpowers** `verification-before-completion` | Forge has no equivalent |

**AGENTS.md coordination block needed**:
```markdown
## Workflow Coordination: Forge + Superpowers

Superpowers is installed but Forge commands govern the primary development workflow.
**DO NOT auto-trigger Superpowers brainstorming or writing-plans** — use Forge's
/research and /plan commands instead.

Invoke Superpowers skills ONLY for:
- Debugging → systematic-debugging skill
- Git isolation → using-git-worktrees skill
- Pre-completion verification → verification-before-completion skill
```

**Pros**:
- Gets the best of both: Forge's research + Beads + OpenSpec + PR lifecycle + Superpowers' debugging + worktrees + verification
- Clear role definition eliminates most collision
- Superpowers auto-updates for the skills Forge uses

**Cons**:
- Coordination rules are soft instructions in AGENTS.md — not guaranteed to be followed (same failure mode as Option A in agent-instructions-sync research)
- Still two systems to maintain/understand
- New contributors must learn both systems

**Verdict**: Best "install both" option, but requires explicit AGENTS.md governance. Medium-high complexity.

---

### Option 3: Cherry-Pick Specific Ideas Into Forge (No Superpowers Installation)

**What it means**: Don't install Superpowers. Instead, port the best ideas directly into Forge's existing commands and add new commands.

**What to cherry-pick**:

**A. HARD-GATE pattern** → Add to `/research`, `/plan`, `/dev` commands
```
<HARD-GATE>
Do NOT proceed to implementation until research document exists at
docs/research/<slug>.md with OWASP analysis completed.
</HARD-GATE>
```

**B. `brainstorming` stage** → New `/brainstorm` command or integrate into `/research`:
- Before /research runs web search, run one-question-at-a-time design clarification
- Save design doc to `docs/plans/YYYY-MM-DD-<slug>-design.md`
- HARD-GATE: no research until design intent is captured

**C. `systematic-debugging`** → New `/debug` command with 4-phase methodology:
- root-cause-tracing, defense-in-depth, condition-based-waiting techniques

**D. `verification-before-completion`** → Integrate into `/check`:
- Before declaring check done, run verification that the fix actually works end-to-end

**E. `writing-skills` methodology** → Use to build new Forge commands properly:
- Apply TDD to skill creation: write failing test first, minimal skill, close loopholes
- Add Claude Search Optimization to command descriptions

**F. Two-stage code review** → Upgrade `/review` command:
- Stage 1: spec compliance (does implementation match the research/plan?)
- Stage 2: code quality (is the code well-written?)

**Pros**:
- Single coherent system — no workflow collision
- Full control over every behavior
- No external dependency — Forge is self-contained
- Can adopt exact pieces without the parts that don't fit

**Cons**:
- Development effort to port/adapt each idea
- Maintenance burden — won't benefit from Jesse Vincent's updates automatically
- HARD-GATE pattern requires rewriting all 9 commands

**Verdict**: Best long-term path for Forge as a standalone, opinionated workflow. Highest initial effort, lowest ongoing complexity.

---

### Option 4: Forge as a Superpowers Plugin (Distribute Forge Through Superpowers)

**What it means**: Rewrite Forge's commands AS Superpowers-compatible skills. Package Forge as a plugin that extends Superpowers rather than sitting alongside it.

**Structure**:
```
forge-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── forge-research/    # Replaces /research command
│   ├── forge-plan/        # Replaces /plan command
│   ├── forge-dev/         # Replaces /dev command
│   ├── forge-check/       # Replaces /check command
│   ├── forge-ship/        # Replaces /ship command
│   ├── forge-review/      # Replaces /review command
│   ├── forge-premerge/    # Replaces /premerge command
│   └── forge-verify/      # Replaces /verify command
└── agents/
    └── code-reviewer.md   # (already in Superpowers)
```

Install flow:
```bash
/plugin install superpowers        # Base layer: TDD, debugging, worktrees
/plugin install forge              # Forge layer: research, OpenSpec, Beads, PR lifecycle
```

**Pros**:
- Forge gets plugin distribution (single install command)
- Forge and Superpowers have defined separation — no collision
- Users get a curated stack that works together by design
- Superpowers handles debugging/worktrees, Forge handles research/OpenSpec/Beads/PRs
- Jesse Vincent has a `obra/superpowers-developing-for-claude-code` tutorial repo for exactly this

**Source**: https://lobehub.com/skills/obra-superpowers-developing-for-claude-code-workflow — confirms `superpowers-developing-for-claude-code` repo exists with `full-featured-plugin/skills/workflow` example.

**Cons**:
- Complete rewrite of Forge commands as skills (high effort)
- Forge then has a runtime dependency on Superpowers
- Users must install two plugins instead of one
- Forge's value proposition (beads + OpenSpec + 9-stage) must be re-expressed as skills

**Verdict**: Best long-term distribution model IF Forge wants to be a Claude Code plugin available in a marketplace. High effort, high payoff for adoption.

---

### Option 5: HARD-GATE Pattern Only — Minimum Viable Change (Quickest Win)

**What it means**: Don't install Superpowers. Don't rewrite commands. Just add HARD-GATE blocks to existing Forge commands where stage-skipping is the problem.

**Changes needed** (6 edits, ~15 minutes):

`/research` command — add:
```
<HARD-GATE>
Do NOT proceed to /plan without a completed research document at
docs/research/<slug>.md that includes OWASP analysis and TDD test scenarios.
</HARD-GATE>
```

`/plan` command — add:
```
<HARD-GATE>
Do NOT proceed to /dev without:
1. Beads issue created and status=in_progress
2. Branch created at feat/<slug>
3. Research doc confirmed at docs/research/<slug>.md
</HARD-GATE>
```

`/dev` command — add:
```
<HARD-GATE>
Do NOT write any production code until a FAILING TEST exists for that code.
Delete any code written before its test. There are no exceptions.
</HARD-GATE>
```

**Pros**:
- Done in one session, zero new features
- Directly addresses the scope discipline problem
- Can be implemented TODAY before anything else
- Proven pattern (introduced in Superpowers v4.3.0 after Jesse Vincent found soft instructions insufficient)

**Cons**:
- Doesn't add debugging, worktrees, verification, brainstorming
- Only fixes enforcement, not capability gaps

**Source on why hard gates work**: https://blog.fsck.com/releases/2026/02/12/superpowers-v4-3-0/ — Jesse Vincent's own writeup: "What I was actually doing: skip all of that and start scaffolding a Vite project."

**Verdict**: Do this first regardless of which option is chosen for the larger integration. Zero risk, immediate value.

---

## Decision Matrix

| Option | Effort | Collision Risk | Capability Gain | Maintenance | Distribution |
|--------|--------|---------------|-----------------|-------------|--------------|
| 1: Install both (no coordination) | Low | HIGH | High | Low | No |
| 2: Install both (coordinated) | Medium | Medium | High | Medium | No |
| 3: Cherry-pick into Forge | High | None | High | High | No |
| 4: Forge as Superpowers plugin | Very High | None | High | Medium | Yes |
| 5: HARD-GATE only | Very Low | None | Low | Low | No |

---

## Recommended Path (Three Phases)

### Phase 1: Immediate (This Session)
**Do Option 5** — Add HARD-GATE blocks to `/research`, `/plan`, `/dev` commands.
- Zero risk, zero new dependencies
- Directly fixes the scope discipline problem surfaced in this session
- Takes ~15 minutes

### Phase 2: Short-Term (Next 1-2 Sessions)
**Do Option 3 partially** — Cherry-pick these specific ideas into Forge:
1. Add a `/brainstorm` command (port Superpowers brainstorming skill, adapted for Forge's research-first approach)
2. Add a `/debug` command (port `systematic-debugging`)
3. Integrate `verification-before-completion` logic into `/check`
4. Upgrade `/review` to two-stage (spec compliance → code quality)

### Phase 3: Long-Term (Strategic Decision Needed)
**Decide between Option 2 and Option 4**:
- If Forge stays project-specific → Option 2 (install both, coordinated)
- If Forge should be a distributable plugin → Option 4 (rewrite as Superpowers plugin)

The `obra/superpowers-developing-for-claude-code` tutorial repo is the resource for Option 4.
**Source**: https://lobehub.com/skills/obra-superpowers-developing-for-claude-code-workflow

---

## HARD-GATE Implementation Detail

The exact pattern from Superpowers v4.3.0 brainstorming skill:

```markdown
<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project,
or take any implementation action until you have presented a design and the
user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>
```

**Key structural elements** that make it work:
1. Explicit `<HARD-GATE>` tag — signals to the model this is non-negotiable
2. Lists EXACTLY what is forbidden (not just "think first")
3. Provides the approval condition (what unlocks the gate)
4. States universal applicability ("EVERY project")
5. Names the anti-rationalization ("regardless of perceived simplicity")

This is more effective than soft instructions because it eliminates the model's ability to rationalize skipping.

**Source**: https://ddewhurst.com/blog/superpowers-claude-code-plugin-enforces-what-you-should-do/ (2026-02-17 article specifically about v4.3.0 hard gates)

---

## What Forge Has That Superpowers Cannot Replace

These are Forge's unique strengths — not present in Superpowers and not cherry-pickable:

1. **Multi-agent file support** (AGENTS.md/CLAUDE.md/GEMINI.md) — serves 9+ agent types, not just Claude Code
2. **OpenSpec** — formal architecture proposals with PR approval workflows
3. **Beads** — persistent cross-session issue tracking with dependencies
4. **Research-first mandate** — web search + OWASP analysis before any planning
5. **Full PR lifecycle** — `/ship`, `/review`, `/premerge`, `/verify` as an integrated sequence
6. **SonarCloud + Greptile** integrations

Superpowers is Claude Code-only. Forge is multi-agent by design. This is a fundamental architectural difference that makes Forge irreplaceable for multi-agent teams.

---

## Key Signals From Community

"Would SpecKit be helpful to add into my workflow before brainstorming? I currently use the Superpowers skill/plugin quite a bit for brainstorming, planning, etc."
— https://www.reddit.com/r/ClaudeCode/comments/1q9nx3d/
(People ARE stacking multiple workflow systems. The compatibility concern is real and actively discussed.)

"GSD vs Superpowers vs Speckit — what are you using for BE work?"
— https://www.reddit.com/r/ClaudeCode/comments/1qxfprh/
(The market is fragmented. No single workflow tool dominates. Users mix and match.)

"Claude Code's Superpowers plugin actually delivers — sub-agents that verify implementation against the plan document. Catches what you'd normally miss."
— https://www.reddit.com/r/ClaudeCode/comments/1r9y2ka/

---

## Sources Index

| # | URL | Used For |
|---|-----|---------|
| 1 | https://github.com/obra/superpowers | Full repo structure, skill files |
| 2 | https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md | Auto-trigger rule — core collision concern |
| 3 | https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md | HARD-GATE pattern, 6-step process |
| 4 | https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md | 2-5 min tasks, docs/plans/ artifacts |
| 5 | https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md | Two-stage code review mechanics |
| 6 | https://github.com/obra/superpowers/blob/main/skills/writing-skills/SKILL.md | TDD for skill creation, Claude Search Optimization |
| 7 | https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md | Iron Law, watch test fail mandate |
| 8 | https://code.claude.com/docs/en/plugins | Official plugin stacking docs |
| 9 | https://www.reddit.com/r/ClaudeAI/comments/1r4tk3u/ | 50+ official plugins confirmed, stacking confirmed |
| 10 | https://blog.fsck.com/releases/2026/02/12/superpowers-v4-3-0/ | Hard gate introduction — why soft instructions failed |
| 11 | https://ddewhurst.com/blog/superpowers-claude-code-plugin-enforces-what-you-should-do/ | Hard gate mechanics, v4.3.0 specifics |
| 12 | https://www.reddit.com/r/ClaudeCode/comments/1q9nx3d/ | Real user experience stacking Superpowers + SpecKit |
| 13 | https://www.reddit.com/r/ClaudeCode/comments/1qxfprh/ | GSD vs Superpowers vs SpecKit comparison |
| 14 | https://lobehub.com/skills/obra-superpowers-developing-for-claude-code-workflow | obra/superpowers-developing-for-claude-code tutorial repo |
| 15 | https://github.com/obra/superpowers/blob/main/RELEASE-NOTES.md | v4.1.0 breaking change (OpenCode native skills), v4.0.1 skill access fix |
| 16 | https://github.com/anthropics/claude-plugins-official/pull/148 | Superpowers accepted into official Anthropic marketplace |
| 17 | https://www.reddit.com/r/ClaudeCode/comments/1r9y2ka/ | User report on sub-agent spec compliance verification |
