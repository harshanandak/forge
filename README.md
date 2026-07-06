# Forge

[![npm version](https://img.shields.io/npm/v/forge-workflow.svg)](https://www.npmjs.com/package/forge-workflow)
[![license](https://img.shields.io/npm/l/forge-workflow.svg)](https://github.com/harshanandak/forge/blob/master/LICENSE)
[![Tests](https://github.com/harshanandak/forge/actions/workflows/test.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/test.yml)
[![ESLint](https://github.com/harshanandak/forge/actions/workflows/eslint.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/eslint.yml)
[![Coverage](https://img.shields.io/badge/coverage-80%25-brightgreen.svg)](https://github.com/harshanandak/forge)
[![Package Size](https://github.com/harshanandak/forge/actions/workflows/size-check.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/size-check.yml)
[![CodeQL](https://github.com/harshanandak/forge/actions/workflows/codeql.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/codeql.yml)
[![Security Policy](https://img.shields.io/badge/security-policy-blue.svg)](https://github.com/harshanandak/forge/blob/master/SECURITY.md)

## Never lose the thread of AI-assisted work.

Coding agents are fast — and forgetful. Sessions break. Context resets. The
agent forgets what it was doing, issues pile up untracked, and three months
later you can't reconstruct why a change was made or what's still unfinished.
Every new agent needs its own setup, and none of them share what the last one
knew.

**Forge fixes that.** It's an agent-agnostic control plane that gives your
coding agent — and you — a shared, durable memory of the work: issues,
dependencies, workflow state, decisions, and validation evidence, all kept in
your repo. Hand work to any agent, walk away mid-task, come back on another
machine, and pick up exactly where you left off.

```bash
npx forge setup     # install for your agent (Claude Code, Codex, Cursor, Hermes)
npx forge init      # configure your workflow gates + change classification
npx forge status    # one-glance: where you are, what's next, what's ready
```

## Why Forge

### 🧵 Break anywhere, continue anywhere
Your project state lives in the repo, not in a chat window. Workflow stage,
claimed work, issues, memory, and handoff context survive session resets,
context compaction, and machine switches. Any agent reads the same source of
truth through `forge status`, `forge prime`, and `forge orient` — so a session
that dies at 2am resumes cleanly the next morning, on any device, with any
agent.

### 🔎 Never lose track — down to the smallest thing
Forge ships a local issue **kernel** plus a project **memory** system. Capture
work the moment you spot it, wire up real dependencies, and everything stays
tracked: what's ready, what's blocked, what's stale, what's done. Searchable and
recoverable — find work from *months* ago in seconds instead of digging through
old branches and chat logs.

```bash
forge create --title "Fix flaky auth test" --type bug
forge issue dep add <blocker-id> <blocked-id>   # model real dependencies
forge ready                                     # what can I pick up right now?
forge remember "auth uses rotating JWT — see lib/auth.js"   # write memory
forge recall auth                               # read it back, later, anywhere
```

### 🤝 Works with your agent, not against it
Claude Code, OpenAI Codex, Cursor, and Hermes today — more to come. Forge is
agent-agnostic: one `forge` command surface and one shared project state that
every agent understands. No lock-in, no per-agent reinvention.

### 🛠️ A workflow you own
Forge installs a proven **TDD-first** workflow —
`/plan → /dev → /validate → /ship → /review` by default, with `/verify` added in
the profiles that need it — but it is *not* a fixed
prompt pack. Every stage and quality gate is configurable: turn gates on or off,
change your change-classification, adapt the stages to how your team actually
works, and update it as you grow. The default makes you productive on day one;
the controls are yours from day two.

## Who it's for

- **Solo builders** using AI agents who are tired of lost handoffs and
  half-remembered context.
- **Teams** coordinating multiple agent or developer sessions in one repo.
- **Quality-conscious engineers** who want agent output they can review, trust,
  and release — grounded in local evidence, not vibes.
- **Maintainers** keeping agent-authored work safe enough to resume and ship.

## Quickstart

```bash
# Add to your project
bun add -D forge-workflow          # or: npm install --save-dev forge-workflow

# Install for your agent(s) and configure the workflow
bunx forge setup --agents claude --yes
bunx forge init --profile minimal --classification standard --yes

# Orient — for you and your agent
bunx forge status                  # human one-glance view
bunx forge prime                   # session-entry orientation for agents
```

Full guides:

- [Quickstart](QUICKSTART.md) — clean first run, step by step
- [Setup guide](docs/guides/SETUP.md)
- [Support and troubleshooting](docs/guides/SUPPORT.md)
- [Command reference](docs/reference/COMMANDS.md)
- [Workflow templates & customization](docs/guides/WORKFLOW_TEMPLATES.md)

Use `forge init` for the `.forge/` runtime config (gates + classification). Use
`forge setup` to install agent instructions, skills, and agent-specific files.
Use `bunx forge ...` (or `npx forge ...`) until the `forge` bin is on your PATH.

### Setup flags

| Flag | Use |
| --- | --- |
| `--agents claude,cursor` | Install for specific agents (or `--all` for every harness). |
| `--quick` | Use sensible defaults with minimal prompts. |
| `--yes` / `--non-interactive` | Run without prompts; `CI=true` also enables non-interactive behavior. |
| `--dry-run` | Preview planned writes without touching the repo. |
| `--symlink` | Link instruction files instead of copying, where supported. |
| `--merge smart\|preserve\|replace` | Choose how setup handles existing instruction files. |
| `--sync` | Deprecated. Removes old generated Beads/GitHub sync files; future issue sync belongs to Kernel/server authority. |

## What you get

- **Issue kernel** — `forge create`, `forge ready`, `forge show`, `forge claim`,
  `forge close`, `forge issue dep`, `forge blocked`, `forge stale`. The Kernel is
  the default backend; a Beads store can be imported (below) or selected as an
  opt-out backend with `--issue-backend beads`.
- **Project memory** — `forge remember` / `forge recall` for durable, searchable
  notes that outlive the session (no scattered `MEMORY.md` files).
- **One-glance state** — `forge status`, `forge board`, `forge orient`,
  `forge prime`, `forge recap` for humans and agents.
- **Safe, isolated work** — `forge worktree create <slug>`, `forge clean`.
- **Configurable quality gates** — `forge validate`, `forge push` (branch
  protection + lint + tests), tuned per project via `forge gate` and
  `forge init`.
- **Ship & recover** — `forge ship`, `forge review`, `forge shepherd` (bounded PR
  monitor), `forge merge` (opt-in conditional auto-merge, off by default),
  `forge upgrade` (safe self-heal).
- **Coming from Beads?** `forge migrate --from beads` imports your existing issue
  store into the Kernel in one command (`--dry-run` to preview first); the first
  kernel use also auto-imports a detected Beads store, so nothing is lost.

## Common commands

```bash
forge --help
forge status                 # where am I, what's next
forge ready                  # available work
forge show <issue-id>
forge claim <issue-id>
forge remember "<note>"      # write project memory
forge recall <query>         # read it back
forge worktree create <slug>
forge board --json
forge validate
```

Stage commands such as `/plan`, `/dev`, `/review`, and `/verify` are agent
workflow stages installed by `forge setup`. Pre-merge is a documentation-and-
handoff gate embedded in `/ship` and `/review`, not a separate stage.

## Documentation map

- [Docs index](docs/INDEX.md) — canonical reading order
- [Migration guide](docs/guides/MIGRATION.md) — moving to the Kernel and current workflow framing
- [Workflow templates & customization](docs/guides/WORKFLOW_TEMPLATES.md) — the default workflow and how to change it
- [Skills and command projections](docs/reference/SKILLS.md)
- [Adapters](docs/reference/ADAPTERS.md) — review adapter contract
- [Protected state surfaces](docs/reference/protected-state-surfaces.md)
- [Release reference](docs/reference/RELEASE.md)

## Terms

- **Control plane** — local commands, files, and checks that give agents a shared operating surface.
- **Kernel** — the default local issue-state store, backing `forge` issue commands.
- **Workflow template** — the default stage path Forge installs (`/plan → /dev → /validate → /ship → /review`, with `/verify` in the profiles that need it), fully configurable.
- **Harness** — an agent-specific instruction surface. Forge supports Claude Code, Codex, Cursor, and Hermes.
- **Memory** — durable, searchable project notes written with `forge remember` and read with `forge recall`.
- **Adapter** — an integration boundary for review or issue tools.
- **Protected state** — files that should be changed through their owning command or API, not by casual edits.

## Package

Package name: `forge-workflow`

Binary names: `forge`, `forge-workflow`, `forge-preflight`

## License

MIT
