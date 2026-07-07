---
description: "Always: file every issue, idea, bug, and decision to the Forge Kernel"
alwaysApply: true
globs: []
---

# Kernel Tracking (nothing discussed goes missing)

**NON-NEGOTIABLE.** Anything raised in a session — a bug, an idea, a design
decision, a follow-up, a TODO, a risk you noticed in passing — MUST become a
Forge Kernel issue **immediately**, before it can be forgotten. This is a
structural rule, not a judgment call.

- Found or discussed something trackable? Run `forge issue create` right then —
  do not wait for "later" or the end of the session.
- Triage it: set a type and link it to its epic/parent so it is discoverable.
- Deferring work? File the follow-up issue and reference it — never leave scope
  cuts unfiled.
- The Kernel is the single source of truth. Do NOT use TodoWrite, markdown TODO
  lists, or memory notes as a substitute for a filed issue.

This rule is a **thin pointer** — the authoritative workflow contract lives in
`AGENTS.md` (see "Forge Issue Tracker") and the stage skills in
`skills/<stage>/SKILL.md`. It is default-on and governed by the
`rail.kernel_tracking` runtime rail (`forge gate disable rail.kernel_tracking`
to turn it off). Do not duplicate policy here.
