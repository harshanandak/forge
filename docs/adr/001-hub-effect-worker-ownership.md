# ADR-001: Exclusive hub effect worker ownership

**Status:** Accepted, 2026-11-27 (forge-1957, forge-2007)

## Context

Workers can share a hub SQLite file through separate handles or processes.
Startup recovery can change active delivery records, and overlapping drains can
send duplicate edits.

## Decision

The database adapter exclusively creates a private lock beside the database
(`hub.sqlite.worker.lock` for `hub.sqlite`). Startup and direct drains share one
claim. Shutdown keeps the claim until active work settles, even after the
five-second close deadline. Release verifies the lock's identity and syncs the
parent directory on platforms that expose directory sync through Node.

## Crash recovery

A crash or failed safety check can leave the lock in place. Age and process IDs
never authorize takeover.
Before restarting, stop every hub process that uses the database, including any
supervised instances. Confirm no worker can still be using or acquiring the lock.
Verify the entry is the expected regular lock file, then delete only that file
from the private data directory and restart one hub service.
