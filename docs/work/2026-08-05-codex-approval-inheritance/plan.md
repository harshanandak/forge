# Codex approval inheritance

## Problem

Forge's tracked `.codex/config.toml` sets `approval_policy = "on-request"` and
`sandbox_mode = "workspace-write"`. Codex loads trusted project configuration
after user configuration, so those values override an explicit local automation
policy. Newly forked worktree tasks therefore pause for approval even when the
user configured `never` and full access.

## Decision

Do not set user-owned approval, sandbox, or workspace-network policy in tracked
project configuration. Remove the current project config and add a regression
test that rejects those keys if `.codex/config.toml` is added later for unrelated
Codex features. Users without overrides keep Codex's safe built-in defaults;
explicit user or launch policy remains authoritative.

## Evidence

- Official precedence: launch overrides, project config, profile, then user config.
- Live child tasks resolved `on-request`/managed despite the user config selecting
  `never`/full access.
- `lib/safety-config-renderer.js` and the capability matrix already describe Codex
  project-local sandbox/approvals as not delivered.

## Scope

- Delete the tracked policy-only `.codex/config.toml`.
- Add one focused repository invariant test.
- Do not alter global user configuration, approval requests already pending,
  Forge gates, model routing, or the Sol/Luna evaluation implementation.

## Validation

Run the focused capability-matrix test, then Forge validation required for this
configuration change. Verify a newly created trusted task no longer resolves the
removed project policy.
