# Skill Generation from Observed Work — Design

**Goal**: Forge observes agent work, detects repeated patterns, and either suggests improvements to existing skills/stages or generates new SKILL.md files for user review.

---

## 1. Data Sources

| Source | API / File | Signal Type | Volume Estimate |
|---|---|---|---|
| Beads issue history | `bd query`, `bd history`, `lib/forge-issues.js`, `.beads/issues.jsonl` | Issue titles, types, labels, time-to-close, comment trails, blockers | 10-50 issues/week |
| Beads interaction log | `.beads/interactions.jsonl` (append-only via `beads:audit`) | Agent actions per issue, tool labels | 100-500 events/week |
| Session events FTS5 | context-mode `ctx_search(source:"session-events")` | Full agent transcripts: prompts, tool calls, errors | 5-20 MB/week |
| Git commit history | `git log --format=%s%n%b`, `lib/commands/ship.js` | Commit message patterns (test:/feat:/fix:/refactor:), file deltas | 20-100 commits/week |
| File-change patterns | `git diff --name-only` per commit | Co-changed file clusters | derived from commits |
| Stage outcome metrics | `lib/runtime-health.js`, `lib/forge-context.js`, validate/ship/review exit data | HARD-GATE pass/fail counts, retry rate per stage | per-stage event |
| Slash command history | Claude transcripts + `lib/commands/*.js` invocation logs | Repeated `/dev` → `/validate` → `/ship` failure loops | per-stage event |
| PR review feedback | `gh pr view`, Greptile/SonarCloud responses, `lib/greptile-match.js` | Recurring review categories (path leaks, missing tests, etc.) | 5-20 PRs/week |

---

## 2. Trigger Patterns (detection logic, one line each)

1. **Repeated manual sequence** — same N-tool sequence (e.g., `bd query → gh pr view → grep`) appears in >=5 sessions across >=3 issues → propose new skill.
2. **Recurring review feedback** — same Greptile/Sonar issue category fires on >=3 PRs (group by `lib/greptile-match.js` category) → propose tightening `/review` or new pre-ship gate.
3. **HARD-GATE failure loop** — `/validate` fails >=3 consecutive times on same rule (lint, typecheck) → propose fix-template skill or pre-`/validate` lint-fix step.
4. **Stage retry storm** — `/dev` re-enters >=3x for same beads issue → propose splitting tasks at `/plan` Phase 3, or add reviewer subagent step.
5. **Commit-message pattern** — >=5 commits matching same regex (`fix: typo in <pkg>`, `chore: bump dep`) → propose macro skill or codemod.
6. **Co-change cluster** — file pair/triple changed together in >=4 commits → suggest "touch X also when editing Y" reminder skill.
7. **Time-to-close outlier** — beads issue type X has p90 close time 3x baseline → propose research/checklist skill for that issue type.
8. **Cross-session prompt repetition** — same/near-duplicate user prompt (cosine similarity via FTS5 + embedding hash) appears in >=3 sessions → propose canonical slash command.

---

## 3. Suggestion UX

- **Surface points**: (a) at end of `/verify` (post-merge) when patterns crossed thresholds during the cycle; (b) on demand via new `forge insights` and slash command `/forge suggest-skill`; (c) opportunistic banner during `/status` when >=1 high-confidence suggestion is queued.
- **Interaction model**: `forge insights` prints ranked candidates with evidence (e.g., "Pattern matched 7 times; sources: bd-23, bd-31, session-events:abc"). User picks `accept`, `edit`, `reject`, or `defer`. `accept` runs the generation pipeline; `reject` records a negative-signal so the same trigger does not re-fire for 30 days.
- **Storage of pending suggestions**: `.forge/insights/pending.jsonl` (append-only); decisions in `.forge/insights/decisions.jsonl`.

---

## 4. Generation Pipeline (5 steps)

1. **Detect** — `lib/insights/detector.js` (new) runs nightly + on `forge insights` invocation; reads sources from §1, emits candidate `{trigger, evidence[], confidence}` rows to `pending.jsonl`.
2. **Cluster + score** — group near-duplicate candidates; rubric-score 0-100 (frequency, recency, cross-session, user-friction proxy). Below 60 = drop.
3. **Brief** — for each accepted candidate, build a generation brief (pattern summary, evidence excerpts, target type: new-skill | skill-improvement | new-gate).
4. **Generate** — invoke the bundled `skill-creator` skill (already available) as a subagent with the brief; output is a `SKILL.md` (new) or a unified diff against an existing skill (improvement). Frontmatter follows existing `.claude/skills/*` convention (name, description, when-to-use).
5. **Land + review** — write to `.forge/extensions/local/<slug>/SKILL.md` for new skills, or `.forge/extensions/local/patches/<existing-skill>.diff` for improvements. `forge insights review <id>` opens it in `$EDITOR`; on `accept`, Forge copies into `.claude/skills/` and runs `scripts/sync-commands.js`. Nothing is auto-committed — user owns the commit.

---

## 5. Improvement Suggestions for Existing Skills

For an existing skill (e.g., `/review`), the detector emits a structured delta: target file, change kind (`tighten-gate` | `add-step` | `add-edge-case` | `add-trigger-keyword`), proposed text, and 3+ evidence pointers. The generator produces a unified diff against the current SKILL.md. User reviews via `forge insights diff <id>` (renders in terminal) before `accept`. Improvements never overwrite without diff approval.

---

## 6. Privacy / Scope

- **Local-only by default**: all observation reads from already-local sources. No network egress.
- **Opt-in**: gated by `forge.config.json` flag `insights.enabled` (default `false`). First `/verify` after upgrade prompts once.
- **Per-project** observation; suggestions can be promoted **per-user** via `forge insights promote <id> --global` which writes to `~/.claude/skills/`.
- Session-events excerpts are redacted via existing `lib/project-memory.js` redaction helpers before being stored in suggestion evidence.

---

## Open Questions

1. Should improvement diffs against bundled (non-local) skills like `/review` write to `.forge/extensions/local/patches/` (overlay model) or fork the skill into local? Overlay keeps upstream updates clean but needs a merge resolver.
2. What is the minimum confidence threshold for surfacing during `/status` vs only on explicit `forge insights`? Proposed 80 vs 60 — confirm.
3. For "recurring review feedback", should Forge also auto-author a Beads issue tagged `quality-improvement` so the suggestion is tracked even if rejected as a skill?

---

## Week-1 Proof of Concept

**Ship `forge insights --review-feedback` only.** Single trigger: §2.2 (recurring Greptile/Sonar categories on merged PRs in last 30 days). Reads `gh pr list --state merged` + existing `lib/greptile-match.js`. Output: a single ranked list printed to stdout with copy-paste-ready SKILL.md drafts (no file writes, no acceptance flow, no scheduler). Validates the detection-and-generation loop on the highest-signal source before building the full pipeline, write paths, or UX.
