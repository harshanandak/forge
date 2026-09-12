# Tasks

## Task 1 - Preserve failed full-suite verdicts

Write a failing regression through the real validation test path where a nonzero full-suite child includes `not found` in its diagnostics. Prove the result is a failure, tests are not marked skipped, the summary is not successful, and no validation receipt is authorized. Then make the smallest shared classifier fix, retain real missing-executable behavior, and run the focused validation tests.
