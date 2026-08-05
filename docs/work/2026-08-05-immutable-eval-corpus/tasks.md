# Tasks

## Task 1: RED contract tests

OWNS: `test/eval/immutable-corpus.test.js`

Write focused tests for all 14 case classes, 30/100/300 manifests, the exact
60/40 split and trial indices, hash binding, deterministic oracle behavior,
tamper/leakage fail-closed behavior, and observer mutation/polling rejection.

## Task 2: Corpus and oracle implementation

OWNS: `eval/corpus/packets.json`, `eval/corpus/manifest-30.json`,
`eval/corpus/manifest-100.json`, `eval/corpus/manifest-300.json`,
`scripts/lib/immutable-eval-corpus.js`

Implement the smallest pure loader/oracle boundary. Keep packet and manifest
hashes independent of runtime evidence and reject all untrusted extra fields.

## Task 3: Focused GREEN validation

OWNS: none beyond Task 1/2.

Run the focused suite, lint the changed JavaScript, inspect the diff for scope
violations, then run the required repository validation before shipping a draft
PR based on the approval-policy fix and dependent on PR #483.
