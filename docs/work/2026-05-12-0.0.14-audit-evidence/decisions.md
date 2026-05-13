# Decisions: 0.0.14 audit evidence persistence

## Decision 1

**Date**: 2026-05-12
**Task**: Planning
**Gap**: The installed `bd audit` command exposes `record` and `label`, but no `--meta-json` flag and no working `verify` subcommand in the current help output.
**Score**: 2/14
**Route**: PROCEED
**Choice made**: Keep Beads as the source of truth with `bd audit record` and `bd audit label`; add only a minimal `.forge/log.jsonl` metadata fallback that references the Beads entry ID when richer upstream metadata is unavailable.
**Status**: RESOLVED
