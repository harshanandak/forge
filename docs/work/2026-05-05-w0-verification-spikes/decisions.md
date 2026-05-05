# Wave 0 Verification Decisions

## D1. Treat Cursor `.mdc` as supported

Cursor `.cursor/rules/*.mdc` with `description`, `globs`, and `alwaysApply` is primary-source documented. It is safe for Wave 1 translator planning.

## D2. Do not target a separate Cursor Composer file format

No primary source found for a stable Composer file format distinct from Cursor project rules, root `AGENTS.md`, and Cursor Agent CLI output formats.

## D3. Do not require Codex custom slash prompt files for parity

OpenAI's public Codex slash-command docs document built-ins, not a stable user-authored file location. Local OpenAI Codex source search did not establish a stable project prompt directory. Use Codex skills/instructions as the persistent file target until primary docs say otherwise.

## D4. Keep numeric gates executable but synthetic in Wave 0

The anchor and race benches are deterministic local simulations. They validate the planned resolution strategy and thresholds without implementing Wave 1 runtime features.
