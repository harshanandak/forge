# S0 enforcement honesty

- **Issue**: `183d38fc-77d8-479f-977f-25e20b931d03`
- **Date**: 2026-07-31
- **Status**: implementation

## Purpose

Correct lazy `.forge/config.yaml` initialization so issue creation/activation does not silently replace Forge's default enforcement posture with the disabled `minimal` profile.

## Acceptance criteria

1. A bare repository first reached through the real issue create/activation lazy-init path receives the default enforcement posture (default workflow gates and default-on rails remain enabled), not a gates-disabled profile.
2. An explicitly selected `minimal` profile remains minimal, and an existing config containing explicit gate/rail disables is never rewritten or broadened by lazy initialization.
3. Existing user config and unrelated files are preserved; lazy initialization remains limited to the config skeleton.
4. Write failures do not crash or prevent the originating mutating command from running, and a half-created home can be retried safely.
5. Regression tests cover both the helper and the actual registry dispatch path used by issue creation/activation.

## Scope / ownership

- `lib/activation/ensure-forge-home.js`
- `test/activation/ensure-forge-home.test.js`
- `test/activation/registry-lazy-init.test.js`
- `docs/work/2026-07-31-s0-enforcement-honesty/**`

No shared/forbidden files may be changed.

## Approach

Use the canonical non-minimal adoption renderer for a newly created lazy config while retaining the existing config-file no-clobber boundary. Tests will assert default enabled gates/rails, explicit minimal preservation, existing-config preservation, write-failure safety, and the `executeCommand` lazy path.

## Ambiguity policy

Apply the `/dev` seven-dimension decision rubric. If a gap scores 0–3/14, choose the smallest behavior consistent with this issue and document it; 4–7 routes to spec review; 8+ or any security/schema/public-API override blocks for developer input. When evidence is incomplete, prefer preserving user files and preserving enforcement over silently weakening it. No changes outside the listed ownership are permitted.

## Out of scope

Do not change adoption-profile definitions, command registry semantics beyond the owned regression surface, hooks, package metadata, documentation outside this unique work directory, issue lifecycle, push, PR, merge, or close operations.
