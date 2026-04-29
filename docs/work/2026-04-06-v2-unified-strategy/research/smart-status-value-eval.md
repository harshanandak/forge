# Smart Status — Value Evaluation

**Date**: 2026-04-06
**Subject**: `forge status` Smart Daily Dashboard (WS1, ~1100 LOC, 3 weeks)
**Verdict**: **Ship MVP version** — score **5/10** as designed, **7/10** as a stripped MVP.

---

## TL;DR

Smart status is **half a good idea wrapped in five bad ones**. The core insight — "if we mirror every GitHub issue locally, the developer needs help filtering the firehose" — is real. But the proposed solution (7-dimension scoring, 8 groups, 6 presentation modes, time + role variants, delta tracking, external classifier) is a **textbook overengineered dashboard** that competes with mature tools (GitHub inbox, Linear My Issues, `gh issue list`) on their home turf and loses.

**Recommendation**: Cut to a 1-week, ~250 LOC MVP. Defer everything else until usage data justifies it.

---

## Score: 5/10 as designed

| Aspect | Score | Notes |
|---|---|---|
| Solves a real problem | 7/10 | Mirror-all (WS3) does create noise that needs filtering |
| Better than alternatives | 3/10 | GitHub inbox + `gh issue list` + `bd ready` already cover 80% |
| Right level of complexity | 2/10 | 7 dims, 8 groups, 6 modes, 2 time variants, 2 role variants = 480 combinations |
| Tunable out of the box | 3/10 | Multi-dim scoring needs months of tuning per user |
| Daily-use stickiness | 5/10 | Devs check Linear/GitHub reactively, not via morning CLI ritual |
| Implementation risk | 4/10 | Stage-relevance + delta tracking + classifier are each a project |
| ROI vs other WS1 work | 4/10 | 3 weeks could ship `forge pr create` + `forge audit` instead |

---

## What's genuinely valuable

1. **Unified "what should I work on right now" view** — answering this in one command is real value, especially with WS3's mirror-all flooding the local DB.
2. **`Ready` group** (tracked + open + unblocked + mine/unassigned) — this is just `bd ready` with a PR-awareness layer. Cheap and useful.
3. **`Your active PRs` group** — saves a `gh pr list --author @me` + status check. Genuinely faster.
4. **`PRs awaiting your reply`** — this IS the killer subset. GitHub's inbox is bad at this; review threads get lost. A CLI that surfaces "3 unresolved review threads on your PRs" is the one thing nothing else does well.
5. **`--json` mode** — enables scripting and agent consumption. Cheap to build, high leverage.

That's it. ~5 bullets of real value.

---

## What's overengineered

### 1. The 7-dimension scoring algorithm
Each weight (25/15/15/20/10/10/5) is a guess. "Stage relevance" requires parsing current branch, recent files, and active task — that's a sub-project. **`exp(-hours/48)`** is cargo-culted from recommender systems where it doesn't matter if the answer is wrong. Here, a wrong score means the dev works on the wrong thing.

**Simpler alternative**: `priority desc, updated_at desc`. Two columns, one ORDER BY. Probably 90% as good.

### 2. The 8 groups
Real mental models in the wild:
- GitHub: Open/Closed
- Linear: Backlog/Todo/In Progress/Review/Done (workflow states)
- Jira: dashboards (user-customized)

Forge's 8 groups are **not workflow states** — they're 8 different filter perspectives jammed onto one screen. That's a dashboard, and dashboards get ignored. Pick **3**: Ready, Your PRs, Needs Reply. The other 5 are nice-to-haves that bloat the UI.

### 3. The 6 presentation modes
`--compact`, `--detailed`, `--tree`, `--kanban`, `--json`, `--md`. Of these:
- `--compact` (default) — needed
- `--json` — needed for agents
- `--detailed`, `--tree`, `--kanban`, `--md` — speculative. **No evidence anyone wants kanban in a CLI.** `--tree` for dep graphs is cute but rarely useful. `--md` is a one-line wrapper anyone can pipe.

### 4. Time-aware variants (`--morning`, `--eod`)
This is **feature creep dressed as user empathy**. Devs don't run `forge status --morning` — they open Slack, check Linear, and start coding. The "morning routine: run forge status" premise is **aspirational, not observed**. Cut both.

### 5. Role-aware variants (`--maintainer`, `--contributor`)
Same problem. Roles are stable per project — make it a config setting (`forge.config.json: { role: "maintainer" }`), not a flag. This isn't a feature; it's a default.

