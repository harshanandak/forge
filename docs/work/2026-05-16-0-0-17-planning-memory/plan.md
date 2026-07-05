# 0.0.17 Planning And Memory Loop

Date: 2026-05-16
Status: Implementation ready
Branch: `codex/0.0.17-planning-memory`

## Issues Covered

- `forge-besw.24`: configurable planning skill template, using the landed runtime graph/config surfaces.
- `forge-besw.19`: route project memory through Beads `bd remember`, `bd recall`, and `bd memories`.
- `forge-besw.22`: typed memory API only where it prevents ad hoc Beads memory calls.

## Purpose

0.0.17 connects the v3 planning template to runtime graph configuration and moves durable project memory away from Forge-owned JSONL storage. The result should make planning depth and sub-skill behavior inspectable through `forge options`, while memory writes and reads use Beads as the durable store.

## Success Criteria

- Runtime graph exposes planning sub-skills and planning template defaults.
- `.forge/config.yaml` can configure planning template behavior without a separate config reader.
- Invalid planning config fails through `forge options lint` with clear errors.
- Project memory compatibility calls route to `bd remember`, `bd recall`, and `bd memories`.
- Typed memory helpers enforce category and provenance before writing.
- Tests cover planning template config, Beads memory write/read/search behavior, and failure modes.
- Docs explain the planning/memory loop and the Beads-backed storage boundary.

## Out Of Scope

- Upgrade dry-run implementation.
- Lockfile or trust policy implementation.
- Rollback implementation.
- Patch intent implementation.
- Replacing Beads itself or introducing a new datastore.

## Approach Selected

Extend the existing runtime graph config resolver in `lib/core/runtime-graph.js` with a `planning` config section and first-class planning sub-skill actions. This keeps planning configurability in the same inspectable surface that already powers `forge options`.

Replace `lib/project-memory.js` internals with a small Beads adapter while preserving the public `read`, `write`, `search`, and `list` compatibility surface. Add a typed API in `lib/memory/typed-api.js` so future callers do not hand-roll key prefixes, category validation, or provenance payloads.

## Constraints

- Do not add a new persistent memory file.
- Do not depend on the caller shell for quoting; use `execFileSync` or injected runners with argument arrays.
- Keep Windows behavior deterministic.
- Keep tests independent from the real Beads database by using injected runners.

## Failure Modes

- Missing `bd`: memory calls return or throw clear Beads command errors.
- Invalid `bd` JSON: parser reports the command whose output could not be parsed.
- Invalid planning config: `lintRuntimeGraphConfig` returns structured errors and `getResolvedRuntimeGraph` throws.
- Missing memory key: `read` returns `null`, matching the existing compatibility shape.

