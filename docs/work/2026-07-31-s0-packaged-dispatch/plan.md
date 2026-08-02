# Packaged AGENTS dispatch pointer

## Goal
Ensure the canonical/packaged `AGENTS.md` surface copied by `forge setup` reliably points Codex/model agents to the `using-forge` dispatch skill/rules, without duplicating dynamic script output.

## Scope
Inspect and minimally update the owned surfaces: `AGENTS.md`, `lib/agents-config.js`, `lib/rules-sync.js`, and focused generation/onboarding/parity tests. Preserve existing user content, generated parity, and other harness behavior. Do not touch forbidden shared files.

## Acceptance
- A regression test reproduces the packaged/setup output missing or losing the dispatch pointer and is RED before implementation.
- Generated/copied AGENTS output contains a concise pointer to `using-forge` and does not inline the dynamic dispatch policy.
- Existing content preservation and other harness behavior remain intact.
- Focused generation, onboarding, and rules-parity tests pass.
