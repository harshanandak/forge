Decisions needed: none.

# Local read performance

Windows, Node 24.18.0. Baseline: main (6e3c10a). Each side was built and
packed separately, then its tarball was extracted into a separate scratch
installation. Both used the same pinned, already-installed dependencies.
Each equivalent Git project had the delivery template, an npm test script
and one existing issue before timing. No package manager ran inside a sample.

Each sample launches Node directly on the installed `dist/bin/forge.js`,
captures output and waits for process exit. These are cold processes;
filesystem caches are retained. Seven main/branch pairs were measured for
each command, counterbalancing which side runs first in successive pairs.
All 98 samples exited zero. An earlier partial batch was discarded before
rebuilding the final artifact with the shorter finalization allowance.

Seconds, median [minimum–maximum]:

| Command                     |                  Main |               Branch |
| --------------------------- | --------------------: | -------------------: |
| help                        |   2.869 [1.545–5.635] |  1.205 [0.929–3.092] |
| config show                 |   2.695 [2.117–4.386] |  1.304 [0.998–2.541] |
| issue show                  |   2.737 [2.417–3.172] |  1.591 [1.155–2.458] |
| issue list                  |   2.375 [1.997–3.822] |  1.335 [1.013–2.619] |
| check list                  |   4.584 [3.589–6.360] |  2.384 [1.556–3.676] |
| catalog describe issue.show |  6.357 [3.505–10.501] |  2.176 [1.156–4.554] |
| issue create                | 11.020 [6.467–18.391] | 8.792 [5.939–13.776] |

CPU utilization, sampled over one second at each endpoint: 100% at start
and end; average across the timed batch: 99.98%. Each branch median is
below main's median. The ranges overlap for every command; this loaded-host
comparison does not establish a universal latency budget.

Confirmed Git starts per command, main → branch: help 0 → 0; config show,
issue show, issue list and issue create 1 → 1; check list 2 → 1; catalog
describe 0 → 0. A separate instrumented pass followed the Windows
supervisor's confirmed target-start messages. Instrumentation was absent
from timed samples. `icacls` and `whoami` were 0 → 0 for every command:
this packed baseline already omits the legacy helper from its store path.
The native enforcement added here requires no per-write tool launches.

## Preparation and security

CLI reads reuse one discovery view for argument parsing, visibility and
dispatch. MCP transport loads when opened. Ordinary config show reuses the
composition snapshot. A later call still observes changed declarations and
origin configuration; mutation authority is checked at invocation time.

An operation without file effects receives a files capability that refuses
access without starting Git discovery. File operations retain discovery,
containment, lifetime and effect checks. The regression fails with the old
acquisition path and passes with the refusal path.

Windows state uses the existing native Windows dependency through a typed
security boundary. A store directory gets an owner-only inheritable DACL
when its current DACL is wrong. Files are checked before use or before
writing payloads. Unexpected file ACLs fail with the path and repair advice.
Successful checks cache file identity and change time within the process;
replacement or ACL changes invalidate the check. Reads do not repair ACLs.
The legacy recovery-hardening helper and its refusal tests remain intact.

The directory/write regression fails without the security wiring. Real
Windows tests verify inheritance, refusal after broadening a file's ACL,
cache invalidation and subsequent repair. No reset-to-public ACL step occurs.

Five 512 KiB seal/write/readback samples through an open native-ACL SQLite
state owner took 421.30–1199.21 ms (median 562.43 ms), excluding store opening.
Receipt finalization now reserves 1000 ms plus 128 KiB/s: five seconds at
512 KiB, down from 33 seconds. Tests retain exact-cap receipts and rejection
when finalization exceeds its allowance.

## Verification limits

The focused ACL and provider run passed 15 tests, including real Windows
ACL changes. Receipt and budget checks passed 29 tests. Type checking and
the isolated-declarations build check passed. The structure run passed
107 checks. Canary lint reports three unchanged warnings tracked by
forge-307; no rule is relaxed.

The initial full unit run finished with 857 passes, two skips and four
failures (three timeouts and one generated-file rename error). A final
run was interrupted after exceeding six minutes without a summary; it
reported timeouts, EBUSY cleanup and resumed UNKNOWN_COMMAND assertions.
Full unit verification is incomplete. The full integration lane and a
new-head hosted CI result are not verified locally.
