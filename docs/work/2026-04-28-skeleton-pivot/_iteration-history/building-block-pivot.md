# Forge Pivot: From Opinionated Workflow to Composable Skeleton

## What Forge Is Today
A monolithic, 7-stage opinionated TDD workflow harness shipped as a single npm package (`forge-workflow`) with ~50 modules in `lib/`, 11 baked-in slash commands, hardcoded Beads/Lefthook/Greptile/SonarCloud assumptions, and a `forge setup` that writes files into 8 different agent directories. Customization today means editing your installed copy — which gets clobbered on the next `bunx forge setup`.

## What It Should Be
A thin **skeleton** — a workflow contract (stage names, hand-off shape, file conventions) plus a tiny CLI loader — that resolves stages, gates, and toolchain adapters from independently-versioned npm blocks. Users get the mainline by default, **fork to customize**, and encode their divergence in a `patch.md` so `forge upgrade` can self-heal merge conflicts via an agent rather than ship a plugin runtime.

## 5 Concrete Changes (Priority Order)

### 1. Extract a `forge-core` workflow contract (touch: `lib/workflow/`, new `packages/forge-core/`)
Define a tiny stable interface: `Stage { name, enter(ctx), exit(ctx), gates[] }` and a `ForgeContext` shape (branch, worktree, beads-id, design-doc path). Move *only* the orchestration + stage registry into `forge-core`. Why: today every command file in `.claude/commands/*.md` is hardcoded; without a contract there's no surface for blocks to plug into.

### 2. Convert each stage to a standalone block (touch: `.claude/commands/`, `lib/commands/`)
Move `plan`, `dev`, `validate`, `ship`, `review`, `premerge`, `verify` to `packages/forge-stage-*` packages. Each ships its `.md` command, its `lib/commands/<stage>.js`, its tests, and a `forge.stage.json` manifest. The mainline `forge` package becomes a curated meta-package that depends on a default stage set. Why: lets a user replace `forge-stage-validate` with `@acme/forge-stage-validate` by changing `package.json`, no plugin runtime needed.

### 3. Make toolchain adapters first-class blocks (touch: `lib/beads-*.js`, `lib/lefthook-*.js`, `lib/greptile-match.js`, `lib/issue-sync/`)
Today Beads/Lefthook/Greptile/SonarCloud are baked into setup and stages. Extract to `forge-adapter-beads`, `forge-adapter-lefthook`, `forge-adapter-greptile`, `forge-adapter-sonarcloud`, exposing a uniform `Adapter { detect(), install(), preStage(), postStage() }`. Why: someone using Linear+CircleCI+CodeRabbit shouldn't fork the world — they swap three adapter packages.

### 4. Replace `forge setup` rewriting with a fork-aware bootstrap (touch: `lib/setup.js`, `bin/forge.js`)
Stop writing into the user's repo from the package. Instead: `forge init` clones a starter template (`forge-template-default`) once. `forge upgrade` runs the patch.md self-heal flow (see below). Why: today `bunx forge setup --force` overwrites user customizations — exactly the lock-in problem this pivot solves.

### 5. Slim AGENTS.md and command files into block-rendered output (touch: `AGENTS.md`, `scripts/sync-commands.js`)
AGENTS.md is currently the single source of truth and 11 command files are sync'd to 7 agent directories. Make AGENTS.md a thin index that imports stage-block READMEs. `sync-commands.js` becomes a pure renderer that walks installed `forge-stage-*` packages. Why: a user adding `@acme/forge-stage-deploy` should get its docs in AGENTS.md automatically — no fork edits.

## 3 Building Blocks to Ship as npm Packages

1. **`forge-tdd-loop`** — the implementer → spec-reviewer → quality-reviewer subagent loop from `/dev` (currently buried in `.claude/commands/dev.md` + `lib/task-ownership.js`). Standalone, agent-agnostic, useful in *any* TDD workflow.
2. **`forge-design-qa`** — the one-question-at-a-time Phase 1 design Q&A engine + 7-dimension ambiguity rubric from `/plan`. The most-praised piece of Forge; many teams want just this.
3. **`forge-pr-triage`** — Greptile thread reply/resolve + SonarCloud + GH Actions failure handler from `/review` (`.claude/scripts/greptile-resolve.sh`, `lib/greptile-match.js`). Solves a real pain (Greptile threads stay unresolved) for any TDD or non-TDD project.

## How `patch.md` Works in Forge

`forge init` writes a top-level `forge.patch.md` to the user's repo, initially empty. Whenever the user edits anything inside a forge-managed surface (a stage command file, an adapter config, AGENTS.md), the change is recorded as a patch *intent* block:

```md
## patch: stage-validate / disable-security-scan
intent: Our org runs Semgrep in CI; the bundled OWASP scan is redundant and slow.
target: packages/forge-stage-validate@^2
op: replace-step
selector: gates[name="security-scan"]
replacement: { skip: true, reason: "handled by CI" }
fallback: keep-original
```

A `forge patch record` command (with optional `--from-diff`) infers intent from the working-tree diff against the upstream block version and appends an entry. On `forge upgrade`, the CLI: (1) bumps blocks to latest, (2) re-applies each patch entry, (3) on conflict, spawns the user's agent with the patch's `intent` text + the upstream change + the user's old version, asking it to reconcile. Successful reconciliations rewrite the patch entry; failures stop the upgrade with a clear hand-off. Intent-as-text is the durable artifact — code can be regenerated, intent cannot. This replaces a plugin API with a fork that knows how to merge itself.

## File
`docs/plans/2026-04-28-building-block-pivot.md` — this plan.
