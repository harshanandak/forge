# Comment-back — compliant kernel inbox + supported-hook pickup

- **Issues:** `e244f12d-e306-4490-9db4-17ea24ab4625` (forge inbox verb + digest pickup),
  `6d10c1a1-d57f-45f4-ad10-ff24c4fd55a4` (targeted delivery). **Epic:** `363954dd`.
- **Date:** 2026-07-13
- **Type:** Standard (new feature, additive, fail-open)

## Compliance boundary (READ FIRST — non-negotiable)

This is the **SUPPORTED, Anthropic-compliant** "comment back to the agent" loop. It is
verified against the Anthropic Usage Policy and Claude Code hooks docs (see the
compliance-boundary comment on kernel issue `6d10c1a1`, 2026-07-13).

**The ONLY mechanism is: kernel data + supported Claude Code hooks reading the user's own data.**

- The dashboard / CLI **EDITS THE KERNEL** — it writes a comment through the existing
  broker comment path (a data-management operation via a `forge` verb).
- The user's **own, human-driven interactive Claude Code session READS that data** via
  supported hooks (`SessionStart`, `UserPromptSubmit`) on its **next natural turn**. The
  agent is human-driven; nothing is automated on the agent's behalf.
- This rides the turn that is already happening → **zero extra token cost**, no headless
  or API-billed invocation is ever spawned to deliver a comment.

**NEVER, under any circumstance, in this feature:**

- inject into a running session's stdin / tty, pipe input, or drive the agent
  programmatically (an unsupported input path — open Claude Code GH issues 6009/15553 —
  and a Usage-Policy gray zone for subscription/OAuth auth);
- spawn an automated/headless invocation to deliver a comment.

There is deliberately **no stdin/tty-writing code** anywhere in this feature. If a
real-time or team/production automation tier is ever wanted, it must use **API-key auth**
(metered, explicitly permitted) — never the subscription — and be confirmed with
Anthropic support first. That is out of scope here.

## What ships

Everything is a `forge` verb plus **official hooks** (nothing under `.claude/*` beyond the
rendered hook config).

### 1. `forge inbox` verb (`lib/commands/inbox.js` + `lib/inbox.js`)

- `forge inbox` — list UNACKED, instruction-tagged kernel comments **targeted at this
  session**, across the issues this session holds the active claim on, plus a standing
  auto-created `dashboard-inbox` chore issue for board-level / unscoped comments.
- `forge inbox --json` — machine-readable envelope for the dashboard / scripts.
- `forge inbox ack <comment_id>` — posts an `ack:<comment_id>` reply comment (through the
  same broker comment path) on the instruction's issue, closing the thread.

Comments are written by the dashboard through the **existing kernel comment path**
(`forge comment <issue> "<body>"`) tagged `origin:dashboard` + `actor:human` (carried on
the mutation event). Instruction identity is additionally encoded as a **body marker**
(`[forge:instruction]`) so read-side detection is reliable regardless of whether
actor/origin survive a projection round-trip. Ack replies use the `ack:<comment_id>` body
convention.

### 2. Targeting — how the session is resolved

A dashboard comment on issue X is targeted at whoever holds the **active kernel claim** on
X. The running session resolves its own identity from `FORGE_ACTOR` / `FORGE_SESSION_ID` /
worktree (basename of the current worktree, matching how `forge claim` stamps
`worktree_id`) and matches it against `forge claims --json`
(`actor` + `session_id` + `worktree_id`):

- **session basis** — both sides carry `session_id` → exact match (the precise signal);
- **worktree basis (honest fallback)** — claim `session_id` is null (common today; claim
  session fields are often unpopulated per the dashboard-consumer-seams memory) → route by
  `actor` + `worktree_id`, labeled best-effort;
- **actor basis (floor)** — neither session nor worktree is available → actor-only match,
  labeled best-effort.

Unscoped / board-level comments live on the `dashboard-inbox` chore issue and surface to
every session (basis `board`). Populating `kernel_claims.session_id`/`worktree_id` at claim
time (issue `6d10c1a1` item a) is a **separate follow-up**; this feature works correctly
today via the honest worktree/actor fallback and upgrades automatically once session
fields are populated.

### 3. Digest pickup — SessionStart (`lib/memory-digest.js`)

`collectDigestData` gains a **third source**, `fetchInbox`, beside notes and issues. Pending
targeted inbox comments become a third digest section (priority 5 — a fresh human directive
outranks stale notes and the agent's own issue list), **fenced via
`fenceUntrusted({ source: 'dashboard-comment' })` AFTER budget truncation** (so the close
marker always survives) and budget-capped by `applyBudget`. Pending comments therefore
surface at SessionStart through the existing `memory-inject` hook — no new hook needed for
the session-start tier.

### 4. Near-real-time tier — UserPromptSubmit (`lib/hook-renderer.js` + `lib/commands/hooks.js`)

A new `inbox-pickup` **context intent** (kind: context, fail-open) is added to
`FORGE_HOOK_CONTRACT`. Claude renders it on `UserPromptSubmit`, so pending instructions
surface on **each prompt** (near-real-time while the user is actively working — Claude's
live-ish tier). `forge hooks inbox-pickup --harness claude` emits the same fenced
(`source: dashboard-comment`) digest as `{ hookSpecificOutput.additionalContext }`.

Honest capability matrix (`USER_PROMPT_SUBMIT_SUPPORT`): only Claude has a verified
UserPromptSubmit context surface. Cursor (`no-user-prompt-surface`), Codex
(`global-config`), and Hermes (`global-config`) carry explicit, tested **skip reasons** —
no faked parity.

## Fail-open guarantees

Every read path is best-effort: a failing claims read, comment read, or missing
`dashboard-inbox` issue degrades to "no pending comments". The hooks never throw and never
emit malformed JSON — a broken digest never blocks a session or a prompt.

## The done-loop

dashboard writes instruction comment → session's next turn (SessionStart digest /
UserPromptSubmit) surfaces it, fenced as data → agent acts → `forge inbox ack <id>` posts
the ack reply → dashboard sees the thread closed. It is the PR-review-comment loop in
reverse, on kernel rails — with zero automated access to the agent.
