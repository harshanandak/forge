# Feature

- Slug: `forge-f3lx-issues`
- Date: `2026-04-13`
- Status: `planned`
- Issue: `forge-f3lx`
- Branch: `feat/forge-f3lx-issues`
- Worktree: `.worktrees/forge-f3lx-issues`

## Purpose

Introduce a new plural command surface, `forge issues`, that makes Forge the entrypoint for issue operations while keeping Beads behind a backend abstraction. This is the first v2 authority-layer seam: the CLI should stop acting like a direct `bd` passthrough at the command edge and instead route through a Forge-owned service that can later swap Beads for GitHub Issues, Linear, or Jira.

This wave is intentionally narrow. It establishes the command shape and backend seam for `create`, `list`, `show`, `close`, and `update`, without taking on the broader sync, import, or GitHub reconciliation work that belongs to later children of `forge-f3lx`.

## Success Criteria

1. `lib/commands/issues.js` exists and auto-registers through `lib/commands/_registry.js` without any `bin/forge.js` changes.
2. A new Forge-owned issue service module exists in a new file and exposes a pluggable backend contract for `create`, `list`, `show`, `close`, and `update`.
3. The default backend for this wave delegates to the `bd` CLI, but the command module itself does not build `bd` argv directly.
4. `forge issues list`, `forge issues create`, `forge issues show <id>`, and `forge issues close <id>` work through the new service surface, with `update` implemented in the backend contract even if it is not advertised as the headline UX path.
5. The implementation leaves `lib/commands/worktree.js`, `lib/commands/setup.js`, and `lib/beads-health-check.js` untouched.
6. Tests lock the backend contract, command help/dispatch behavior, and registry auto-discovery for the new plural command.

## Out Of Scope

- Replacing the existing singular `lib/commands/issue.js` or the legacy top-level aliases (`forge create`, `forge show`, `forge close`, `forge list`) in this wave.
- Implementing GitHub Issues, Linear, or Jira backends.
- Implementing sync queues, reconciliation rules, import flows, or shared-memory features from the broader `forge-f3lx` epic.
- Modifying `lib/commands/worktree.js`, `lib/commands/setup.js`, or `lib/beads-health-check.js`.
- Modifying internals of `lib/beads-setup.js`; only its exported API may be consumed.

## Approach Selected

Add a new plural command module plus a Forge-owned issue service:

1. `lib/commands/issues.js`
   - Thin CLI adapter.
   - Parses the subcommand and arguments.
   - Calls the Forge issue service.
   - Formats Forge-level help and error output.
2. `lib/forge-issues.js`
   - Exposes the service entrypoint and backend factory.
   - Owns the backend interface and command-to-operation mapping.
   - Uses Beads as the default backend in this wave.
3. Optional helper file(s) under a new issue-backend namespace if needed during implementation, but all new code stays in new files.

Selected interface shape:

```js
class IssueBackend {
  async create(args, context) {}
  async list(args, context) {}
  async show(args, context) {}
  async close(args, context) {}
  async update(args, context) {}
}
```

Selected service shape:

```js
createIssueService({ backend, execFileSync, isBeadsInitialized })
runIssueOperation(operation, rawArgs, projectRoot, deps)
```

Why this approach:

- The current implementation in `lib/commands/_issue.js` shells out to `bd` directly from the command layer, which is fast to wire but is the wrong ownership boundary for v2.
- The v2 strategy doc explicitly calls for `issueCore.create()` to sit behind both CLI and MCP entrypoints and for Forge to wrap Beads as a backend/cache rather than exposing `bd` as the real API.
- A new plural command avoids collisions with the legacy singular command surface and satisfies the user constraint to keep this wave's code in new files.

## Alternatives Considered

### Option A: Extend `lib/commands/_issue.js`

Rejected for this wave.

- It would mix the new authority-layer seam into the legacy direct-wrapper code.
- It increases conflict risk with adjacent tracks by turning a replacement into an in-place rewrite.
- It makes it harder to keep the backend boundary explicit.

### Option B: Add `lib/commands/issues.js` plus a new service module

Selected.

