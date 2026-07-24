---
name: setup
description: >
  Forge install & setup lifecycle. `forge setup` interactively configures Forge for your
  coding agents; `forge init [--profile minimal|standard|full]` writes the
  adoption config in a fresh repo; `forge doctor` reports whether the kernel DB is on a
  cloud/network path; `forge upgrade [--dry-run]` previews + self-heals upgrade readiness;
  `forge hooks install --global` installs native hooks; `forge reset --soft|--hard --force`
  and `forge reinstall --force` undo/redo the install; `forge recommend` lists suggested
  tools. Use when the user says "install/set up forge", "init forge", "adoption profile",
  "forge doctor", "upgrade forge", "install the hooks globally", or "reset/reinstall forge".
  Footguns: setup is interactive — pass `--yes` in automation; `doctor` only checks the
  kernel-DB filesystem class, NOT general health; `upgrade` self-heals Forge state, NOT the
  npm package; reset/reinstall need `--force`. NOT toggling a gate/rail (gates), NOT
  orienting in a set-up repo (status), NOT installing project deps (dev).
allowed-tools: Bash, Read, Grep, Glob
terminal: true
---

Getting Forge installed, configured, upgraded, and diagnosed in a repo. These are the bootstrap and maintenance commands — distinct from the everyday workflow stages.

# Install & configure

```bash
forge setup                      # interactive agent configuration (Claude/Cursor/Codex …)
forge setup --yes                # non-interactive: accept defaults (use this in automation)
forge setup --agents claude,cursor --skip-external   # target specific harnesses, skip service prompts
forge setup --path <dir> --dry-run                   # preview against another dir, write nothing
```

`forge setup` is **interactive by default**. In any automated/agent context pass `--yes` (or `--non-interactive`) so it never blocks on a prompt.

# Initialize a fresh repo

```bash
forge init --minimal             # shortcut for --profile minimal --yes
forge init --profile standard --harness claude,cursor
forge init --classification standard --dry-run       # preview the adoption config
```

`forge init` writes the Forge adoption config (`.forge/config.yaml`). The profile picks how much enforcement ships on: `minimal` (rails off) → `standard` → `full`. This configures the workflow; toggling an individual gate afterward is the **gates** skill.

# Diagnose

```bash
forge doctor            # is the kernel DB on a cloud-synced / network path? (reliability signal)
forge doctor --json     # machine-readable
```

`forge doctor` is **narrow**: it reports the filesystem class of the Forge kernel database path (local / cloud-synced / network) so you can catch the reliability footgun of running the DB on OneDrive/Dropbox/a network share. It is **not** a general health check.

# Upgrade readiness

```bash
forge upgrade --dry-run    # preview the planned self-heal, change nothing
forge upgrade              # apply safe self-heal steps to make the repo upgrade-ready
```

`forge upgrade` previews and applies **safe self-heal** steps for Forge's own state. It does **not** update the installed npm package — use your package manager for that.

# Global hooks

```bash
forge hooks install --global                       # install native hooks for all harnesses
forge hooks install --global --harness codex       # scope to one harness (codex|hermes|all)
forge hooks install --global --dry-run             # preview
```

`--global` is the required consent flag — it opts you into installing hooks at the user level. (The other `forge hooks` subcommands — `session-start`, `inbox-pickup`, `shepherd-events`, `memory-recall`, `capture` — are machine-facing hook emitters the harness calls, not things you run by hand.)

# Undo / redo the install

```bash
forge reset --soft --force     # remove .forge/ config only (keeps commands, rules, agents)
forge reset --hard --force     # remove ALL forge-managed files (keeps user-created files)
forge reinstall --force        # remove + re-run default setup in one step
```

`reset` and `reinstall` are destructive, so `--force` is required. `reset` with no `--soft`/`--hard` just prints usage.

# Recommend tooling

```bash
forge recommend         # suggest tools/integrations for the current project
```

## Boundaries

- Toggling a single gate/rail (e.g. TDD, kernel-tracking) is **gates** — `init` *writes* the initial config; `gates` *flips* one afterward.
- "Where am I / how is forge set up" in an already-configured repo is **status** / **kernel**, not setup.
- Installing project dependencies (`bun install`) is **dev**, not `forge setup`.
