# Bounded repository verification

`node tools/integration-step.ts <bun-executable>` runs integration-rest and the
shared-install pack smoke together. Child output reaches the CI log immediately;
it is never held behind an unbounded shell `wait`. Failures identify the child
and include its retained stdout/stderr tails. A failed child cancels its sibling.

`tools/runner-policy.json` declares repository execution limits. It does not
change individual test timeouts or runtime operation declarations.

| Key                | Current declaration | Validated range                                   |
| ------------------ | ------------------- | ------------------------------------------------- |
| `childTimeoutMs`   | 240000 ms           | Integer 1..600000, no greater than the step limit |
| `stepTimeoutMs`    | 300000 ms           | Integer 1..600000                                 |
| `cleanupTimeoutMs` | 5000 ms             | Integer 1..60000                                  |
| `maxOutputBytes`   | 1048576 per stream  | Integer 1..16777216                               |

The four-minute child limit includes the full serial integration suite. An
unsharded local Windows run was still completing passing counterfactuals when
the initial three-minute trial cutoff fired; its named suite, active file and
last output were retained. The declaration adds one minute above that observed
lower bound. The five-minute total step also bounds sequential smoke children.
The CI step has a six-minute external ceiling for a stalled parent event loop
and bounded cleanup. Successful work is not delayed. Individual test-case
limits remain unchanged.

Standalone suite/smoke runners create owned POSIX process groups. The combined
step marks nested children with the validated mechanism value
`FORGE_RUNNER_GROUP_SCOPE=inherited`, so they stay in their outer runner's group.
Cancellation kills that group. Windows uses bounded `taskkill /T /F` while the
direct child is still owned. A reaped Windows PID is never targeted again;
descendants that deliberately detach or outlive a reaped parent are not proven
owned by this tooling. Runtime commands retain their separate Job Object scope.

Execution and cleanup timers are independent. Even a missing exit event, held
pipe, or cleanup helper that never returns produces a bounded failure. Streams,
timers and helper handles are released when the runner settles. The runner adds
no idle process, worker or cache; retained output is bounded by the declared cap.
