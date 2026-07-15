# Control-plane guarantees — what each control state actually does

Status: beta (B6). Issues: `7dc59af2` (controls config + `forge control`),
`724356ea` (all-surface read + enforcement-locus badges). Epic: `363954dd`.

This document is the **contract** the cockpit badges and the `forge control`
command read from. It states, honestly and per surface, what a control state
*actually* does today — so the UI never sells enforcement Forge cannot deliver.

## Headline — the honest state of enforcement (as of 2026-07-15)

**The configurable gate/rail registry is NOT yet consumed by any runtime deny.**
An adversarial grep of every consumer of the resolved runtime graph found none
that refuses on `workflow.gates.<id>.enabled`. So setting a gate or rail to
`mandatory` vs `optional` today changes the **declared registry**, not runtime
behavior.

Real enforcement in Forge today lives **elsewhere, independent of these flags**:

- the **B3 lefthook TDD pre-commit hook** (blocks a commit that changes source
  without tests),
- **B2 fail-closed `validate` / `preflight`** (these fail closed on their own
  logic, *not* on `workflow.gates.<id>.enabled`),
- **`enforce-stage.js`** (blocks a stage on kernel-recorded stage **order +
  completion**, again independent of these flags).

Because of this, **`ENFORCED` is reserved strictly for a wired runtime deny —
and that set is EMPTY for these flags today.** The badges below never say
`ENFORCED`; they say what is actually true (`DECLARED`, `DENY-ON-CHECK`,
`VERIFY (warn-only)`, `PRESENT (advisory)`). Wiring the registry to real
enforcement points is filed as separate post-beta work.

## The two axes

- **State** (author intent, written to config): `mandatory` · `optional` · `permission`.
- **Enforcement-locus** (what actually happens today, and *where*):
  - `registry — declared, not yet enforced` — the flag is stored and reflected in
    the resolved graph, but **no runtime code consumes it to deny**. (stage-exit
    gates, rails)
  - `run-time verify (warn-only, never denies)` — consumed at run time, but only
    **warns**; never overturns the operation. (`gate.issue_verify`)
  - `deny-on-check (no chokepoint yet)` — a real, deny-**capable** primitive
    (`forge gate check`), but **no chokepoint auto-invokes it**, so nothing denies
    on it yet. (human gates)
  - `render-time presence-only` — written into harness config / discovered by
    precedence; nothing denies at run time. **Advisory.** (mcp / rules / skills)

## The matrix — state × surface × what it actually does today

| Surface | Example ids | Controllable by `forge control`? | State it takes | Enforcement-locus | What it actually does today |
|---|---|---|---|---|---|
| **Stage gate** | `gate.plan-exit`, `gate.dev-exit`, `gate.validate-exit`, `gate.ship-entry` | **Yes** | `mandatory` / `optional` | `registry — declared, not yet enforced` | Writes the declared value into the resolved graph. **No runtime consumer reads it** — `enforce-stage.js` blocks on stage order + kernel completion, which is independent of this flag. Setting mandatory/optional changes nothing at run time (yet). Badge: `DECLARED (no runtime consumer yet)`. |
| **Issue-verify gate** | `gate.issue_verify` | **Yes** | `mandatory` / `optional` | `run-time verify (warn-only, never denies)` | Consumed by `lib/commands/_issue.js`: after a kernel write it re-reads and emits `verified` + `mismatches`, but **warn-only** — a mismatch prints a warning and never overturns the write's `ok`. `optional` skips the read-back. Badge: `VERIFY (warn-only)`. |
| **Human gate** | `gate.intent`, `gate.plan-approval`, `gate.merge` | **Yes** | `permission` / `optional` | `deny-on-check (no chokepoint yet)` | The `forge gate approve` / `forge gate check` primitives are real and deny-**capable**: with the gate active, `forge gate check <issue> <id>` exits non-zero until a durable `gate.approved` event exists (`lib/gate-events.js`). But **no chokepoint auto-invokes `forge gate check`**, so nothing denies on it unless a skill/CI explicitly calls it. Badge: `DENY-ON-CHECK`. |
| **L1 rail** | `rail.kernel_tracking` (unlocked); other rails (locked) | **Yes** (unlocked only) | `mandatory` / `optional` | `registry — declared, not yet enforced` | Writes the declared value; the resolved graph reflects it. **No runtime refusal exists** — the flag is read only by `gate.js` id-maps, not by an enforcement chokepoint. Locked rails cannot be lowered. Badge: `DECLARED (no runtime consumer yet)`. |
| **MCP server** | `mcp.*` | **No — refused** | — | `render-time presence-only` | Rendered into harness MCP config. Presence advises the agent a tool exists; Forge does **not** deny at run time. Not enforceable. Badge: `PRESENT (advisory)`. |
| **Rule** | `rule.*` (`rules/*.md`) | **No — refused** | — | `render-time presence-only` | Injected as agent guidance. No run-time deny. Advisory. Badge: `PRESENT (advisory)`. |
| **Skill** | `skill.*` | **No — refused** | — | `render-time presence-only` | Discovered by precedence (`.skills/` > `skills/` > packaged). Presence, not enforcement. Advisory. Badge: `PRESENT (advisory)`. |

