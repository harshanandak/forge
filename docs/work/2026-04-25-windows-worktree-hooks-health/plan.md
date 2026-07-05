# Feature: windows-worktree-hooks-health

- **Date:** 2026-04-25
- **Status:** Proposed (/plan)
- **Classification:** Simple bug fix by default, escalated to `/plan` at user request for a robust multi-step fix.

## Purpose

Fix false runtime-prerequisite failures on Windows repositories (especially Git worktrees) where Forge blocks `/review` and `/verify` with `HOOKS_NOT_ACTIVE` and/or `LEFTHOOK_MISSING` even though hooks are valid and Lefthook is operational.

## Success criteria

1. `checkRuntimeHealth()` treats hook setup as active when any of these are true:
   - `core.hooksPath` points at `.lefthook/hooks` (existing behavior), or
   - effective git hooks directory resolved by Git contains valid hook entrypoints (`pre-commit`, `pre-push`) that route to Lefthook.
2. Windows worktree scenarios no longer hard-stop with `HOOKS_NOT_ACTIVE` when hooks are actually installed.
3. `LEFTHOOK_MISSING` is no longer emitted as a false negative in worktrees where Lefthook is invokable but `node_modules/.bin` resolution is atypical.
4. Runtime diagnostics clearly report *which* hook check failed (config path mismatch vs missing files vs command failure).
5. Existing runtime-health tests stay green and new regression tests cover Windows + worktree conditions.

## Out of scope

- Reworking the full stage-enforcement model.
- Replacing Lefthook with another hook runner.
- Redesigning Beads workflow gates.
- Broad command-registry redesign (except minimal noise reduction needed for this bug report context).

## Approach options considered

### Option A — Keep `core.hooksPath`-only check, improve message text
- **Pros:** Small code change.
- **Cons:** Does not fix real false negatives in valid worktree setups.
- **Decision:** Rejected.

### Option B — Add fallback validation via effective hooks directory + executable check (**selected**)
- **Pros:** Matches Git behavior in worktrees, validates actual runtime hook state, reduces false negatives.
- **Cons:** Slightly more complex logic and tests.
- **Decision:** Selected as best balance of correctness and maintainability.

### Option C — Remove hard-stop for hooks entirely
- **Pros:** Unblocks users quickly.
- **Cons:** Violates safety intent of stage runtime gates; hides real misconfiguration.
- **Decision:** Rejected.

## Approach selected

Implement a layered hook-health strategy in `lib/runtime-health.js`:

1. Keep current normalized `core.hooksPath` check.
2. If that fails or is unset, resolve effective hooks directory through Git (`git rev-parse --git-path hooks`).
3. Verify expected hook files exist and are non-empty (and executable where applicable).
4. Optionally inspect hook contents for Lefthook signatures to avoid false positives from unrelated scripts.
5. Return structured state codes so diagnostics can differentiate:
   - `hooks-path-active`
   - `hooks-dir-active`
   - `hooks-missing-files`
   - `hooks-unverified`

For `LEFTHOOK_MISSING`, harden `lib/lefthook-check.js` so dependency declaration + invokable toolchain is accepted in worktree-aware setups (without weakening real missing-dependency detection).

For report-noise mitigation, align command registry exports for `recommend` and `team` so `[registry] Skipping ... missing or invalid "name" export` warnings are removed.

## Constraints

- Must remain cross-platform (Linux/macOS/Windows).
- Must preserve existing hard-stop behavior for genuinely broken hook environments.
- No hook-bypass behavior (`--no-verify`, `LEFTHOOK=0`) may be introduced.
- Keep runtime checks deterministic and testable via dependency injection (`options._exec`, etc.).

## Edge cases

1. **Windows path casing + separators:** `C:\Repo\.LEFTHOOK\HOOKS` should still normalize as active.
2. **Worktree with unset `core.hooksPath`:** still valid if effective hooks dir contains runnable hooks.
3. **Git command failures:** diagnostic should indicate verification failure source, not generic false negative.
4. **Lefthook binary location differences:** package manager shims / worktree-local resolution should not trigger false `LEFTHOOK_MISSING`.
5. **Non-Lefthook custom hooks:** if project does not declare Lefthook, keep current dependency behavior intact.

## Ambiguity policy

Use the existing 7-dimension decision-gate rubric during `/dev`:
- **>=80% confidence:** proceed, document rationale in decisions log.
- **<80% confidence:** pause and ask for explicit user decision.

## Technical Research

### Codebase exploration findings

- `lib/runtime-health.js` currently treats hook health as `core.hooksPath == .lefthook/hooks` only, with hard-stop on mismatch/unverified.
- `lib/lefthook-check.js` currently checks only `package.json` dependency + `node_modules/.bin/lefthook(.cmd)` existence.
- `lib/workflow/enforce-stage.js` blocks stage commands on any runtime-health hard-stop.
- `lib/commands/recommend.js` and `lib/commands/team.js` are loaded by registry but do not export `{ name, description, handler }`, generating warning noise.

### External references

- Git docs: default hooks dir is `$GIT_DIR/hooks`, override via `core.hooksPath`; both are valid runtime targets.
- Git worktree docs: path resolution differs across linked worktrees; `git rev-parse --git-path ...` is the recommended canonical resolver.

### OWASP Top 10 relevance

- **A05 Security Misconfiguration:** False negatives can push teams toward unsafe manual bypass habits; fix should preserve strict checks while reducing incorrect failures.
- **A09 Security Logging and Monitoring Failures:** Generic diagnostics hinder triage; explicit failure modes improve observability and incident response.
- **A04 Insecure Design (partially relevant):** runtime prerequisites are a security control; design should verify *effective state* rather than one config knob.

### DRY gate (executed)

- Searched for hook-health and Lefthook runtime checks in `lib/` and `test/`.
- Found canonical implementation in `lib/runtime-health.js` and `lib/lefthook-check.js`; planned work extends these existing modules rather than creating duplicates.

### Blast-radius check

This feature changes behavior (no remove/rename of commands/dependencies), so full remove/rename blast-radius procedure is not required.

### TDD scenarios (minimum set)

1. **Happy path:** Windows worktree with unset `core.hooksPath`, valid effective hooks directory and Lefthook-installed hooks => runtime health passes.
2. **Failure path:** hooks directory resolved but missing `pre-push` => `HOOKS_NOT_ACTIVE` with specific missing-file diagnostic.
3. **Edge case:** `git config --get core.hooksPath` fails, but `git rev-parse --git-path hooks` succeeds => health still passes.
4. **Edge case:** Lefthook declared and invokable via toolchain shim while local `.bin` missing => no false `LEFTHOOK_MISSING`.
5. **Noise regression:** registry no longer warns for `recommend.js` / `team.js` missing command metadata.
