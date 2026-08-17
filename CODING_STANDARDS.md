# Coding Standards (read at review time)

This file is **not** loaded every turn. It is read by the review step — the
`/review` stage, the `code-review` skill, and any human or bot reviewing a diff —
and nowhere else. Everything here is a property a reviewer can check **by reading
the diff**. Rules about how an agent shapes its turn (arm the shepherd, work in a
worktree, don't stall, don't poll on a fixed timer while waiting) live in
[AGENTS.md](AGENTS.md), because no diff shows them.

**How to add to it:** when you catch an agent (or yourself) doing something wrong
in a change, add one line here, stated positively, with an evidence tag naming
where the evidence came from — `[mined: <cluster> ×N]` for the transcript-mining
counts, `[git: <pattern>]` for repository history, `[incident: <what happened>]`
for a single concrete failure. No rule without evidence; delete a rule when its
evidence stops recurring.

---

## Scope

1. Every file in the diff is one the originating issue or design doc named; an
   unrelated fix found along the way gets its own issue and its own PR.
   `[mined: scope creep — unrelated fixes into the PR ×6]`
2. A follow-up noted in the diff cites a kernel issue id, not a bare `TODO` or
   `FIXME`. `[mined: discussed work not filed as kernel issue ×3]`

## Gates and tests

3. A failing check is fixed at its cause; the diff does not raise a timeout,
   add a skip, loosen a threshold, or replace a real assertion with a vacuous
   one to get green. `[mined: weakening gates/tests to pass ×3]`
4. Tests synchronize on an observable condition (poll until true, await the
   event), never on a fixed sleep or timer duration.
   `[mined: waiting a fixed 10 min when reviewers already settled ×2]`
5. A new or moved source path that needs targeted tests lands in both the
   targetability checks in `scripts/test.js` and the `DIRECT_TEST_CANDIDATES`
   mapping in `lib/commands/test.js`, so it does not silently fall into the
   full-suite lane.
   `[mined: slow test/CI lanes accepted as normal ×3]` `[git: 13 fix commits touch scripts/test.js]`

## Generated artifacts and single source of truth

6. Skills are edited in the canonical `skills/` tree and mirrors are regenerated
   by `scripts/sync-agent-skills.js`; the diff never hand-edits `.agents/skills/`
   or another generated mirror.
   `[mined: duplicating skills per agent instead of skill-CLI generation ×4]`
   `[incident: recurring skills-sync-drift failures]`
7. Adding, deleting, or renaming a `lib/commands/*.js` file includes the
   regenerated command manifest (`scripts/gen-command-manifest.js`) in the same
   diff. `[git: 24 fix commits touch bin/forge.js, 15 touch lib/commands/setup.js]`

## Product boundary

8. Issue authority reads and writes go through the kernel; the diff adds no code
   path that treats Beads or Dolt as a live backend.
   `[mined: treating beads as live backend ×5]` `[decision: D45 retires Beads as a live feature]`
9. Shipped code discovers its own paths and config; no maintainer machine path,
   local username, or personal directory appears in a committed file.
   `[incident: hardcoded C:\Users\<user>\Downloads\forge in .claude/settings.json]`
10. A new runtime asset the installed package needs is added to the `files`
    allowlist in `package.json` in the same diff.
    `[incident: protected-paths.yaml missing from the npm files allowlist]`
11. PR-monitoring capability is wired into the substrate — a hook, the ship
    path, or a gate — not left as a step someone must remember to invoke.
    `[mined: shepherd not armed/auto-attached on ship ×10]`

## Repository hygiene

12. Machine-local runtime state (per-session caches, saved PR diffs, symlinks
    into worktrees, stray shell artifacts, and transient kernel .export.lock /
    .tmp-* files) is gitignored, never committed. Deterministic .forge/kernel/
    JSONL and manifest projections are tracked export/import artifacts. `[git: triage 2026-08-15 found NUL, gw/, .hermes/, .forge/kernel/, pr*.diff untracked at repo root]`
