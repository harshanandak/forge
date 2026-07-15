# Control-plane guarantees — what each control state actually enforces

Status: beta (B6). Issues: `7dc59af2` (controls config + `forge control`),
`724356ea` (all-surface read + enforcement-locus badges). Epic: `363954dd`.

This document is the **contract** the cockpit badges and the `forge control`
command read from. It states, honestly and per surface, what a control state
*actually* guarantees at run time — so the UI never sells enforcement Forge
cannot deliver.

## Why this doc exists — the mis-sell it prevents

The cockpit uses a **tri-state control vocabulary** (`mandatory` / `optional` /
`permission`). That vocabulary is only *meaningful* where Forge can actually
**deny at run time**. On gates and rails it can: a stage transition or the
resolver refuses to proceed. On MCP servers, rules, and skills it cannot —
"mandatory" there would mean nothing more than *the file is present*, decided at
render time, never enforced. Shipping tri-state uniformly across all surfaces
would promise enforcement that does not exist. This matrix draws that line.

## The two axes

- **State** (author intent): `mandatory` · `optional` · `permission`.
- **Enforcement-locus** (what actually happens, and *when*):
  - `run-time-deny (gate)` — a stage transition is blocked until evidence exists.
  - `run-time-deny (rail)` — the resolver refuses to run with the rail off.
  - `run-time-deny (permission)` — blocked until a **human approval event** is
    recorded on the issue (`forge gate approve`).
  - `render-time presence-only` — the item is written into harness config or
    discovered by precedence; nothing denies at run time. **Advisory.**

## The matrix — state × surface × what it guarantees

| Surface | Example ids | Controllable by `forge control`? | State it takes | Enforcement-locus | Guarantee |
|---|---|---|---|---|---|
| **Stage gate** | `gate.plan-exit`, `gate.dev-exit`, `gate.validate-exit`, `gate.ship-entry`, `gate.issue_verify` | **Yes** | `mandatory` / `optional` | `run-time-deny (gate)` | `mandatory`: the stage cannot advance until the gate's evidence exists (`enforce-stage.js`; `validate`/`preflight` fail-closed). `optional`: gate is off — no denial. |
| **Human gate** | `gate.intent`, `gate.plan-approval`, `gate.merge` | **Yes** | `permission` / `optional` | `run-time-deny (permission)` | `permission`: blocked until a durable `gate.approved` kernel **event** exists (`forge gate approve <issue> <gate>`; `forge gate check` exits non-zero without it). `optional`: no approval required. |
| **L1 rail** | `rail.kernel_tracking` (unlocked); other rails (locked) | **Yes** (unlocked only) | `mandatory` / `optional` | `run-time-deny (rail)` | `mandatory`: resolver enforces the rail (locked rails are *permanently* mandatory and cannot be lowered). `optional`: rail off (unlocked rails only). |
| **MCP server** | `mcp.*` | **No — refused** | — | `render-time presence-only` | Rendered into harness MCP config. Presence advises the agent a tool exists; Forge does **not** deny at run time. Not enforceable. |
| **Rule** | `rule.*` (`rules/*.md`) | **No — refused** | — | `render-time presence-only` | Injected as agent guidance. No run-time deny. Advisory. |
| **Skill** | `skill.*` | **No — refused** | — | `render-time presence-only` | Discovered by precedence (`.skills/` > `skills/` > packaged). Presence, not enforcement. Advisory. |

## How the tri-state maps onto Forge's real primitives (single source of truth)

Forge's enforced surface is one field: **`workflow.gates.<id>.enabled`** in
`.forge/config.yaml` — the field the resolver (`applyEnabledConfig` in
`lib/core/runtime-graph.js`) already consumes, shared by gates and unlocked
rails (their id namespaces `gate.*` / `rail.*` are disjoint). `forge control`
reuses exactly this field — it does **not** add a parallel `controls:` key,
because a key the resolver never reads would itself be fake enforcement (the very
mis-sell this doc exists to prevent). The tri-state is the *vocabulary*; `enabled`
is the *truth*. State is therefore **derived**, never stored twice:

| State | Written config | Applies to |
|---|---|---|
| `mandatory` | `workflow.gates.<id>.enabled = true` | stage gates, rails |
| `optional` | `workflow.gates.<id>.enabled = false` | unlocked gates & rails |
| `permission` | `workflow.gates.<id>.enabled = true` | human gates only (enforced via approval event) |

Read-back derives the label from `(enabled, locked, isHumanGate)`:
- human gate + enabled → `permission`; human gate + disabled → `optional`.
- non-human gate/rail + enabled → `mandatory`; + disabled → `optional`.
- `locked` primitives are always `mandatory` and render a `LOCKED` badge (cannot be lowered).

## What `forge control` refuses, and why

- **`permission` on a non-human gate or rail** — refused: approval events only
  gate the three human gates; elsewhere `permission` has no enforcement path.
- **`optional` on a `locked` primitive** — refused: mirrors
  `Cannot disable locked gate` in `forge gate`.
- **Any `mcp.*` / `rule.*` / `skill.*` id** — refused with:
  *"<id> is presence-only, not enforceable — Forge has no run-time deny for this
  surface. See docs/reference/control-plane-guarantees.md."* These are read-only
  in the cockpit; their badge is `PRESENT (advisory)`, never `ENFORCED`.

## Badge vocabulary (what the read view / dashboard renders)

Driven entirely by the enforcement-locus column above — never by author intent:

- `ENFORCED (gate)` — run-time-deny (gate).
- `ENFORCED (rail)` — run-time-deny (rail).
- `PERMISSION (human approval)` — run-time-deny (permission).
- `PRESENT (advisory)` — render-time presence-only (mcp/rules/skills).
- `LOCKED` — a `mandatory`/`enforced` item that cannot be lowered.

A surface's badge reflects **where and whether** it is enforced, so the UI can
never imply enforcement it lacks.

## Deferred (out of B6 scope)

- **Control for advisory surfaces** (mcp/rules/skills). Deferred deliberately:
  making these "mandatory" requires a run-time deny path that does not exist.
  Until it does, they stay read-only + `PRESENT (advisory)`.
- **Live/SSE updates** — a separate stubbed issue; the read view is a
  point-in-time snapshot.
