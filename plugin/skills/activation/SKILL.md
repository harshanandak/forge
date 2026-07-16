---
name: activation
description: >
  Forge's front door — invoke FIRST when starting work in a project that has Forge
  available but you are not yet oriented: no `.forge/` yet, a fresh session, or the
  user says "/activation", "set up Forge", "start Forge", "is Forge active here?".
  Orients on the actual repo (detects project type, states findings) BEFORE offering
  anything, then offers the bare-minimum gates-disabled setup WITHOUT forcing it.
  Do NOT use this to run a specific stage (use /plan, /dev, /status, /ship directly)
  or once `.forge/` is already initialized and you know the workflow.
allowed-tools: Bash, Read, Grep, Glob
---

# Forge activation (front door)

You are orienting a project where Forge is available (installed as a global plugin
or an npm dev-dep) but not yet engaged. Your job is to **orient first, then offer —
never force**. This skill creates nothing by itself; a mutating `forge` verb is what
lazily initializes `.forge/`.

## Orient first (state findings BEFORE offering)

Run read-only checks, then STATE what you found in one short paragraph before you
offer any setup. Do not opine or prescribe before you have looked.

1. **Is Forge initialized?** `test -d .forge && echo present || echo absent`
2. **What kind of project is this?**
   - `package.json` present → JS/TS project (note the package manager: bun/npm/pnpm/yarn lockfile).
   - Markdown-heavy, no `package.json` → docs / planning repo.
   - Otherwise → describe what you see (language, build files).
3. **Is it a git repo?** `git rev-parse --is-inside-work-tree 2>/dev/null`

Then say, in your own words: *"Here's what this project looks like today: …"* —
project type, whether `.forge/` exists, git status. Only after stating this do you
offer anything.

## Then offer the bare minimum (never forced)

Present setup as a conversational choice, not a mandate:

- **If `.forge/` is absent:** explain that Forge needs no setup step to be useful —
  read-only verbs (`forge status`, `forge ready`, `forge show <id>`) work immediately
  and write nothing. The first *mutating* verb (`forge claim`, `forge create`,
  `forge remember`) lazily creates a **bare-minimum, gates-disabled** `.forge/`
  skeleton. Nothing heavier (git hooks, lefthook, protected paths, `.mcp.json`,
  scripts tree) is installed unless the user later runs `forge setup`.
- **If `.forge/` is present:** say so and route to the right stage instead — this
  skill's work is done.

Offer, then stop and let the user choose. Do not run `forge setup` or install hooks
on their behalf unless they ask.

## Terminal state → next step

This is a front-door primitive, not the full workflow. After orienting and offering:

- **New / unscoped work** ("let's build X") → the one next step is **`/plan`**.
- **A known task to implement** → **`/dev`**.
- **"Where am I / what's ready?"** → **`/status`** or `forge ready`.
- **A bug or failure** → **`systematic-debugging`**, then the matching stage.

Name the single next step explicitly and hand off. Do not implement here.
