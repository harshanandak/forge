# Decisions: transparent GitHub account routing

- Automatic routing is a separate clone-local opt-in; an existing binding does
  not silently change arbitrary `gh` behavior.
- A pass-through `gh` proxy is the only general mechanism that also covers
  already-open T3 Code, VS Code, and terminal processes without shell-specific
  environment hooks.
- HTTPS Git uses a URL-scoped helper owned by the enabled clone. SSH stays
  native and unchanged.
- Native GitHub CLI stores remain authoritative. Forge holds credentials only
  for the duration of one child invocation or credential request.
- The entire `gh auth` namespace bypasses routing to avoid interfering with
  login and recovery.
- No token caching until measured proxy latency proves it necessary.
- Named-token retrieval is sufficient on the hot path. Live identity verification
  belongs at enable/status boundaries, not before every `gh` or Git operation.
- Aliases and extensions are user-installed executable behavior and inherit the
  selected child environment; only native account-management and local-only
  operations bypass routing. Arbitrary code inside them remains outside Forge's
  wrong-destination guarantee.
- Machine-global router cleanup requires machine-local knowledge of opted-in clone
  paths. The registry stores only canonical clone and Git common-directory paths,
  never credentials. Forge reads live `github.auto` state and recognizes router
  ownership from the launcher marker; unavailable evidence fails closed.
- Public GitHub routing is the V1 boundary. Explicit enterprise targets fail
  closed instead of receiving or falling back from the public account context.
- Performance and installed-product behavior are acceptance requirements, not
  post-merge optimizations.
