# Model-neutral eval evidence and exact-SHA replay

- Date: 2026-08-05
- Issue: `02f5ea90-4a1a-462f-9b22-54eb5d37f6b3`
- Status: approved

## Purpose

Add complementary experiment infrastructure that records model-neutral, privacy-safe evaluation evidence in the Kernel and binds replay to the exact evaluated commit and input hashes.

## Success criteria

- Every case records issue ID, PR, full head SHA, model, effort, role, prompt/skill/tool SHA-256 hashes, start/end timestamps, active/passive time, tokens, retries, compactions, and gate results.
- Evidence is canonically serialized, content-addressed, and appended idempotently as a Kernel event.
- Replay validates envelope integrity, exact SHA availability, and all recorded hashes before any command runs; drift fails closed.
- Existing eval callers remain compatible.
- Focused tests cover required fields, privacy rejection, duplicate writes, corruption, and exact-SHA replay.

## Out of scope

Corpus/oracles, model adapters, graders, dashboards, routing defaults, gates, review comments, merge authority, model comparison, and unrelated findings.

## Approach selected

Extend the existing eval runner with one evidence module. Reuse `stableStringify` from Kernel evaluators, `contentHash`, the Kernel event store, and the existing worktree isolation. The envelope is a strict allow-list so raw prompts, transcripts, tool payloads, secrets, and personal data cannot be persisted.

## Constraints and edge cases

- Full 40-character commit SHAs and 64-character lowercase SHA-256 hashes only.
- Unknown fields are rejected, including nested unknown gate/token fields.
- A duplicate content hash resolves to the existing Kernel event.
- A mismatched content hash, unavailable commit, or replay hash drift rejects before worktree creation or command execution.
- The legacy `createEvalWorktree()` call still resolves current `HEAD`.
- Ambiguity policy: proceed only where the issue contract and existing seams provide at least 80% confidence; otherwise stop and update the issue.

## Technical research

- DRY: reuse `lib/kernel/evaluators.js::stableStringify`, `lib/file-hash.js::contentHash`, `lib/kernel/owned-kernel.js`, and the idempotent append pattern in `lib/gate-events.js`.
- OWASP: strict allow-listing prevents sensitive-data persistence; exact hashes and SHA verification address integrity drift; array-form Git execution avoids ref injection; no authorization or merge surface changes.
- TDD scenarios: valid deterministic envelope; missing/unknown privacy-sensitive field rejection; duplicate Kernel write; corrupted envelope rejection; exact-SHA worktree replay; hash drift fails before execution.

## Dependency

The branch is based on approval-policy PR #483 and must remain dependent on it until that PR lands.