### 6. Delta tracking
Tracking "what changed since last view" requires persistent state (last-viewed timestamp per issue), and competes directly with **GitHub's notification inbox, which already does this and has years of polish**. Building a worse version of GitHub's inbox in a CLI is a losing battle.

**Exception**: delta tracking IS valuable for **review threads** specifically (item #4 from "valuable" list above), because GitHub's inbox handles those poorly.

### 7. External issue auto-classifier
Parsing titles/bodies/labels to classify issues by type is a small NLP project. It will be wrong 30% of the time. The value is marginal (you still have to read the issue). **GitHub already has labels.** Just trust the labels. If a project doesn't label issues, no classifier will save it.

---

## Compared to existing tools

| Tool | What it does well | Where smart status competes |
|---|---|---|
| `gh issue list` / `gh pr list` | Fast, scriptable, lives in muscle memory | Smart status is slower (scoring overhead) and unfamiliar |
| GitHub Inbox | Notifications, mentions, review requests | Smart status duplicates this poorly |
| Linear My Issues | Saved views, fast, polished UI | CLI can't compete on UX |
| `bd ready` / `bd blocked` | Already exist, already work | Smart status replaces them with more code |
| GitHub Projects v2 | Custom fields, workflows, board view | Different mental model entirely |

**The only gap**: aggregating beads-tracked work + GitHub PRs + unresolved review threads in **one command**. That's the wedge. Everything else is duplicating mature tools.

---

## On the "replace 6 commands" claim

The 6 commands aren't redundant — they're **different mental models** that happen to share a data source:

- `bd ready` = "what can I start?" (planning mode)
- `bd blocked` = "what's stuck?" (unblocking mode)
- `bd stale` = "what needs triage?" (maintenance mode)
- `/status` = "where am I in the workflow?" (orientation mode)
- PR check = "what's waiting on me?" (review mode)
- "What's new" = "did anything change?" (catch-up mode)

Smashing these into one command doesn't simplify — it forces the dev to mentally separate the noise themselves. **Unification is not always good UX.** Sometimes 6 small commands beat 1 big one.

---

## Recommendation: Ship MVP

### Cut entirely
- Time-aware variants (`--morning`, `--eod`)
- Role-aware variants (use config instead)
- 4 of 6 presentation modes (`--detailed`, `--tree`, `--kanban`, `--md`)
- External issue auto-classifier (trust labels)
- Stage relevance dimension (filesystem analysis is too expensive)
- Activity decay function (use `updated_at desc`)
- Delta tracking for issues (keep only for review threads)
- 5 of 8 groups (`Needs Attention`, `Recent External`, `Stale`, `Mentioned You`, `Blocked`)

### Keep (MVP)
- **3 groups**: `Ready to work on`, `Your active PRs`, `PRs awaiting your reply`
- **Scoring**: `ORDER BY priority DESC, updated_at DESC` (no weights, no exp decay)
- **2 modes**: default (compact) and `--json`
- **Review thread delta**: highlight PRs where new review comments appeared since last `forge status`

### MVP effort
- **~250 LOC** (vs 1100)
- **1 week** (vs 3)
- **0 modules** named "scorer", "grouper", "escalation", "relevance", "delta-tracker", "presenter", "cache" — just `lib/status.js`

### When to add more
Ship MVP. Track usage telemetry (how often `forge status` is run, which groups are scrolled past, which issues are clicked into). **After 3 months of real data**, decide which of the cut features are actually missed. Build only those.

---

## Key insight

The premise "morning routine: run forge status, see what to work on" is **a designer's fantasy, not an observed user behavior**. Developers don't start their day with a CLI dashboard — they start it with Slack, email, and their editor. A CLI status command is used **reactively** ("wait, what was I doing?", "what PRs need me?"), not **ritualistically**.

Design for the reactive use case: fast, focused, answers ONE question per invocation. Not a dashboard. A **lookup tool**.

The 3-week, 1100-LOC version optimizes for the wrong use case. The 1-week, 250-LOC version optimizes for the right one.

---

## Final verdict

**Ship MVP version.** ~250 LOC, 1 week, 3 groups, 2 modes, no scoring weights, no time/role variants, no classifier. Reclaim the other 2 weeks for `forge pr create` idempotency, `forge audit`, and MCP/CLI parity tests — all of which have clearer ROI in WS1.

If after 3 months of telemetry the MVP feels limiting, add features back one at a time, justified by data. Don't ship the dashboard speculatively.
