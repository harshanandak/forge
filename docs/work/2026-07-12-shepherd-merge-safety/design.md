# Shepherd merge-safety — trustworthy merge verdict (Tier-1)

**Issues:** c01936be, 35ee8d78
**Branch:** `feat/shepherd-merge-safety`
**Scope:** READ + verdict only. The shepherd still NEVER merges and NEVER
resolves threads. No resolve/reply verbs, no auto-trigger (that is Tier-2, left
filed).

## Rebase reconciliation (master shipped an overlapping model)

While this branch was open, another PR merged to `master` that reworked the same
files into a **pull-signal `blockers[]` model** — it already delivers: the
`--pull`/`--bundle` `output` plumbing, `REVIEW_BOT_LOGINS`/`AUTOMATION_BOT_LOGINS`/
`STATUS_BOT_LOGINS`, `classifyRequiredChecks` (missing/skipped/pending/failing),
`buildBotStatusBlockers` (Sonar/Vercel/Netlify/Codecov quality-gate COMMENT
scanning — the #353 class), `reviewDecision`+`isDraft`, `readIssueComments`,
conflict/behind/draft blockers, and `computeBlockers`/`renderPullSummary`.

The rebase therefore **adopts master's model as the base** and layers ONLY the
pieces master lacks, without duplicating its helpers or editing its reviewed
bot-sets:

- **`pr-shepherd.js`** — the two-set bot classification so an unresolved
  CodeRabbit *thread* makes the pass `NEEDS_REVIEW` (master's pr-shepherd still
  used the old single `BOT_LOGINS`; this is a genuine, unique fix).
- **`readReviews`** (adapter) — review-at-head oid; master has no review-at-head.
- **`readHeadCommitTime`** (adapter) — head-push time to anchor the settle window.
- **`computeVerdict`** (pr-pull) — a single fail-closed `verdict` enum that
  CONSUMES master's raw signals (mergeStateStatus, `classifyRequiredChecks`,
  `buildBotStatusBlockers` count, conflicts, behind, reviewDecision, thread count)
  PLUS review-at-head, settle window, torn-read, and UNKNOWN-on-unreadable.

### Adversarial false-clean fixes folded in (same pass)

- **F1** — CLEAN is reachable ONLY from an explicitly-good `mergeStateStatus`
  (`CLEAN`). `UNKNOWN`/`''`/`BLOCKED` fail closed to `UNKNOWN` (GitHub returns
  UNKNOWN while recomputing right after a push; the adapter also defaults UNKNOWN).
- **F2** — BLOCKED-THREADS gates on the RAW unresolved-thread count, so a thread
  missing `threadId`/`id` still blocks.
- **F3** — the settle window anchors to `max(headPushTime, latestReview,
  latestComment)`; a fresh green PR whose CI passed before the review bots ran is
  `REVIEW-PENDING`, not CLEAN. CLEAN also requires a KNOWN head-push time.
- **F5** — a code-review-bot direct comment is compared to the head-push time
  (not to later agent chatter), so an unrelated agent comment can't clear it.
- **F4** left as filed Tier-2 (no merge-path consumer yet).

### Agnostic actor classification (supersedes the two-set / F6 name lists)

Classification is by **MECHANISM, not by a hardcoded bot-name list** — a name
list fails closed the WRONG way (an unknown/new review bot not on the list has
its signal silently ignored → false-clean). Unknown actors default to BLOCKING.

- **Threads** — any unresolved, non-outdated review thread blocks
  (`BLOCKED-THREADS`), **author-agnostic**. `pr-shepherd.actionableComments` drops
  the author filter entirely; the verdict counts unresolved threads from the RAW
  `readComments` output (independent of master's display fix-list, which keeps its
  own filtering and tests).
- **Checks/status** — any failing/missing/skipped/pending required check OR a
  failing bot-status COMMENT (`buildBotStatusBlockers`) blocks (`BLOCKED-CHECKS`),
  with zero name knowledge. SonarCloud/Vercel/Netlify/Codecov surface here.
- **Direct comments** — a NON-HUMAN top-level comment newer than the last head
  push blocks. Non-human is detected generically: GraphQL `author.__typename ===
  'Bot'` OR a `[bot]` login suffix (`readIssueComments`/`readReviews` now surface
  `authorTypename`). The ONLY name list is an INVERTED **suppression allowlist**
  (`STATUS_BOT_LOGINS`) — known status/deploy/quality bots whose gate already
  blocks via checks, so their comment does not also drive an unresolvable
  `BLOCKED-THREADS`. Every bot NOT on the allowlist (known or unknown) is
  actionable.

This makes F6's intent intrinsic to the mechanism: SonarCloud's failing gate is a
failing check → `BLOCKED-CHECKS`; its unresolvable comment is a suppressed
status-bot comment → not `BLOCKED-THREADS`. No special-casing by name.

## Problem

The PR shepherd (the merge-safety surface) is untrustworthy. On PR #365 it would
have reported merge-ready while 13 CodeRabbit threads were unresolved. Four
verified root causes:

1. **Plumbing.** `bin/forge.js` prints only `result.output`/`result.error`;
   `lib/commands/shepherd.js` returned `{success, pull}` / `{success, bundle}` —
   neither field is serialized, so `forge shepherd <pr> --pull --json` and
   `--bundle --json` emitted NOTHING to stdout.
2. **Bot misclassification.** `lib/pr-shepherd.js` listed `coderabbitai` in
   `BOT_LOGINS`; `actionableComments` filtered those threads OUT, so a pass
   reached `MERGE_READY` with unresolved CodeRabbit threads. `lib/pr-pull.js`
   already had the correct split (`REVIEW_BOT_LOGINS` vs
   `AUTOMATION_BOT_LOGINS`) — adopt that model in `pr-shepherd.js`.
