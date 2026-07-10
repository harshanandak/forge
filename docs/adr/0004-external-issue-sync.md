# 0004 — External issue-sync adapters

**Date**: 2026-07-09
**Status**: proposed

## Context

Teams already track issues in GitHub, Jira, or Linear. If Forge is a closed issue
world, adoption stalls — a team will not abandon its tracker to use Forge. Today
Forge's only external tie is a GitHub-only link/projection: one hardcoded
provider, not a general sync. The kernel issue model, however, is a deliberate
**superset** (4 issue types incl. `decision`; 5 stored statuses; `metadata` blob;
`entity_revision` CAS; `events.origin`; `dependency_type`; a
`forge`/`provider`/`configured_provider`/`projection_only` field-authority axis)
and is ~90% ready to be the canonical model behind pluggable adapters.

We need a sync architecture that keeps the kernel canonical, lets each team keep
its tracker, and stays user-extensible to new providers.

## Decision

Adopt **pluggable external issue-sync adapters over the canonical kernel model.**

- **Kernel-authoritative by default**, configurable **per provider**
  (external-authoritative import, or bidirectional) — direction is a per-adapter
  setting, not a global mode.
- **Identity + drift:** add an **`external_refs` table** (issue + comment grain:
  `entity_type, entity_id, provider, external_id, external_key, external_url,
  external_revision, last_pulled_at, last_pushed_at`) as the mapping spine.
  Bidirectional conflict resolution reuses the existing **`entity_revision` CAS**
  plus a **`conflicts` quarantine** — mirrored/foreign edits that lose the CAS
  land in quarantine rather than clobbering kernel truth.
- **Per-adapter mapping:** status/type mapping tables per provider, plus
  `metadata.providers.<name>.*` passthrough for fields Forge does not model.
- **GitHub first**, Jira / Linear as later modules behind the same adapter
  interface.
- **Never pushed outward:** the `decision` issue type and `claims` leases are
  Forge-internal authority and are excluded from any external push.

## Consequences

- **Positive — teams keep their tracker.** External systems stay the team's
  day-to-day surface; Forge syncs rather than replaces, removing the adoption
  blocker.
- **Positive — user-extensible.** New providers are plugin adapters against a
  stable interface + mapping tables; no kernel change per provider.
- **Positive — canonical model stays clean.** The kernel superset absorbs
  provider variance via mapping tables + `metadata` passthrough, so no
  provider-specific columns leak into the core schema.
- **Trade-off — additive schema + eventing.** Requires the `external_refs`
  migration (additive, no backfill, deferrable past beta — kernel `431c2c1e`)
  and Forge-built webhook/eventing since the libSQL backend has none (ADR-0002).
- **Trade-off — bidirectional complexity.** Two-way sync needs the CAS +
  quarantine loop and per-provider authority rules; kernel-authoritative
  one-way is the safe default until an adapter opts into bidirectional.

## Alternatives considered

- **Forge-only issue world (no external sync)** — rejected: an adoption blocker;
  teams will not leave their existing tracker.
- **One hardcoded provider (today's GitHub-only link store)** — rejected: not
  extensible, not canonical, and not configurable per team; it is exactly the
  limitation this ADR removes.
- **Provider-specific columns in the core schema** — rejected: the `metadata`
  blob + per-provider mapping tables + `external_refs` carry provider variance
  without polluting the superset (see the "KEEP the superset" findings in the
  decision-store design doc §C.5).
