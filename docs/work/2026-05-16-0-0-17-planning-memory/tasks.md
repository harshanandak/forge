# 0.0.17 Planning And Memory Loop Tasks

## Task 1: Planning Template Runtime Graph

RED: Add tests proving planning sub-skills and template defaults exist in the runtime graph, and that `.forge/config.yaml` can override allowed planning template settings.

GREEN: Extend the runtime graph model and config resolver for planning template configuration.

REFACTOR: Keep config validation helpers small and consistent with existing workflow/adapters validation.

## Task 2: Beads-Backed Project Memory

RED: Replace JSONL storage expectations with tests proving `write`, `read`, `search`, and `list` invoke `bd remember`, `bd recall`, and `bd memories`.

GREEN: Rework `lib/project-memory.js` as a Beads-backed compatibility adapter with injectable command runner support.

REFACTOR: Normalize Beads JSON parsing and errors without adding storage.

## Task 3: Typed Memory API

RED: Add tests for category validation, required provenance, key prefixes, and Beads routing.

GREEN: Add a thin typed memory API that delegates to project memory and stores category/provenance metadata in the Beads memory payload.

REFACTOR: Export only small, explicit category helpers plus generic typed read/search helpers.

## Task 4: Docs And Command Surface

RED: Add docs tests or focused assertions for the new planning/memory loop wording if existing doc tests cover command docs.

GREEN: Update user-facing docs to explain planning config and Beads-backed memory behavior.

REFACTOR: Keep docs short, with non-scope and failure modes visible.

