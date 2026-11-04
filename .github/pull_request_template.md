<!--
Title: a plain-words conventional commit (it becomes the changelog line). No internal codes (lane, test or issue ids). A speed, size or work saving names the gain and its number.
Write for someone new to this change: short sentences, plain words, active voice, no em dashes.
No machine-local data: no drive paths, usernames, worktree paths, or links to files that only exist on your machine.
Fill every section in order and delete the hints. Write "None" rather than dropping a section.
-->

## Problem

<!-- What a user sees go wrong, or cannot do. One to three sentences, with a number where one exists (fails 4 CI runs in 100, takes 11 minutes). -->

## Root cause

<!-- Why it happens, with the evidence: a run, a trace, a line of code. If the cause is not proven yet, say so and say what this PR adds to find it. -->

## Fix

<!-- What changes, as bold one-line takeaways with a sentence or two each. The approach, not a file tour. -->

- **<One-line takeaway.>** <Detail.>

## Before / after

<!-- Observable differences: "when X happens, before: ..., after: ...". Never "didn't exist, now exists". Keep the table only where real numbers exist, and say how they were measured. -->

- When <X>: before, <...>; after, <...>.

| Measure | Before | After | How measured |
| ------- | ------ | ----- | ------------ |
|         |        |       |              |

## Value

<!-- Who benefits and what risk goes away. One or two bullets. -->

- <...>

## What review found

<!-- Each fixed finding: a bold failure a user would have seen, then the one-line fix. Deferred findings: name the issue id. "None yet" on the first push. -->

- **<What a user would have seen go wrong.>** Fixed by <one line>.
- Deferred: <finding> (<issue id>).

## Verification

<!-- One proof line per claim. The test that fails without the change (link pinned to the head commit), the CI run for the current head, local checks with exit codes. -->

- Fails without the change: [<test name>](https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L<n>)
- CI for the current head: <run link>
- Local checks: <commands and exit codes>

## Not verified

<!-- What you did not check and why, and what only the next runs or a later failure will prove. -->

- <...>

<details>
<summary>Notes for review</summary>

<!-- Shared-file changes, ordering with other PRs, size, what is deliberately left out, design choices with the options rejected, security impact if any. -->

</details>

## Models

- Planned: <display name> (<model id>, reasoning <level>) via <harness>
- Implemented: <display name> (<model id>, reasoning <level>) via <harness>
- Reviewed: <display name> (<model id>, reasoning <level>) via <harness>, or `not yet reviewed`

Tracking: <issue ids>
