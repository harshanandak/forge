# Preserve timeout evidence

Issue: `6621bbf2-28d0-4b46-a18b-3fadad6fd60e`.
User authorized the delivery reliability prerequisite and parallel Claude work.

The full-suite timeout result drops captured stdout, hiding the actual resource
lane inventory. That contributed to an incorrect interpretation of partial
JUnit evidence as a complete run. Preserve observed output through the timeout
result and public command path, using existing helpers and result shapes.

Keep the result failed/incomplete, preserve observed budget metadata, retain
zero untrusted partial counts, and issue no validation receipt. Do not change
deadlines, add retries, skip tests, add dependencies, or change scheduler logic.
Existing non-timeout behavior must stay compatible.

One Claude owner may edit `lib/commands/validate.js` and
`test/commands/validate.test.js`. Root owns documentation, Git, issue state and
review. Any required shared formatter change must be explicitly reassigned.

Use injected exec failures for fast, deterministic RED/GREEN proof. Include
ETIMEDOUT and killed SIGTERM, stdout, stderr, both streams and empty capture;
test the public result/rendering path and absence of passing receipt. Run
focused tests/lint and obtain independent spec then quality review before
canonical validation. No broad suite during implementation.
