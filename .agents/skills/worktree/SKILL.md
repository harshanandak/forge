---
name: worktree
description: >
  Forge's worktree lifecycle. `forge worktree create <slug>` makes an isolated checkout
  under `.worktrees/`, creates its branch (feat/<slug>), links a kernel issue (`--issue`),
  and installs dependencies — all in one step; `forge worktree list`/`remove <slug>` manage
  them; `forge clean` removes worktrees whose branches already merged (squash-aware) and
  fast-forwards the default branch. Use when the user says "work on this in an isolated
  branch/worktree", "spin up a worktree", "parallel work on another PR or issue", "clean up
  merged worktrees", or "why did my worktree miss its dependencies". Footgun it prevents:
  raw `git worktree add` only creates a branch — it skips the issue link and dep install —
  so always use `forge worktree create`; and `forge clean` is cwd-scoped, run it from the
  primary repo root, never inside a worktree. NOT for opening/pushing a PR or the branch
  (ship), NOT for planning a feature (plan), NOT the stages that create a worktree as one
  step — this is the worktree lifecycle itself.
allowed-tools: Bash, Read, Grep, Glob
terminal: true
---

Forge worktrees give a task its own isolated checkout so concurrent work never collides on `HEAD` or a shared branch. Use `forge worktree`, not raw `git worktree add` — the Forge command does the extra setup that a bare branch add skips.

# Worktree lifecycle

## When to use

- "Work on this in an isolated branch / worktree", "spin up a worktree for this".
- Parallel work: a second PR or issue you want to develop without disturbing the current checkout.
- "Clean up the merged worktrees" — reclaim worktrees whose branches already landed.
- Diagnosing "why did my new worktree miss its dependencies / node_modules".

This skill is the **worktree lifecycle itself**. The `plan`/`ship` stages may create a worktree as one internal step, but managing worktrees directly — create, list, remove, clean — is this skill.

## Create

```bash
forge worktree create <slug>
```

Creates the worktree at `.worktrees/<slug>` and, in one step:

- creates its branch (default `feat/<slug>`),
- links a kernel issue to the worktree when `--issue <id>` is given (records issue → worktree),
- installs dependencies with the repo's detected package manager (bun/pnpm/yarn/npm).

Flags:

| Flag | Purpose |
| --- | --- |
| `--branch <name>` | Custom branch name (default `feat/<slug>`). |
| `--base <ref>` | Base ref the new branch forks from (default the repo default branch, e.g. `origin/main`). |
| `--issue <id>` | Kernel issue id to link this worktree to. |
| `--work-folder <path>` | Repo-relative work-folder this issue owns (drops a `.forge-issue` marker). |

The kernel issue store lives in the git common dir that every worktree shares, so a new worktree already sees the same kernel — no per-worktree issue-store bootstrap is needed.

## The footgun this skill prevents

**Never use raw `git worktree add`** for Forge work. It only creates a branch + checkout — it does **not** link the kernel issue and does **not** install dependencies. A worktree made that way is why deps end up missing. Always use `forge worktree create`.

## List / remove

```bash
forge worktree list              # read the worktree registry from the kernel
forge worktree remove <slug>     # git worktree remove for that slug
```

## Clean merged worktrees

```bash
forge clean                      # remove worktrees whose branches merged; FF the default branch
forge clean --dry-run            # show what would be removed, change nothing
```

`forge clean` is **squash-aware** — it detects branches that merged via squash, not just fast-forward merges.

### `forge clean` footguns

- **cwd-scoped.** Run it from the **primary repo root**, never from inside a `.worktrees/<slug>` checkout. There is no default-branch guard, so a bare run from the wrong place can remove a clean checkout.
- **Fast-forward the local default branch first** so squash-merge detection sees the merged state.
- **Windows long paths.** `node_modules` inside a worktree can exceed the Windows path limit; if `git worktree remove --force` de-registers the worktree but the directory lingers, delete it with a PowerShell extended-path (`\\?\`) remove.

## Adjacent skills

- Opening or pushing a PR / the branch → `ship`.
- Planning a feature (which may create a worktree as a step) → `plan`.
- Watching an open PR toward merge → `shepherd`.
- Everyday issue create/update/close → `issue-basics`.
