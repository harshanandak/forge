# Hermes Integration

> Roadmap lane: `forge-2agy.9.7.x` (Hermes adapter)

This document defines how the **Hermes** harness integrates with a Forge
project, and — most importantly — the boundary between **Forge Kernel state**
(shared, authoritative, cited) and **Hermes-native memory** (private to a Hermes
session or profile).

The consumption contract that Hermes sessions follow lives in
[skills/hermes-forge/SKILL.md](../../skills/hermes-forge/SKILL.md). The storage
model Hermes reads against is described in
[FORGE_KERNEL_STORAGE_MODEL.md](FORGE_KERNEL_STORAGE_MODEL.md), and the
writeback surface in
[forge-kernel-issue-command-contract.md](forge-kernel-issue-command-contract.md).

## Why a boundary is needed

Hermes carries its own conversational/profile memory. Forge carries the
project's durable, provenance-tracked state. If Hermes were allowed to write its
private memory into Forge state, the two would drift: Forge would accumulate
Hermes-specific context that other harnesses (Claude Code, Codex, Cursor) cannot
interpret, and the "single source of truth" guarantee behind `forge orient` /
`forge recap` would erode.

The integration therefore makes Forge state the authority and Hermes a
**consumer** that writes back only through the same audited CLI surface it reads
from.

## The two memory tiers

| | Forge Kernel state | Hermes-native memory |
| --- | --- | --- |
| **Owner** | Forge | Hermes |
| **Scope** | The project — shared across all harnesses | One Hermes session / profile |
| **Authority** | Source of truth | Convenience cache, never authoritative |
| **Read path** | `forge orient` / `forge recap` (bounded, cited JSON) | Hermes' own store |
| **Write path** | Forge CLI only (`forge comment`, `forge update`) | Hermes' own store |
| **Contains** | Issues, decisions, evidence, design snapshots, claims, queues | Prompts, session scratch, user preferences, Hermes profile data |
| **Provenance** | Every fact carries `{ path, source_kind, authority, role }` | Not part of the Forge provenance graph |

### What lives in Forge Kernel state

Anything that is a **project fact**: issue records, decisions, evidence,
design-snapshot content, ready queues, and active claims. These are emitted —
bounded and cited — by `forge orient` and `forge recap`, and are written back
exclusively through Forge CLI commands.

### What lives in Hermes-native memory

Anything that only matters to **Hermes**: conversational history, session
scratchpads, per-user preferences, and the Hermes profile itself. None of this
belongs in Forge Kernel state.

## Authority rule

Forge Kernel state is the single source of truth. When Hermes needs project
state it MUST obtain it from `forge orient` / `forge recap` (JSON form) rather
than reconstructing it from raw files or kernel internals. When two sources
conflict, prefer the higher `authority` and surface the conflict instead of
silently choosing.

## Writeback rule

Evidence and decisions discovered in a Hermes session flow back into the Forge
Kernel **only** through Forge CLI commands:

- `forge comment <id> <body...>` — attach evidence, a decision, or a note to an issue.
- `forge update <id...> [flags]` — update issue state/fields.
- `forge create [title] [flags]` — open a follow-up issue.

(`forge audit` is verify-only — `forge audit verify` — and is not an
evidence-append path; record evidence as an issue comment.)

These writes land in the Forge Kernel issue store and become part of the issue's
durable history. Note the read/write asymmetry: the bounded `forge orient` /
`forge recap` envelope is assembled from project docs, `docs/work` artifacts, and
the issue summary — it surfaces issue/design/decision state but does **not** echo
individual issue comments back. Evidence added via `forge comment` lives in the
issue history (reachable from the issue record), not necessarily in the next
orient/recap payload.

## The no-profile-write guard

The hard boundary, enforced as a contract in the `hermes-forge` skill and
guarded by tests:

> **Hermes MUST NOT write Hermes profile state into Forge Kernel state.**

Concretely, a Hermes session must never:

- Persist Hermes profile or session memory into Forge Kernel storage.
- Edit Forge state files (design, decision, issue stores) directly to record
  Hermes-side context.
- Use the Forge issue/evidence backend as a dumping ground for
  Hermes-only data.

If a piece of context only matters to Hermes, it stays in Hermes-native memory.
If it is a project fact, decision, or evidence item, it is written through the
Forge CLI so it becomes part of the shared, cited source of truth.

## Token-budget & truncation expectations

`forge orient` and `forge recap <issue-id>` emit the deterministically bounded
envelope (default ~2000 estimated tokens, `chars_per_token: 4`). Truncation
follows the published `token_budget.truncation_order`, marks trimmed sections
with `[truncated deterministically by token budget]`, and sets `truncated: true`.
Hermes treats truncated sections as incomplete and re-requests with a higher
`--budget` when completeness matters. (Bare `forge recap` — no issue id —
returns the legacy activity summary, which is not the bounded envelope.) See the
skill for the full envelope and provenance model.
