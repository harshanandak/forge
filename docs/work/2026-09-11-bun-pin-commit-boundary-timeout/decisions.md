# Decisions

## Decision 1

**Date**: 2026-09-11  
**Task**: Task 2 — executable resolution reuse  
**Gap**: Whether to batch Git object reads or remove repeated resolver startups first.  
**Score**: 3 / 14  
**Route**: PROCEED  
**Choice made**: Cache successful executable resolution because direct measurement attributes 7.38s per 100 calls to `where.exe`; this is the shared root seam and preserves all Git validation reads.  
**Status**: RESOLVED

