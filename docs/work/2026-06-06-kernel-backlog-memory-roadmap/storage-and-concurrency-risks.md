# Storage and Concurrency Risk Register

## Storage decision matrix

| Surface | Role | Good for | Not good for | Required guard |
| --- | --- | --- | --- | --- |
| SQLite WAL Kernel DB | Local authority | One user, one physical machine, many worktrees sharing one canonical git common-dir, many local agents after real contention tests pass | Multi-machine distributed merge, network/cloud-sync filesystems, direct git merge of DB files | All writes through Kernel broker; atomic transaction/CAS/outbox; expected_revision; idempotency collision checks; DB-enforced claims; driver/filesystem doctor |
| Server serialized authority | Team authority | Multi-user/team writes, cross-machine agents, global ordering | Offline-first direct git merge | Project-scoped sequence, revisions, leases, replay, dead-letter queue |
| Beads/Dolt | Compatibility/projection/history substrate | Existing Beads users, git-like issue history, ready-work semantics, branch/merge experimentation, Dolt history/provenance | Replacing Kernel domain authority or shaping the Kernel write path | Fidelity tests, direct Dolt capability spike outside authority, dry-run export/import, extension field preservation, ready-work parity |
| FTS5/vector knowledge index | Read model | Search, orient, recap, frontend context panes | Source of truth | Full rebuild from docs/events; source citations required |
| Summaries/facts/graph triples | Derived proposals/read models | Conflict hints, stale decision detection, compact context | Authority without review | Provenance + explicit Kernel acceptance event |
| Evidence/log bundles | Archive | Validation proof, large artifacts, replayable evidence | Interactive work status | Content-addressing or stable refs from Kernel events |

## Main risks

### 1. Mistaking SQLite for Dolt

SQLite gives strong local transactional behavior. It does not give git-native distributed merge. If two machines independently mutate issue state and then merge files, Forge can lose ordering, leases, and conflict intent.

**Fix:** local-mode writes remain single-machine; team-mode writes require server authority.

### 2. Multiple agents in multiple worktrees racing

This is acceptable only when all worktrees resolve to the same git common-dir Kernel DB and all writes go through one broker transaction path.

**Fix:** test common-dir routing, busy timeout, idempotency keys, expected revisions, and claim leases.

### 3. Frontend confusing backlog, sprint, workflow stage, and issue status

A board should not overload one status field for everything.

**Fix:** separate `parent_id`, `status`, `release_id`, `sprint_id`, `stage_state`, owner/claim, and dependency readiness.

### 4. Knowledge layer becoming false authority

RAG summaries are useful but can drift or omit context.

**Fix:** index verbatim source first; keep summaries/facts as provenance-backed proposals until accepted by Kernel event.

### 5. Beads migration losing user data

Kernel may not initially model every Beads field.

**Fix:** preserve unsupported fields as provider extensions or report explicit fidelity loss before export.

## Safe implementation gates

1. Finish storage classification and Dolt capability comparison before storage rewrites.
2. Add local concurrency tests before claiming local multi-agent safety.
3. Add Beads fidelity fixtures before changing projection/import behavior.
4. Add orient/recap contracts before Hermes/frontend integration.
5. Add server sequence/revision design before team write claims.
