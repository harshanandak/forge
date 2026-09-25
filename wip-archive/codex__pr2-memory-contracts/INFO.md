# codex/pr2-memory-contracts

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr2-memory-contracts
- branch: codex/pr2-memory-contracts
- HEAD: 272c4879d539e74444aca0270ea10c7afcb985e9
- last commit: 2026-08-10T03:24:09+05:30 "test(validation): align manifest owner expectations"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 15
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): codex/pr2-memory-contracts-hook-proof
- excluded: 
  - commits/0010-fix-memory-harden-contract-trust-boundaries.patch: packages/memory-contracts/fixtures/v1/feedback-secret-reject.json (secret-like name)
  - secret scan: dropped from commits/0010-fix-memory-harden-contract-trust-boundaries.patch: packages/memory-contracts/fixtures/v1/monitor-receipt-privacy-reject.json (password-literal); packages/memory-contracts/test/quality-review.test.js (password-literal); local copy kept outside the repo
  - secret scan: dropped from commits/0012-fix-memory-reject-Stripe-secret-keys.patch: packages/memory-contracts/fixtures/v1/structured-error-stripe-live-reject.json (stripe-key); packages/memory-contracts/fixtures/v1/structured-error-stripe-test-reject.json (stripe-key); packages/memory-contracts/test/quality-review.test.js (stripe-key); local copy kept outside the repo
  - secret scan: dropped from commits/0014-fix-memory-address-PR-review-findings.patch: packages/memory-contracts/test/quality-review.test.js (password-literal); local copy kept outside the repo

## restore

```
git switch -c restore/codex__pr2-memory-contracts 272c4879d539   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr2-memory-contracts/commits/*.patch
git apply wip-archive/codex__pr2-memory-contracts/uncommitted.diff
cp -r wip-archive/codex__pr2-memory-contracts/untracked/. .
```
