---
name: smith
description: >
  The flagship Forge orchestrator: given a goal or a ready issue, it composes the
  stage skills (triage-ready · claim-safety · plan · dev · validate · ship · review
  · verify) into the right path for the work, running autonomously between human
  gates and pausing at them. Use this whenever the user wants to work the next ready
  issue, drive a feature or fix end-to-end, "take this through to a PR", orchestrate
  the whole workflow with human checkpoints, or asks some form of "what should I
  work on and get it done" — even if they never say "smith" or "orchestrate". Reach
  for it especially when the request spans multiple stages (plan → build → ship) or
  asks to keep a human in the loop at intent, plan, or merge. Prefer a single stage
  skill only when the user explicitly wants just that one step (e.g. "just open the
  PR").
allowed-tools: Read, Bash(forge:*)
terminal: true
subskills:
  - plan
  - dev
  - validate
  - ship
  - review
  - verify
---

# Smith — the orchestrator super-skill

Smith is a thin orchestrator. It adds no stage behaviour of its own; every step
below is an existing skill or `forge` verb. What smith contributes is *judgement*:
which path to take for this piece of work, and how densely to involve the human.
It is maximally driving between gates and deliberately stops at them — the goal is
conversational autonomy, not unattended autonomy.

Keep the word "kernel" internal — it is the event store under the hood, not a
term users should see.

Deeper lookup tables live in
[references/autonomy-and-gates.md](references/autonomy-and-gates.md): read that
when you calibrate a specific issue or need the exact gate IDs and commands.

## The orchestration procedure

1. **Pick the work with `triage-ready`.** Rank the ready queue
   (`forge issue ready --json`) and explain why the top pick is genuinely
   workable. Readiness is a *derived* model, so recompute it each time rather than
   trusting a remembered "ready" — you want the item that is actually unblocked
   now, not a stale guess. Hand off one issue.

2. **Claim it, then prove you own it, with `claim-safety`.**
   `FORGE_ACTOR=<actor> forge claim <id>`, then `forge issue owns <id>` (exit 0 =
   owned). A claim returning `ok:true` is not proof — a duplicate replay returns
   `ok:true` too, and a live lease can be reclaimed once it expires. Proving
   ownership is what stops two agents from quietly working the same issue. If you
   are not the owner, don't work it; reselect via `triage-ready`.

3. **Calibrate autonomy during planning.** Read the issue's size × importance ×
   complexity, map it to a tier (lean / standard / high), and *propose that tier
   directly to the human* — a short "here's how much oversight I think this needs."
   This proposal is a plain conversational checkpoint at the start of planning; it
   is deliberately **not** itself one of the enforcement gates, so it stays reachable
   even for the Lean tier (which may require no intent gate at all). The human
   confirms or overrides, and the chosen tier decides **which enforcement gates you
   require approval for on this issue** (step 5). Keep the two mechanisms distinct:
   `forge gate enable|disable <gate>` is the **repo-wide default** (a gate the user
   turned off is always skipped), whereas the per-issue tier is *your* runtime
   decision about which of the still-enabled gates to actually require for this one
   issue. Matching checkpoint density to stakes is the whole point: a docs typo
   should not drag through a full brainstorm, and a risky refactor should not run
   unattended. When your read is uncertain, lean toward *more* gates — an extra
   approval costs seconds, a missing one can cost a lot of rework. See the
   reference for the tier → gate mapping.

4. **Drive the stages along the path that fits.** Sequence
   `plan → dev → validate → ship → review → verify`, invoking each stage skill as
   its step arrives. The stage skills already encode the TDD, validation, and
   review discipline, so smith's job is only to pick the path by change
   classification (critical / standard / simple / hotfix / docs / refactor): a docs
   typo skips brainstorming and most of the ladder; a critical feature runs the
   full ladder.

5. **Stop at every enabled human gate.** Before advancing past a gate, run:

   ```bash
   forge gate check <issue> <gate>     # exit 0 iff the gate is disabled or approved
   ```

   On exit 0, proceed. On non-zero, stop and ask the human to
   `forge gate approve <issue> <gate> [--reason "…"]` (or
   `forge gate reject <issue> <gate> --reason "…"` to send it back); inspect
   history any time with `forge gate status <issue>`. Approvals are recorded as
   durable events, which is what lets smith re-check and continue after a crash or
   compaction instead of re-asking. The three human gates are `gate.intent`,
   `gate.plan-approval`, and `gate.merge` (details in the reference).

6. **Re-prove ownership and check readiness before closing.** A lease can expire
   and be reclaimed while you work, so run `forge issue owns <id>` again before you
   close — you don't want to close someone else's issue. Then confirm the tree is
   actually shippable:

   ```bash
   forge release check --target <version> --json   # success:true ⇒ healthy
   ```

   Close only when ownership holds and readiness is healthy
   (`forge close <id> --reason "…"`), then `forge sync`.

## Autonomy tiers at a glance

Full table and the reasoning are in the reference; the short version:

- **Lean** — small · simple · low-importance work: enforce just `gate.merge`, or
  run under CI with the human gates disabled.
- **Standard** (default) — an ordinary feature/bug: enforce `gate.intent`,
  `gate.plan-approval`, and `gate.merge`.
- **High** — large · important · or complex work: enforce all three, plus
  per-milestone check-ins and a pre-ship pass.

The tier is a **per-issue** decision: smith requires `check`/approval only for the
gates its tier calls for on *this* issue and simply skips the rest — it does not
toggle repo config per issue. Separately, `forge gate disable <gate-id>` is the
**repo-wide** off switch (a disabled gate makes `check` fall through for *every*
issue) — use it when the user never wants that checkpoint at all. So a lean run
skips a checkpoint by not requiring it for this issue; disabling a gate removes it
everywhere.

## Reliability

- **The human always wins, and uncertainty adds oversight.** Smith proposes a
  tier; it never lowers the human-loop density on its own, and a rejected gate
  sends the work back rather than proceeding.
- **Re-check gates on resume.** After any interruption, trust the recorded events
  (`check` / `status`), not your memory of what was approved.
- **Prove ownership twice** — after claiming and again before close/release.
- **Never bypass a gate or a hook.** A failed gate or failing hook is a stop to
  resolve, not an obstacle to route around (no `LEFTHOOK=0`, no `--no-verify`).

## Fork points

Smith is a default assembly, not a fixed ladder — re-carve it:

| Knob | Default | How to change |
|------|---------|---------------|
| **Stakes heuristic** | size × importance × complexity → tier | Re-weight it (e.g. weight blast-radius or reversibility higher), or map your own change-classes to tiers. |
| **Tier → gate set** | lean / standard / high (see reference) | Change which human gates each tier enforces; enact per repo with `forge gate enable\|disable <gate-id>`. |
| **Gate density** | intent · plan-approval · merge | Add a checkpoint (enable a gate or add a per-milestone pause) or drop one (disable it); the human overrides smith's proposal at `gate.intent`. |
| **Composed flow** | triage → claim → plan → dev → validate → ship → review → verify | Skip stages by change class (docs typo → doc-only path), reorder, or swap in your own `plan`/`dev`/`review` adapter. |
| **Release target** | `forge release check` default | Pass `--target <version>` for the release you are certifying. |

Smith is the assembled hammer; the sub-skills are the head and handle; the gates
are the grip adjustments. Ship a good default, then let users re-carve it.
