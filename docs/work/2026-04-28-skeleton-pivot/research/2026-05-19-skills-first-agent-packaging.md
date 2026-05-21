# Skills-First Agent Packaging

Date: 2026-05-19

## Question

Claude still has Forge stage workflows under `.claude/commands/`, while Codex already has stage workflows under `.codex/skills/`. The product question is whether Forge should keep generating command files, or move the runtime and stage distribution model to `SKILL.md` packages that can be installed and synced across agents.

## Verified Current State

- Claude stage workflow files still exist as command files in `.claude/commands/`: `plan.md`, `dev.md`, `validate.md`, `ship.md`, `review.md`, `premerge.md`, `verify.md`, plus support commands.
- This repo currently has no committed `.claude/skills/` tree, so Claude is still command-first in the project checkout.
- Codex stage workflow skills already exist in `.codex/skills/`: `plan`, `dev`, `validate`, `ship`, `review`, `premerge`, `verify`, and support skills.
- Forge already carries a local skills manager at `packages/skills/bin/skills.js` with `init`, `create`, `list`, `sync`, `remove`, `validate`, `add`, `publish`, `search`, and `config`.

## External Findings

- Claude Code documents that custom commands have been merged into skills. A file under `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy`; existing command files keep working, but a skill with the same name takes precedence. Source: <https://code.claude.com/docs/en/skills>
- Claude skills are directory packages with `SKILL.md` as the entrypoint, YAML frontmatter for discovery, and optional support files such as scripts, templates, examples, and references. Source: <https://code.claude.com/docs/en/skills>
- Claude Agent SDK skills are filesystem artifacts discovered from project/user skill directories; the SDK can enable all skills, a named subset, or none. Tool restrictions remain a runtime concern, not a full sandbox. Source: <https://code.claude.com/docs/en/agent-sdk/skills>
- skills.sh describes skills as reusable procedural capabilities and documents `npx skills add <skill-name>` / `npx skills add vercel-labs/agent-skills` as the install path. Source: <https://www.skills.sh/docs/cli>
- skills.sh explicitly says marketplace quality and security are not guaranteed, so Forge must treat third-party skills as untrusted until reviewed, pinned, and permissioned. Source: <https://www.skills.sh/docs>

## Decision Direction

Forge should make `SKILL.md` the canonical package format for agent-facing stage behavior. Command files should become compatibility aliases or generated shims, not the source of truth.

This fits v3 because users are not buying a fixed command ladder. They are configuring a local runtime graph made of stages, substages, validators, hooks, memory projections, adapters, and UI panels. Skills are the portable packaging layer for those capabilities; Forge remains the runtime, resolver, audit trail, and protected write path.

## Proposed Architecture

1. Canonical stage package:
   - Each stage or substage is a skill directory with `SKILL.md`, optional `scripts/`, optional `examples/`, and optional `references/`.
   - The runtime graph references skill IDs and versions, not command file paths.
   - Commands such as `/plan` and `/review` remain valid by pointing to the skill package or by being generated as thin compatibility wrappers.

2. Cross-agent projection:
   - `packages/skills` becomes the Forge-managed local `skills` CLI surface.
   - `skills sync` projects the same source skill into `.claude/skills/`, `.codex/skills/`, Cursor-compatible locations, and future agent locations.
   - `skills add` can consume skills.sh/GitHub packages, but Forge records source, version/ref, trust state, permission needs, and owner approval before the capability is enabled in a project runtime graph.

3. Runtime configuration:
   - `.forge/config.yaml` toggles skills and substages on/off per project.
   - The local UI/TUI edits the resolved graph and shows which skills are active, disabled, shadowed, or provided only as compatibility aliases.
   - Stage-level toggles and docs-validation toggles use the same mechanism.

4. Safety model:
   - Third-party skills are imported disabled by default unless explicitly trusted by profile policy.
   - Skills that run scripts, mutate files, install packages, or touch protected paths must declare permissions.
   - Protected state rules block skills and agents from directly mutating Beads internals, Forge config, memory projection files, lockfiles, generated harness files, and workflows unless the write goes through the Forge API.

5. Documentation and release packaging:
   - The README should teach `skills add`, `skills sync`, and `forge options why <skill-id>` before listing individual command files.
   - Stage docs should be generated from skill metadata plus runtime graph config.
   - Docs validators, docstring coverage, link checking, and docs-update prompts should ship as a skill-packaged validation substage, proving the model before broad extension rollout.

## Release Plan Impact

- `0.0.16`: Package docs validation as a validation substage skill. Keep `forge docs detect/verify` as the CLI projection, but make the stage toggleable and baseline-driven.
- `0.0.17`: Convert built-in planning/dev/review/ship/premerge/verify behavior into canonical skills and expose sub-skill invocation.
- `0.0.22`: Hook projection must project skill lifecycle events and command-compat invocations consistently across Codex, Claude, and Cursor.
- `0.0.24`: Extensions contribute runtime components as skills first. Commands, templates, hooks, validators, and UI panels become projections from the extension manifest.

## Open Risks

- skills.sh is a discovery and install convenience, not a trust boundary. Forge needs pinning, provenance, review state, and permission prompts.
- Claude allows commands to keep working, but skill precedence can hide stale command files. Forge needs a duplicate-name/shadowing check.
- Codex, Claude, Cursor, and other agents do not expose identical tool permission semantics. Forge must model per-agent capability limits instead of assuming a skill is equally safe everywhere.
- Large support files in skills can become recurring token cost if loaded too eagerly. Keep `SKILL.md` concise and move detailed references into lazy-loaded files.
