# Root standalone package install timing

- [x] Trace the packed root install journey and every shared helper/caller from `origin/master`.
- [x] Add one focused regression proving exact `--version` and `-V` avoid the command graph.
- [x] Add the coordinated minimal `bin/forge.js` exact-version fast path without changing mixed-argument behavior or module import semantics.
- [x] Apply the smallest shared root-cause fix while preserving the public CLI journey, cleanup, and child-failure reporting.
- [x] Run only the focused RED/GREEN package checks after the execution slot is granted.

## Evidence

- RED: preload guard caught `../lib/plugin-manager`; 0 passed, 1 failed in 184.13 ms.
- GREEN: both exact version aliases passed without a `../lib/*` load; 1 passed, 0 failed in 320.66 ms.
- Packed root journey: unchanged install/version/setup case passed at the existing 60-second deadline in 50,762.81 ms.
- Independent spec review: PASS. Root quality review: PASS.
