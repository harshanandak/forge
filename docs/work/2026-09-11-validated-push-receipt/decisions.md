# Decisions

- Keep validation evidence separate from `.forge-freshness` and the broad pre-push hook nonce; neither is exact-HEAD test authority.
- Use Node standard-library HMAC and atomic local files; add no dependency.
- Store the signing key outside the checkout and the receipt in the worktree Git directory.
- Optimize `forge push` only. Raw Git hooks and CI remain independent evidence paths.
- Do not remove or weaken tests for speed; broader Windows sharding changes require profile evidence and a separate issue.
