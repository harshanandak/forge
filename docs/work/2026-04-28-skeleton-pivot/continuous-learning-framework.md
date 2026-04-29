# Forge Continuous Learning Framework

**Status**: Active design (D39, locked 2026-04-29)
**Replaces**: any standalone "skill generation" or "agent telemetry" framing
**Anchors**: D17, D18, D22, D23, D35, D36, D37, D38

---

## What this is

A unified loop that ties together pieces Forge already has, into one continuously-improving system:

```
┌──────────────────────────────────────────────────────────────┐
│  1. OBSERVE                                                   │
│     bd audit record  →  .beads/interactions.jsonl             │
│     Every action across every harness, append-only.           │
├──────────────────────────────────────────────────────────────┤
│  2. DETECT                                                    │
│     forge insights  →  pattern detection over interactions    │
│     Voyager-style + recency-weighted retrieval                │
├──────────────────────────────────────────────────────────────┤
│  3. PROPOSE                                                   │
│     iteration-driven planning method  →  proposals            │
│     Phase 1: intent · Phase 2: research · Phase 3: critics    │
│     Phase 4: synthesis · Phase 5: lock with supersedes        │
│     Output: .forge/proposals/<id>.md                          │
├──────────────────────────────────────────────────────────────┤
│  4. ACCEPT                                                    │
│     forge skill accept <id>  →  patch.md entry + commit       │
│     Or: user rejects, iteration data improves next round      │
├──────────────────────────────────────────────────────────────┤
│  5. REFINE                                                    │
│     Acceptance/rejection feeds back to detector + descriptions│
│     Bad proposals become anti-pattern signal                  │
│     Good proposals refine skill descriptions for auto-invoke  │
└──────────────────────────────────────────────────────────────┘
                           ▲
                           │ next iteration
                           ▼
                       (loop continues)
```

## What Forge can refine via this loop

The framework applies to multiple Forge primitives:

| Primitive | What "learning" looks like |
|---|---|
| **Skills** | Description quality (auto-invoke acceptance rate), trigger globs, skill creation from observed patterns |
| **Commands** | Command discovery (suggest new commands when 3-step manual sequence repeats 5x) |
| **Workflows** | Stage phase additions, classification thresholds, autonomy level defaults |
| **L1 rails** | Project-specific gate proposals (NOT new L1 rails — those stay locked — but project-required L2 stages) |
| **Adapters** | Suggest new integrations based on which external tools user invokes |
| **Memory** | Decision supersedes tracking, episode compaction triggers, importance scoring |

## How this differs from competitors

### vs Cursor Memories (June 2024)

| Dimension | Cursor Memories | Forge Continuous Learning |
|---|---|---|
| Scope | Within Cursor IDE only | Cross-harness (Claude/Cursor/Codex) via filesystem state |
| Categories | Preferences mostly | 7 typed memory categories + skills + commands + workflows + adapters |
| Engine | Implicit + explicit accept/reject | Explicit iteration-driven planning method (5 phases) |
| Durable record | Cursor's storage | patch.md (git-versioned) + bd remember (Dolt-backed, portable) |
| Refinement signal | Accept/reject retrains preference cache | Accept/reject + iteration loop with parallel critics |
| Cross-tool | Locked to Cursor | Designed for harness-agnostic from day 1 |

**Forge's edge**: harness-agnostic + categorized + reasoning-engine-driven proposals (not just preference cache).

### vs Hermes Agent

Hermes has a learning loop that creates/improves skills autonomously. **Closest analog**, validates the model. Differences:
- Hermes is one-tool (their TUI + multi-platform gateway); Forge is harness-overlay
- Hermes auto-creates skills; Forge proposes via iteration-driven method (more deliberate)
- Hermes has central database; Forge keeps state in filesystem (sandbox-friendly)

### vs Mem0 / MemGPT / Letta

These are agent-memory libraries focused on RECALL (semantic retrieval over past interactions). Forge's loop includes recall as Phase 2 (research) but ALSO includes propose+accept+refine. **Mem0 is what Forge invokes; not what Forge IS.**

### vs Claude Code native plugins/skills

Claude's plugins are static — they don't observe your work and propose changes. **Forge layers continuous learning ON TOP OF Claude Code's plugins** without replacing them.

## Per-category learning patterns

### Skills (Voyager-style accumulation)

- Pattern detector finds: same 3-step sequence repeated ≥5 times in 2 weeks
- Iteration-driven planning generates a candidate SKILL.md (with description for auto-invoke)
- User accepts → skill lands in `.forge/extensions/local/<slug>/`, committed to patch.md
- Auto-invoke acceptance rate refines description over time
- Stale skills (low fire rate, low accept rate) get deprecation proposals

### Commands

- User invokes 3-command sequence consistently
- Forge proposes a single combined command
- User accepts → wrapped as command via plop scaffolding

### Workflows

- Pattern detector tracks classification distribution per project
- Suggests defaults: "you ran `bug-tiny` 80% of the time — pin it as default for this project?"
- Suggests phase additions when iteration loop reveals consistent gaps

### L1 rail proposals (project-level only, never global)

- Project-specific gates: "your repo has 14 commits with `--force-skip-tdd` — add `tdd-strict: true` to project L1?"
- Forge protocol L1 stays locked. Project can stiffen, never weaken.

## User configurability

Continuous learning is **opt-in per category**:

```yaml
# .forge/config.yaml
continuous_learning:
  observe: true              # bd audit always on (it's the audit trail anyway)
  detect:
    skills: true
    commands: true
    workflows: false         # disable workflow nudges
    rails: false
  propose:
    autonomy: checkpoint     # show proposals, don't auto-apply
    rate_limit: 1_per_week
```

Default for v3 MVP: observe on, detect on, propose at `checkpoint` autonomy, rate-limited.

## Privacy + correctness

- **Privacy**: redaction via `lib/project-memory.js` strips secrets/paths/tokens before patterns leave the local machine
- **Correctness**: `bd audit label good/bad` lets user grade past actions; signal feeds back to detector
- **Anti-hallucination**: proposals must cite specific past interactions (timestamp + session_id) — no "I think you do X"

## What this changes in the plan

This framework is **not new code** — it's the framing that ties existing planned work together:
- bd audit (D17 → D23): the observe layer
- forge insights (N13 / forge-besw.12): the detect layer
- iteration-driven /plan skill (forge-besw.24): the propose engine (yes, /plan is also the engine for proposing OTHER skill changes)
- patch.md + acceptance flow (D2, D5, D20): the accept layer
- Auto-invoke acceptance tracking (D38): the refine layer

**Net additional work**: ~3 days for the framing layer (config schema, opt-in plumbing, rate limiter). Folds into existing N13 / forge-besw.12 scope.

## Kill criteria

Drop continuous learning if:
- 3 months post-MVP, fewer than 5 proposals accepted across the team
- Privacy redaction proves insufficient (any single secret leak)
- Acceptance rate for proposed skills <20% (signal too noisy to be useful)

## Source documents

- `iteration-driven-planning-skill.md` — the propose engine
- `agent-memory-architecture.md` — the typed memory layer
- `FINAL-THESIS.md` — overall positioning
- `locked-decisions.md` — D17, D18, D22, D23, D35, D38, **D39 (this doc)**