3. **No review-at-head check.** A stale CodeRabbit review (from an earlier
   commit) was treated as current, so post-push re-reviews were missed (the #365
   race). `headSha` was only used as a mutation guard.
4. **Author-agnostic direct comments missed.** Direct PR issue comments +
   submitted review bodies were not gathered author-agnostically (the #353
   "Additional Comments (N)" miss class).

## Verdict vocabulary (fail-closed precedence, top wins)

Computed in `gatherPullSignal` (lib/pr-pull.js) as a NEW `verdict` field
alongside the existing `state`. Never defaults clean.

| Rank | Verdict | Trigger |
|------|---------|---------|
| 1 | `UNKNOWN` | Any verdict-relevant read THREW (never default clean). Also: torn read (head oid moved during gather). |
| 2 | `BLOCKED-CONFLICT` | `mergeStateStatus === 'DIRTY'` (merge conflict). |
| 3 | `BEHIND` | `mergeStateStatus === 'BEHIND'` (branch behind base). |
| 4 | `BLOCKED-CHECKS` | A required check is FAILING, or a required check is SKIPPED under `strictSkipped` (default ON), or `mergeStateStatus === 'UNSTABLE'`. |
| 5 | `BLOCKED-THREADS` | An unresolved, non-outdated inline thread authored by a human or review-bot; OR a review-bot direct issue comment / `CHANGES_REQUESTED` review newer than the last head push / last agent reply. |
| 6 | `REVIEW-PENDING` | Latest review-bot review `commit.oid !== headOid` (review is stale vs head); OR the settle window is not yet met. |
| 7 | `CLEAN-MERGEABLE` | None of the above. Only reachable when every input was readable, head did not move, and nothing is outstanding. |

### Settle window

`now - max(latest review submittedAt, latest issue-comment createdAt) >= settleWindowMs`.
Default `600_000` ms (600 s), configurable via `ctx.settleWindowMs`. If the most
recent human/bot activity is inside the window, the PR has not settled →
`REVIEW-PENDING`.

### Torn-read guard

Head oid is re-read at the END of gather. If it differs from the head oid read at
the start, the whole snapshot is stale/untrustworthy → verdict downgraded to
`UNKNOWN` (never CLEAN). Evidence records `tornRead: true`.

### Fail-closed rule

Absent adapter method (older adapter that never implemented `readReviews` /
`readIssueComments`) is treated as "readable, empty" — NOT unreadable. Only a
method that THROWS marks its input unreadable → `UNKNOWN`. This keeps the verdict
meaningful for adapters that predate the new reads while still failing closed on
real read errors.

### Evidence

Every verdict carries `evidence` with the arrays that drove it:
`failingRequired[]`, `skippedRequired[]`, `unresolvedThreads[]`, `staleReviews[]`,
`botComments[]`, `changesRequested[]`, `unreadable[]`, `tornRead`,
`settleRemainingMs`, `headOid`.

## Changes by Tier-1 item

1. **Plumbing** (`lib/commands/shepherd.js`): `--pull` and `--bundle` returns add
   `output: JSON.stringify(payload)` so `bin/forge.js` prints it. Existing
   `pull` / `bundle` fields retained (back-compat). Registry-path test asserts
   stdout parses as JSON with the expected keys.
2. **Bot classification** (`lib/pr-shepherd.js`): replace single `BOT_LOGINS`
   with `REVIEW_BOT_LOGINS` (coderabbitai, greptile-apps, qodo-merge-pro,
   sonarqubecloud) + `AUTOMATION_BOT_LOGINS` (github-actions, codecov,
   dependabot). `actionableComments` now treats a thread with a human OR
   review-bot comment (not self, not pure-automation) as actionable →
   unresolved CodeRabbit threads make the pass `NEEDS_REVIEW`, not `MERGE_READY`.
3. **Adapter reads** (`lib/adapters/pr-state-adapter.js`): add `readReviews`
   (GraphQL `reviews(last:100){author{login} state submittedAt commit{oid}
   body}`, latest review per author with its commit oid) and `readIssueComments`
   (REST `issues/{pr}/comments`, AUTHOR-AGNOSTIC). Add `reviewDecision` to
   `PR_VIEW_FIELDS` and to the `readState` return.
4. **Verdict block** (`lib/pr-pull.js` `gatherPullSignal`): compute the
   fail-closed `verdict` above; attach `verdict` + `evidence` to the payload.
5. **Checks** (`lib/pr-pull.js`): required checks with conclusion `SKIPPED` go in
   `skippedRequired[]` and block under `strictSkipped` (default ON). Map
   `mergeStateStatus` and `reviewDecision` per the precedence.
6. **Tests** (all via injected gh/adapter deps — no live GitHub):
   - (a) #365 regression: all threads resolved but latest coderabbitai review
     `commit.oid !== headOid` → `REVIEW-PENDING`, never CLEAN.
   - (b) #353 regression: zero threads, one review-bot issue comment
     "Additional Comments (3)" post-push → `BLOCKED-THREADS`.
   - (c) 13 unresolved coderabbitai threads + green checks → pass state NOT
     merge-ready AND verdict `BLOCKED-THREADS`.
   - (d) fail-closed: a read throws → `UNKNOWN`.
   - (e) torn read: gh returns a different head oid across gather → not CLEAN.
   - (f) SKIPPED-required → `BLOCKED-CHECKS`.
   - (g) output contract from item 1.

## Explicitly NOT rebuilt (already correct)

Fully-paginated `readComments`; required-set null → escalate; `allRequiredGreen`
presence check; the dryRun read-only pass; the failure-log excerpt/dedupe
pipeline + token caps; the injected deps. The shepherd's "never merges / never
resolves threads" invariant stays intact.
