# forge init Day-One Entry Door Decisions

No /dev decision gates fired. The entries below record the architectural and scope choices that shaped the implementation.

## Decision 1: Implementation Location

**Date:** 2026-05-21
**Decision:** Extend `lib/commands/init.js` for the day-one `forge init` entry door.
**Rationale:** The command registry already routes `forge init` through this module, and the existing adoption profile rendering path lives next to the command handler.
**Impact:** The change stays close to current dispatch behavior while keeping parsing, wizard resolution, rendering, and file generation testable from one command module.

## Decision 2: Preserve Dry-Run YAML Output

**Date:** 2026-05-21
**Decision:** Keep `forge init --dry-run` focused on the generated `.forge/config.yaml` content.
**Rationale:** Existing scripted usage expects parseable YAML on stdout, so day-one scaffolding should not mix extra file previews into that output path.
**Impact:** Automation can continue reading dry-run output as config YAML while normal execution still creates `config.yaml`, `patch.md`, and `protected-paths.yaml`.

## Decision 3: L1 Confirmation Recording

**Date:** 2026-05-21
**Decision:** Record Layer 1 rail confirmation under `layer1Rails.confirmed` instead of adding synthetic entries to the runtime `rails` map.
**Rationale:** Runtime rail configuration already has named rail keys, and day-one confirmation is adoption metadata rather than a new rail definition.
**Impact:** The wizard captures explicit L1 confirmation without changing the runtime rail schema used by existing config validation.

## Decision 4: Protected Path Enforcement Scope

**Date:** 2026-05-21
**Decision:** Scaffold `.forge/protected-paths.yaml` only; protected-state enforcement remains deferred to the later protected-state work.
**Rationale:** The day-one entry door needs visible protected path intent for fresh repositories, but enforcement belongs to the separate protected-state slice.
**Impact:** Fresh repos receive a generated manifest with harness-aware defaults, and this PR does not introduce write-blocking protected-state behavior.