## How the tri-state maps onto Forge's real config (single source of truth)

The one config field `forge control` writes is **`workflow.gates.<id>.enabled`**
in `.forge/config.yaml` — the field the resolver (`applyEnabledConfig` in
`lib/core/runtime-graph.js`) consumes into the resolved graph, shared by gates
and unlocked rails (`gate.*` / `rail.*` namespaces are disjoint). `forge control`
reuses exactly this field — it does **not** add a parallel `controls:` key,
because a key nothing reads would be doubly-fake. The tri-state is the
*vocabulary*; `enabled` is the stored *truth*; state is **derived**, never stored
twice.

**Important:** writing this field changes the **declared registry** the read view
and `forge options` reflect. It does **not**, today, change what any runtime
chokepoint does (see the headline). The mapping:

| State | Config written | Applies to | Effect today |
|---|---|---|---|
| `mandatory` | `workflow.gates.<id>.enabled = true` | stage gates, rails | declared active in the registry; no runtime consumer denies on it |
| `optional` | `workflow.gates.<id>.enabled = false` | unlocked gates & rails | declared off; for `gate.issue_verify`, actually skips the warn-only read-back |
| `permission` | `workflow.gates.<id>.enabled = true` | human gates only | keeps the gate active, so `forge gate check` *can* deny if a chokepoint calls it (none does yet) |

Read-back derives the label from `(enabled, locked, isHumanGate)`:
- human gate + enabled → `permission`; human gate + disabled → `optional`.
- non-human gate/rail + enabled → `mandatory`; + disabled → `optional`.
- `locked` primitives are always `mandatory` and render a `LOCKED` badge (cannot be lowered).

## What `forge control` refuses, and why

- **`permission` on a non-human gate or rail** — refused: the approve/check
  primitive only applies to the three human gates; elsewhere `permission` has no
  path at all.
- **`optional` on a `locked` primitive** — refused: mirrors
  `Cannot disable locked gate` in `forge gate`.
- **Any `mcp.*` / `rule.*` / `skill.*` id** — refused with:
  *"<id> is presence-only, not enforceable — Forge has no run-time deny for this
  surface. See docs/reference/control-plane-guarantees.md."* These are read-only
  in the cockpit; their badge is `PRESENT (advisory)`.

## Badge vocabulary (what the read view / dashboard renders)

Driven entirely by the honest enforcement-locus above — never by author intent:

- `DECLARED (no runtime consumer yet)` — `registry — declared, not yet enforced`
  (stage-exit gates, rails).
- `VERIFY (warn-only)` — `run-time verify (warn-only, never denies)`
  (`gate.issue_verify`).
- `DENY-ON-CHECK` — `deny-on-check (no chokepoint yet)` (human gates).
- `OFF (optional)` — a controllable flag set to `optional`.
- `PRESENT (advisory)` — `render-time presence-only` (mcp/rules/skills).
- `· LOCKED` — appended to a locked primitive that cannot be lowered.
- `ENFORCED (...)` — **reserved for a wired runtime deny; emitted by NOTHING
  today** (the set is empty until the registry is wired to enforcement points).

A surface's badge reflects **where and whether** it is actually consumed, so the
UI can never imply enforcement it lacks.

## Deferred (out of B6 scope, filed separately)

- **Wire the configurable gates/rails to real enforcement points** — the bigger
  work that would let a `mandatory` gate/rail actually deny at run time. Filed as
  separate post-beta work; B6 deliberately does *not* attempt it. B6's deliverable
  is the honest vocabulary + matrix, not new enforcement.
- **Control for advisory surfaces** (mcp/rules/skills) — no run-time deny path
  exists; they stay read-only + `PRESENT (advisory)`.
- **Live/SSE updates** — a separate stubbed issue; the read view is a
  point-in-time snapshot.
