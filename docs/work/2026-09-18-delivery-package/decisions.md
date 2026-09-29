# Windows standalone package installation reliability

- Issue: `48386b65-4cab-4e75-9363-07a352e5997e`
- Actor: `sol-delivery-package-20260918`
- Authorized scope: diagnose the current Windows package smoke failure and implement only a measured root-cause fix. No push or PR.
- Baseline: `origin/master` and branch HEAD at `bd1abbd8ab63b590fd916dad379e0a575542fcc7`; worktree clean at lane start.
- Historical evidence: hosted Windows Node 22 root installation returned `status=null` near the 60-second test limit. This is historical evidence, not a local reproduction.
- Local condition: Windows with Node v24.18.0, Bun 1.4.2, npm 11.16.0, and Git 2.51.0.windows.1.
- Diagnosis rule: measure pack, install, installed CLI version, and setup independently; record bounded outputs and child termination fields. Vary one suspected cause per experiment and keep the real fresh-directory install and installed CLI journey.
- Repeat plan: after a proven fix, run three consecutive real package journeys and report every elapsed time plus cache/network conditions. Three runs are a bounded confidence sample, not flake certification.

## Diagnosis

- The historical hosted job used Node v22.23.2, npm 10.9.8, and Bun 1.4.2. Its 60-second test deadline killed the active synchronous npm child: `status=null`, `signal=SIGTERM`, one dangling process killed. A 50 ms focused probe reproduced that termination signature.
- A verified portable Node v22.23.2/npm 10.9.8 control passed only narrowly at 59,565 ms: pack 11,475 ms, install 27,701 ms, installed CLI version 8,542 ms, setup 11,120 ms. The portable runtime was isolated from machine configuration.
- npm 10 ran the root `prepare` lifecycle during `npm pack --ignore-scripts`; the command invoked `lefthook install` while building the tarball. A tiny marker package proved that `--ignore-scripts` and `npm_config_ignore_scripts=true` do not suppress `prepare` in this runtime.
- Same-artifact shim/direct ABBA timings were 6,580/472/582/689 ms. The warmed shim matched direct Node, so persistent shim overhead was rejected. Cold process/file-cache cost remained observable but was not changed.

## Decision

- Guard the existing root `prepare` command when `npm_command=pack`. Preserve normal development hook installation and the existing nonfatal diagnostic when Lefthook is unavailable.
- Keep the existing 60-second test limit and existing child behavior. The focused helper regression injects a child timeout to prove null/`ETIMEDOUT` diagnostics without introducing a new install-budget policy.
- Record each operation's elapsed time, status, signal, error, and the last 2,000 characters of stdout/stderr. The tarball continues to contain 663 entries and bundle `@forge/contracts`, `@forge/memory`, and `@forge/flow`.

## Evidence

- RED: the controlled root-prepare test proved both branches: development invoked the mock Lefthook, while pack incorrectly invoked it too. The pack assertion failed.
- GREEN: the same test now invokes the mock Lefthook for development and skips it for pack. The child-bound test returns `status=null`, `signal=SIGTERM`, and `ETIMEDOUT` before its test deadline; a separate status-7 child proves bounded stdout and stderr preservation.
- Post-fix exact Node 22/npm 10 sample, unchanged 60-second limit: 20,775 ms, 21,504 ms, 22,159 ms. Phase timings were pack 2,568/5,374/5,615 ms; install 6,376/6,107/7,061 ms; version 8,419/6,338/6,086 ms; setup 2,951/3,062/2,918 ms. All child statuses were zero with null signal/error.
- The post-fix sample used a cached portable runtime and warm npm/network/filesystem state on a lightly loaded machine. A focused renderer test briefly overlapped part of the repeat window. The cold pre-fix versus warm post-fix total delta is not attributed solely to the guard, and three passes are not flake certification.
- Hosted Windows Node 22 final-head and merged-commit checks remain required. Local Node 24 and portable Node 22 evidence does not prove hosted reliability.
