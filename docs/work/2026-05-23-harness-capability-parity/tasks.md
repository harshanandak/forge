# Harness Capability Parity Tasks

Feature: harness-capability-parity
Issue: forge-wj36

## Task 1: Capability Matrix Contract

File(s): `lib/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js`
OWNS: `lib/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js`

What to implement: Add a machine-readable matrix for Claude, Cursor, and Codex across all parity capabilities requested by `forge-wj36`. Include status, native target, role, activation, renderer family, source evidence, and known issues.

TDD steps:
1. Write test: assert all harnesses and capability IDs exist.
2. Run test: confirm it fails because the module is missing.
3. Implement: add the matrix module and exports.
4. Run test: confirm it passes.
5. Commit: `feat: add harness capability matrix contract`

Expected output: focused test reports the matrix is JSON-serializable and covers every required capability.

## Task 2: Skills-First Stage Graph

File(s): `lib/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js`
OWNS: `lib/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js`

What to implement: Add a stage graph where every default stage is a canonical super skill with subskills. Claude commands must be shims pointing at `.claude/skills`, Cursor uses `.cursor/skills`, and Codex uses `.codex/skills`.

TDD steps:
1. Write test: assert stage IDs, subskills, and render targets.
2. Run test: confirm it fails before graph implementation.
3. Implement: add `getSkillsFirstStageGraph`.
4. Run test: confirm it passes.
5. Commit: `feat: add skills-first stage graph`

Expected output: tests prove stages are skill-first and Claude command files are shim-only.

## Task 3: Renderer Evidence Contract

File(s): `lib/harness-capability-matrix.js`, `scripts/spikes/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js`
OWNS: `lib/harness-capability-matrix.js`, `scripts/spikes/harness-capability-matrix.js`, `test/harness-capability-matrix.test.js`

What to implement: Define renderer families and the evidence required before broad generation. Add a JSON CLI that emits the matrix, stage graph, renderer contract, and sources.

TDD steps:
1. Write test: assert renderer families and evidence requirements.
2. Run test: confirm it fails before contract/CLI implementation.
3. Implement: add `getRendererContract`, `buildHarnessCapabilityEvidence`, and CLI.
4. Run test: confirm it passes.
5. Commit: `test: cover harness capability evidence CLI`

Expected output: `node scripts/spikes/harness-capability-matrix.js` prints valid JSON.

## Task 4: User Docs

File(s): `docs/reference/AGENT_SKILL_PARITY.md`, `docs/work/2026-05-23-harness-capability-parity/*`, `test/docs-consistency.test.js`
OWNS: `docs/reference/AGENT_SKILL_PARITY.md`, `docs/work/2026-05-23-harness-capability-parity/*`, `test/docs-consistency.test.js`

What to implement: Document the end-to-end mechanism and evidence command so the docs overhaul can link to a stable section.

TDD steps:
1. Write test: assert docs mention the evidence command, contract module, renderer families, and Cursor hook known issue.
2. Run test: confirm it fails before docs update.
3. Implement: update docs.
4. Run test: confirm it passes.
5. Commit: `docs: explain harness capability parity contract`

Expected output: docs explain canonical Forge source plus per-harness target renderers without implying broad renderers are implemented.

## Focused Validation

Run:

1. `bun test test/harness-capability-matrix.test.js`
2. `bun test test/docs-consistency.test.js test/harness-capability-matrix.test.js`
3. `node scripts/spikes/harness-capability-matrix.js`
4. `bun run check`
