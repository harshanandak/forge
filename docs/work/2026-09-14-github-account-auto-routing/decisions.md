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

