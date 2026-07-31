# Decisions

## Decision 1

- **Date**: 2026-07-31
- **Task**: Task 1 — honest lazy activation defaults
- **Gap**: The issue allows either no config (inherit defaults) or a default-enabled lazy config, while existing lazy initialization currently writes the canonical `minimal` profile.
- **Score**: 2/14 (user-visible behavior and shared activation boundary; no schema/public API/security change)
- **Route**: PROCEED
- **Choice made**: Keep lazy creation limited to `.forge/config.yaml`, but render the canonical `standard` adoption profile for a new config. The existing config-file presence check preserves explicit `minimal` and explicit gate-disable choices; the registry's existing catch keeps command execution safe on write failure.
- **Status**: RESOLVED
