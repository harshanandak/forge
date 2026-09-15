# Forge delivery environment research brief

Requested 2026-09-15: preserve the architecture research by committing it, then investigate a reliable and sustainable environment for 5-10 PRs per day. Current user concerns: slow/unreliable Windows tests, costly parallel branch pushes, repeated mandatory base updates, and serialized merge friction.

Success: identify measured bottlenecks in local validation, CI, Git/worktrees and merge policy; distinguish current behavior from proposals; recommend a small ordered change plan that preserves required quality/security evidence and avoids duplicated work. Retain research for later implementation.

Scope: read-only source/history/environment/CI investigation and saved planning artifacts. No test-runner, CI, branch-protection, machine configuration, security-exclusion or production change is authorized by this brief. Do not start expensive overlapping full suites, terminate user processes or clean user worktrees. Research preservation may use an isolated documentation worktree and normal commit/push gates. No new PR is requested.

Research lanes: Windows test runner and process/isolation behavior; hosted CI timings and workflow duplication; push/receipt/freshness/merge control path; main agent owns preservation, environment inventory and synthesis. Findings require tracked origin/master source references or live read-only evidence. Existing research and fixes should be reused. Review the final proposal independently before treating it as ready for implementation.
