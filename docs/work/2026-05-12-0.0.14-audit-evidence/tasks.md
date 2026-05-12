# Tasks: 0.0.14 audit evidence persistence

## Task 1: Add audit evidence adapter

Ownership:
- `lib/audit-evidence.js`
- `test/audit-evidence.test.js`

TDD:
1. RED: Add tests for normalized implementer/spec/quality event shape, redaction of secret-like values, Beads record command invocation, and fallback metadata writing when upstream `--meta-json` is unavailable.
2. GREEN: Implement the adapter with injectable command runner and filesystem dependencies.
3. REFACTOR: Keep the adapter small, command-safe, and reusable by `/dev` and future `/build`.

Acceptance:
- No raw token/password/secret values are persisted in prompt, response, or fallback metadata.
- Beads record output is parsed for `id`.
- `.forge/log.jsonl` lines include `sourceOfTruth: "beads"` and `beadsEntryId`.

## Task 2: Wire `/dev` subagent evidence helpers

Ownership:
- `lib/commands/dev.js`
- `test/commands/dev.test.js`

TDD:
1. RED: Add tests for implementer, spec reviewer, and quality reviewer evidence emission through `/dev` helpers.
2. GREEN: Export `/dev` helper functions that call the audit adapter with the defined event roles.
3. REFACTOR: Preserve existing `/dev` behavior and avoid config/options/API rail changes.

Acceptance:
- Implementer events call `bd audit record`.
- Spec reviewer PASS/FAIL labels become `good`/`bad`.
- Quality reviewer PASS/FAIL labels become `good`/`bad`.
- Unknown verdicts do not label.

## Task 3: Document CLI behavior and fallback decision

Ownership:
- `docs/work/2026-05-12-0.0.14-audit-evidence/design.md`
- PR body

TDD:
1. RED: Add or update tests that lock the fallback decision where practical.
2. GREEN: Document that `bd audit --meta-json` and `bd audit verify` are unavailable in the current CLI surface, and that `.forge/log.jsonl` is supplemental metadata only.
3. REFACTOR: Keep documentation concise and tied to validated commands.

Acceptance:
- PR body includes issues covered, validation commands, and fallback decision.
- No claim that `bd audit verify` passes unless the current command actually verifies.
