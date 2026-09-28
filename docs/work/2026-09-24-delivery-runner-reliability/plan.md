# Delivery reliability prerequisite

Issue: `a04a58d4-9266-4fff-8c1a-24cd6bd014fe`.
The user authorized continuing with multiple Claude agents on 2026-09-24.

## Objective

Remove a proven shared cause of slow or incomplete validation before retrying
the preserved Shepherd patch. Keep every required test, existing deadline,
permission boundary, and signed-receipt requirement.

## Evidence already available

At Shepherd commit `3d7142d0a6350e7d39b99ba8568755cb1d2f896a`, one canonical
run with budget two exceeded its 25-minute test deadline. The recorded prefix
consumed at least 1468.759 seconds of the 1500-second deadline. Independent
Claude review corrected the earlier completeness assumption: the exclusive
lane has 17 files; only its first file completed, the second was still running,
and 15 had not started. Five JUnit files are not all required shards. Missing
aggregate/profile does not demonstrate a shutdown or output-drain defect.
Dependency-ripple and smart-status shell fixtures also timed out; one isolated
diagnostic passed all seven tests in 17.608 seconds. The smart-status child has
a 30-second limit inside a 20-second test. These facts do not establish CPU
load, output draining, or test ordering as the ultimate cause.

Raw evidence is preserved under the common Git directory at
`forge/verification-artifacts/shepherd-3d7142d0/`. Kernel issue comments carry
the detailed measurements and their limits.

## Work boundaries

Two read-only Claude lanes cover runner terminal/output behavior and shared
shell-fixture process cost. They must propose bounded distinguishing checks,
not repeat the broad suite. After comparing findings, one implementer owns each
non-overlapping change; shared runner/helper changes have one owner.

Choose the smallest reproduced shared defect or measured redundant work. Reuse
existing helpers and tests. Do not add a generic instrumentation framework,
new dependency, scheduler service, timeout increase, skipped test, or exemption.
Keep Shepherd and unrelated machine/configuration work separate.

## Proof required

Before production edits, reproduce the chosen bad case with a focused runnable
check. The correction must preserve failure propagation, complete required
coverage, child cleanup, and honest incomplete/terminal evidence. Compare
before/after using the same bounded workload. Then obtain independent spec and
quality review before one canonical validation of the selected clean head.
