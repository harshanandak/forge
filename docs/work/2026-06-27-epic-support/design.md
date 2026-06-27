# Epic support for the Forge kernel — design

Status: DESIGN + PLAN (no product code beyond an optional, clearly-marked stub).
Branch: `design/epic-support` (off post-#245 master).
Author: forge-team de-bead follow-up.

## Why this exists

The forge-team de-bead left two surfaces that still call `bd` because the epic
**rollup** does not cleanly map to the kernel:

- `scripts/forge-team/lib/epic.sh` — epic → list child issues + roll up status
  counts + per-developer breakdown + blocked list.
- `scripts/smart-status.sh` — line 209 `bd children <epic> --json`, used to build
  `epicStats[epic] = { total, closed }` that feeds `epic_proximity` scoring.

The root cause is a missing query primitive: the kernel has **no** "children of
epic X" query and **no** exposed reverse-dependency ("who depends on X") query.
Today the only workarounds are full-backlog scans (see `dashboard.sh` reverse
scan) or beads-only text parsing (`epic.sh` parses the `BLOCKS` section of
`bd show`).

These are the **last bd-hot-path surfaces besides the sync-cluster.**

## What the kernel already has (verified)

- **`parent_id` is a first-class, writable, validated, indexed field.**
  - Schema: `lib/kernel/schema.js:76` `field('parent_id','TEXT',{references:'issues.id'})`
    plus `index('idx_kernel_issues_parent', ['parent_id'])` at `:91`.
  - Writable: `lib/kernel/broker.js:466` maps `--parent` → `payload.parent_id` on
    **create**; `:488` (KAP-5) reparents on **update**. `parent_id` is in
    `ISSUE_MUTABLE_COLUMNS` (`sqlite-driver.js:867`).
  - Validated: `lib/kernel/taxonomy-validator.js` rejects self-parent (`:101`),
    missing parent (`:245`), and walks the `parent_id` **chain** to detect cycles
    (`:260-274`) — i.e. multi-level hierarchies are already permitted.
  - Projected: `rowToIssueSummary` (`sqlite-driver.js:198`) already emits
    `parent_id` on every read.
- **smart-status scoring already keys on `parent_id`**:
  `lib/smart-status/scoring.js:121-126` `getEpicProximity(issue, epicStats)` looks
  up `epicStats[issue.parent_id]`.
- **Dependency direction is confirmed.** `kernel_dependencies(id, issue_id,
  blocks_issue_id, dependency_type, created_at)`. A row means `issue_id` depends
  on / is blocked-by `blocks_issue_id`. The CLI help is explicit:
  `dep add` = "Add a dependency edge (issue-id blocked by blocks-issue-id)"
  (`_issue.js:86`). So `dep add A B` → `{issue_id:A, blocks_issue_id:B}` →
  `A.dependencies = [B]`. Confirmed at `applyAcceptedDependencyAddEvent`
  (`sqlite-driver.js:1045`).
- **The reverse edge already exists internally but is not exposed.**
  `computeNewlyUnblocked` (`sqlite-driver.js:905`) runs
  `SELECT DISTINCT issue_id FROM kernel_dependencies WHERE blocks_issue_id = ?` —
  that *is* the reverse-dependency ("who depends on X") query. It is private to
  the close path; no read op surfaces it.
- **Read-op pattern is uniform and easy to extend.** Every read in
  `runIssueReadOperation` (`sqlite-driver.js:347`) calls `loadBoardReadiness`
  → `{issues, index, claimedById, dependenciesById}`, maps rows via
  `rowToIssueSummary`, returns `okIssueResponse('issue.<op>', {issues, count})`.
  Existing read ops: `list, ready, show, search, stats, blocked, stale, orphans,
  lint`. Adding `children` slots into the same shape.

---

## 1. Epic-membership model — the key decision (RECOMMEND: `parent_id`)

**Recommendation: model epic membership as `child.parent_id = epic.id`** (the
existing first-class field), NOT as dependency edges.

Rationale — the dependency-based alternative is unsound in the kernel *regardless*
of edge direction:

- If membership is **child-depends-on-epic**: every child carries a live blocker
  (the epic) and is never `ready` until the epic is `done` → the readiness model
  and `ready` queue are poisoned (children never surface as workable).
- If membership is **epic-depends-on-children**: every epic shows `blocked`, AND
  the `kernel_dependencies` table can no longer distinguish a *membership* edge
  from a *genuine blocking* edge — `dep`, `blocked`, and readiness all conflate
  the two.

Either direction is strictly worse than a dedicated `parent_id` field. `parent_id`
is already writable, validated, indexed, projected, and consumed by smart-status
scoring. It does not overload dependency semantics. This is the sound choice.

Cost / open question (surfaced for the maintainer): the **beads** epic model is
dependency-encoded — `epic.sh` discovers children by parsing the `BLOCKS` section
of `bd show <epic>`. There is **no beads→kernel `parent_id` backfill** today
(`lib/issue-sync` references only `forge.parentId` as a synced authority field and
a `parentId: null` default). So existing epics will not have `parent_id` populated
unless either (a) they are migrated (derive `parent_id` from the existing epic↔child
dependency edges) or (b) kernel epics are treated as greenfield (new issues set
`--parent`; old epics are re-tagged manually). This is **OPEN DECISION #2** below.

---

## 2. Query primitive(s) + JSON contract

Two additions, both building on the existing `loadBoardReadiness` /
`rowToIssueSummary` / `okIssueResponse` machinery.

### 2a. `forge issue children <epic> [--json]` — children + rollup

New read operation `children`. Driver implementation (sketch, in
`runIssueReadOperation`, `sqlite-driver.js`):

```js
if (operation === 'children') {
  const epicId = firstPositional(args);
  const epicRow = allParams(runtime, db, 'SELECT * FROM kernel_issues WHERE id = ?', [epicId])[0];
  if (!epicRow) { /* FORGE_ISSUE_NOT_FOUND, exitCode notFound — mirror `show` */ }
  const { issues, index, claimedById, dependenciesById, dependentsById } =
    loadBoardReadiness(runtime, db, context);
  const children = issues
    .filter(row => row.parent_id === epicId)           // DIRECT children (one level)
    .map(row => rowToIssueSummary(row, index.readinessById[row.id],
                                  claimedById[row.id], dependenciesById[row.id],
                                  dependentsById[row.id]))
    .sort((a, b) => (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)));
  const rollup = buildRollup(children);               // counts by status + derived
  return okIssueResponse('issue.children', {
    epic: { id: epicRow.id, title: epicRow.title, type: epicRow.type, status: epicRow.status },
    children,
    rollup,
    count: children.length,
  });
}
```

**Rollup is computed in the kernel, not the shell consumer.** This is deliberate:
the kernel owns the status vocabulary (`open|in_progress|review|done|cancelled`),
which differs from the beads `closed` the shells currently count. Emitting the
rollup means consumers never hard-code status names.

JSON contract (`issue.children` response `data`):

```json
{
  "epic":   { "id": "forge-123", "title": "…", "type": "epic", "status": "open" },
  "children": [ <issueSummary>, … ],
  "rollup": {
    "total": 7,
    "done": 3,
    "in_progress": 1,
    "open": 3,
    "cancelled": 0,
    "review": 0,
    "blocked": 2,
    "percentage": 42,
    "by_status": { "open": 3, "in_progress": 1, "review": 0, "done": 3, "cancelled": 0 }
  },
  "count": 7
}
```

- `done` is the completion count (status `done`). Whether `cancelled` also counts
  as "complete" for `percentage` is **OPEN DECISION #4** (rollup semantics).
- `percentage = round(done / total * 100)`, `0` when `total == 0`.
- `blocked` = children whose `readinessById[id].blocked === true`.
- Each `<issueSummary>` is the existing shape (see §2c) and already carries
  `assignee` (→ `owner`), `status`, `title`, `dependencies`, and the new
  `dependents` / `blocked_by`. That is everything `epic.sh` needs for its
  per-developer breakdown and blocked list.

CLI wiring: add `children` to `SUBCOMMANDS` in `lib/commands/_issue.js` (a READ,
so NOT in `WRITE_SUBCOMMANDS`), add `children: 'children'` to
`KERNEL_ISSUE_OPERATIONS` in `lib/adapters/kernel-issue-adapter.js`, and register
`command('issue.children', 'forge issue children <id> --json', 'children', 'read',
…)` in `lib/kernel/issue-command-contract.js`.

### 2b. Reverse-dependency exposure — extend the summary, no new verb

The reverse-dep need ("what blocks X" / "who depends on X") that forge-team and
smart-status want is best served by **adding two fields to the issue summary**
rather than a standalone verb, so *every* read op carries them:

- `dependents: string[]` — ids that depend on this issue (reverse of
  `dependencies`). Build a `dependentsById` map in `loadBoardReadiness` exactly
  like the existing `dependenciesById`, but keyed by `blocks_issue_id` with
  `issue_id` pushed (the inverse of the loop at `sqlite-driver.js:251-261`). This
  is the same query `computeNewlyUnblocked` already uses, lifted to the board load.
- `blocked_by: string[]` — surface `index.readinessById[id].blocked_by` (already
  computed by the readiness model, `readiness-model.js:187`). Today only the
  boolean `blocked` is projected; the array is dropped.

This directly serves `smart-status`'s `.dependents` / `.dependent_count`
(`= dependents.length`) and `.dependency_count` (`= dependencies.length`), and
gives `epic.sh` per-child `blocked_by` for its blocked list — without any new
command.

### 2c. Issue-summary projection change (contract)

`rowToIssueSummary` (`sqlite-driver.js:179`) gains a 5th arg `dependentIds` and
two fields:

```js
dependencies: Array.isArray(dependencyIds) ? dependencyIds : [],
dependents:   Array.isArray(dependentIds)  ? dependentIds  : [],   // NEW
blocked_by:   readinessEntry ? (readinessEntry.blocked_by ?? []) : [], // NEW
```

**Contract blast radius (verified):** `ISSUE_SUMMARY_SCHEMA`
(`issue-command-contract.js:31`) does **not** set `additionalProperties: false`
(JSON Schema defaults to permissive), so the new fields do **not** break
schema-validation tests. Still, add them to the schema `properties` for hygiene
and discoverability:

```js
dependents: { type: 'array', items: { type: 'string' } },
blocked_by: { type: 'array', items: { type: 'string' } },
```

Because the projection is shared, the new fields appear on `list/ready/show/
search/blocked/stale/orphans` too — a strict superset, backward compatible.

---

## 3. De-bead plan (concrete swaps for a follow-up PR)

### 3a. `scripts/smart-status.sh` — `bd children` → `forge issue children`

Single-line swap at `:209`, plus use the kernel rollup instead of recomputing:

- Replace `CHILDREN_JSON="$("$BD" children "$epic_id" --json …)"` with
  `forge issue children "$epic_id" --json` (via the de-beaded forge issue entry).
- Replace the `jq 'length'` / `select(.status=="closed")` math (`:210-211`) with
  the kernel rollup: `TOTAL = .rollup.total`, `CLOSED = .rollup.done`. This drops
  the `closed`-vs-`done` vocabulary mismatch entirely.
- `epicStats[epic] = { total, closed }` stays the same shape, so
  `smart-status-score.js` / `scoring.js:getEpicProximity` are untouched.

### 3b. `scripts/forge-team/lib/epic.sh` — replace text-parsing with one JSON call

`epic.sh` today does: parse `BLOCKS` from `bd show <epic>` (`_epic_parse_blocks`),
then `bd show <child>` per child to scrape status/owner/title/blocked_by
(`_epic_get_child_info`), then assemble counts, per-dev, blocked, JSON.

Replace the whole discovery + per-child scrape with a **single**
`forge issue children "$issue_id" --json` call:

- children list ← `.children` (each item has `id`, `status`, `title`,
  `assignee`→owner, `blocked_by`).
- `total/done/in_progress/open_count/percentage` ← `.rollup` (no manual counting).
- `by_developer` ← group `.children` by `.assignee` in `jq` (replaces the
  `dev_entries` accumulation loop).
- `blocked` ← `.children[] | select(.blocked) | "\(.id) blocked by \(.blocked_by|join(\",\"))"`.

This removes `_epic_parse_blocks`, `_epic_get_child_info`, and the N× `bd show`
fan-out — one query instead of `1 + 2N` bd invocations. The existing JSON output
shape of `cmd_epic` (`epic_id,title,total,done,in_progress,open_count,percentage,
children,by_developer,blocked`) is preserved, so its tests stay valid (mocks
updated to the new single command).

### 3c. Ordering note

3a and 3b both depend only on the kernel `children` verb + summary fields from §2.
They are independent of the sync-cluster de-bead. The `dependencies`-shape
mismatch (kernel emits `dependencies` as string ids; `scoring.js:buildDependentsMap`
reads `.dependencies[].depends_on_id` objects) and smart-status's `bd list` →
`forge issue list` swap belong to the **sync-cluster** de-bead, NOT this task —
noted here so the follow-up PR does not accidentally rely on them. With kernel
`dependents` exposed (§2b), smart-status can read `.dependents` directly and the
`depends_on_id` fallback becomes moot — but flipping that is sync-cluster scope.

---

## 4. Open decisions for the maintainer

1. **Membership model.** Recommend `parent_id` (§1). Confirm — this is the
   foundation for everything else.
2. **Backfill vs greenfield.** Do existing (beads, dependency-encoded) epics need
   their membership migrated to `parent_id`, or are kernel epics greenfield going
   forward? Needs a data audit. Backfill = derive `parent_id` from existing
   epic↔child dependency edges; greenfield = new `--parent` only, old epics
   re-tagged manually. (This is the main cost of the §1 recommendation.)
3. **Surface shape.** Add a dedicated top-level `forge epic <id>` command, or
   keep it as `forge issue children <id>` (+ the rollup in the response)? Recommend
   `forge issue children` (fewer surfaces, reuses the issue contract); a `forge
   epic` alias can wrap it later if desired.
4. **Rollup semantics.** (a) Does `cancelled` count toward "complete" in
   `percentage`, or only `done`? (b) Direct children (`WHERE parent_id = ?`, one
   level — what both consumers use today) vs transitive (recursive CTE over the
   `parent_id` chain that taxonomy-validator already allows)? Recommend: `done`
   only for percentage; direct children by default, with a possible
   `--recursive` flag deferred until a consumer needs it.
5. **`children` target validation.** Require `type == 'epic'`, or return any
   issue's children? Recommend: accept any issue (don't hard-gate on type — the
   parent_id field is generic), but error `FORGE_ISSUE_NOT_FOUND` when the id does
   not exist (mirrors `show`, and `epic.sh` already has a not-found path).

## Appendix — files touched by the implementation follow-up (not this PR)

- `lib/kernel/sqlite-driver.js` — `dependentsById` in `loadBoardReadiness`;
  `dependents` + `blocked_by` in `rowToIssueSummary`; `children` op in
  `runIssueReadOperation`; `buildRollup` helper.
- `lib/kernel/issue-command-contract.js` — `dependents` + `blocked_by` in
  `ISSUE_SUMMARY_SCHEMA`; `issue.children` command + response schema.
- `lib/adapters/kernel-issue-adapter.js` — `children` in `KERNEL_ISSUE_OPERATIONS`.
- `lib/commands/_issue.js` — `children` in `SUBCOMMANDS` (read).
- `scripts/smart-status.sh` (§3a), `scripts/forge-team/lib/epic.sh` (§3b) + tests.