- Zero `bin/forge.js` work because the registry auto-discovers new command files.
- Keeps the new architecture in new files only.
- Lets `/dev` build the backend interface under test before any future migration of the old singular command surface.

## Constraints

- New implementation code for this wave must live in new files.
- The command must rely on registry auto-discovery and not require manual CLI registration changes.
- The design must be future-friendly for GitHub Issues, Linear, and Jira, but only Beads is implemented now.
- If `lib/beads-setup.js` is used, only exported helpers such as `isBeadsInitialized()` may be consumed.
- Error messages should be translated into Forge terms instead of exposing only raw `bd` failures, consistent with the v2 strategy document's error-handling requirement.
- This plan stops before implementation. `/dev` work begins only after approval.

## Edge Cases

- `bd` binary missing: the Beads backend must translate `ENOENT` into a Forge-level installation/init message.
- Beads not initialized in the repo: the service should fail clearly before attempting to execute issue operations.
- Unknown subcommand or missing required ID: `forge issues` must return command-local usage guidance instead of raw backend errors.
- Backend capability drift: future backends may not support every Beads-specific concept; the interface should be operation-based and conservative in this wave.
- Legacy command coexistence: `forge issue` and `forge create/show/list/close` remain in place during this wave, so the new plural command must not rely on changing them.

## Ambiguity Policy

Use the repo's `/dev` decision-gate rubric.

- If confidence is `>= 80%`, choose the conservative option, document it in the decisions log during implementation, and continue.
- If confidence is `< 80%`, stop and ask before changing command semantics or backend contract shape.

## Technical Research

### Current Repo Findings

- `lib/commands/_registry.js` auto-discovers `.js` files in `lib/commands/` and requires only `{ name, description, handler }`.
- `lib/commands/_issue.js` already provides a legacy command surface for `forge issue`, `forge create`, `forge update`, `forge claim`, `forge close`, `forge show`, `forge list`, and `forge ready`.
- Existing tests already cover the legacy surface in `test/commands/issue.test.js` and `test/commands/_issue.test.js`.
- `lib/beads-setup.js` exports `sanitizePrefix`, `writeBeadsConfig`, `writeBeadsGitignore`, `isBeadsInitialized`, `preSeedJsonl`, and `safeBeadsInit`.

### V2 Strategy Findings

- `docs/plans/2026-04-06-forge-v2-unified-strategy.md` requires CLI/MCP parity through a shared issue core.
- The same strategy doc defines a future-friendly `IssueBackend` shape with Beads, GitHub Issues, Linear, and Jira adapters (see `docs/plans/2026-04-06-forge-v2-unified-strategy.md`, around line 940).
- The current wave only needs the Beads-backed default plus the abstraction seam; cloud-agent GitHub fallback belongs to later work.

### Planning Preconditions

- `git branch --show-current` returned `master` before worktree creation.
- `bd worktree create .worktrees/forge-f3lx-issues --branch feat/forge-f3lx-issues` succeeded.
- `scripts/forge-team/index.sh verify` reported `gh` is not authenticated. That is not a blocker for this local Beads-backed planning wave, but later GitHub-backed tracks will need `gh auth login`.
- `scripts/pr-coordinator.sh merge-order` reported a dependency cycle. That is advisory input for coordination, not a reason to redesign this command boundary.

## TDD Scenarios

1. The issue service routes `create`, `list`, `show`, `close`, and `update` to the configured backend and rejects unsupported operations clearly.
2. The default Beads backend builds the correct `bd` argv for each supported operation and translates missing-binary / missing-init failures into Forge-level errors.
3. `forge issues --help` and `forge issues <bad-subcommand>` return stable help text without touching the backend.
4. `forge issues create`, `forge issues list`, `forge issues show <id>`, and `forge issues close <id>` dispatch through the new service and are auto-discovered by the registry.
5. The new plural command can ship without modifying the legacy singular command files.

## Baseline

- Issue: `forge-f3lx`
- Worktree: `.worktrees/forge-f3lx-issues`
- Branch: `feat/forge-f3lx-issues`
- Planning blockers: none for local artifact creation
- Implementation blockers to resolve later: GitHub CLI authentication for downstream GitHub-backed tracks
