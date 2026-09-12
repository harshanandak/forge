# Bun pin commit-boundary timeout

## Problem

The focused Bun workflow-pin authority test exceeds its existing 30-second budget on Windows because every secured Git call launches `where.exe` before launching Git.

## Decision

Cache only successful executable resolutions for the current process. Key the cache by platform, command, `PATH`, and `PATHEXT`; injected resolvers remain uncached unless a test supplies its own cache. Do not change timeouts, assertions, scheduling, dependencies, or authorization behavior.

## Success

- Repeated secure executions resolve the same executable once.
- A changed executable environment triggers a fresh resolution.
- Failed resolutions are retried rather than cached.
- The original focused 30-second test passes on Bun 1.4.2.
