<!--
Title: a plain-words conventional commit (it becomes the changelog line). No internal codes (lane, test or issue ids).
Write for someone new to this change: short sentences, plain words.
No machine-local data: no drive paths, usernames, worktree paths, or links to files that only exist on your machine.
Delete the hints as you fill each part in.
-->

<!-- Opening, 2–3 plain sentences: the problem from the user's side, then what this changes. -->

## <Topic name>

<!-- 2–4 sections like this, named for the topic, not the file. Start each bullet with a bold one-line takeaway. -->

- **<One-line takeaway.>** Detail in a sentence or two.

## Before / after

<!-- Concrete, observable differences: "when X happens, before: …, after: …". Never "didn't exist, now exists". -->

- When <X>: before, <…>; after, <…>.

<!-- Add a numbers row only where real numbers exist, and say how you measured them. Otherwise drop the table. -->

| Measure | Before | After | How measured |
| ------- | ------ | ----- | ------------ |
|         |        |       |              |

## What review found

<!-- Each blocker: a bold failure the user would see, then the one-line fix. Minor findings deferred: name the issue id. -->

- **<What a user would have seen go wrong.>** Fixed by <one line>.
- Deferred: <minor finding> (<issue id>).

## Notes for review

<!-- Things a reviewer should know: shared-file changes, ordering, what is deliberately left out. -->

- <note>

## Verification

<!-- Counts, the tests that fail without the change (GitHub URLs pinned to the head commit), and the CI run for the current head. -->

- <N> tests pass; checks run: <commands>.
- Fails without the change: [test name](https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L<n>)
- CI for the current head: <run link>

**Not verified:** <what you did not check>

Reviewed with Codex code review: <N> rounds.

Tracking: <issue ids>

## Models

- Planned: <display name> (<model id>, reasoning <level>) via <harness>
- Implemented: <display name> (<model id>, reasoning <level>) via <harness>
- Reviewed: <display name> (<model id>, reasoning <level>) via <harness>, or `not yet reviewed`
