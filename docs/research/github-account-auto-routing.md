# Transparent GitHub account routing

Decisions needed: none.

## Scope Assessment

**Strategic/Tactical**: Strategic

This extends the account-context trust boundary from explicit Forge children to
ordinary `gh` and HTTPS Git processes started from a bound clone.

## Existing evidence

- Forge already validates a named native GitHub CLI login, stores only
  clone-local `github.account`, and injects its token into selected children.
- GitHub CLI does not select one of multiple github.com accounts from the
  working directory. Its supported selector is `gh auth token --user`, with
  `GH_TOKEN` providing process-local authority.
- Git supports URL-scoped credential helpers, so a clone can route HTTPS
  credentials without changing global Git state or the remote URL.
- Live CuraPod testing proved `forge github run` selects `harshalite`, while an
  ordinary unwrapped process does not. This is the product gap.
- Prior research and rejected alternatives remain in
  `docs/work/2026-09-08-github-account-context/research/multi-account-options.md`.

## Smallest viable design

1. Keep `forge github use <login>` unchanged unless the user passes `--auto`.
2. `--auto` writes a separate clone-local enable marker and a URL-scoped Git
   credential helper. No credential is written to Git config.
3. Ship a pass-through `gh` proxy beside Forge. It reads the clone marker for
   every invocation, selects the named account only in enabled clones, and
   otherwise executes the real GitHub CLI unchanged.
4. The proxy bypasses the complete `gh auth` namespace so login, logout,
   refresh, status, switch, token inspection, and setup remain native account
   management operations.
5. `forge github unset` removes the binding, auto marker, and helper owned by
   Forge. Stored GitHub CLI accounts are untouched.

## Constraints and risks

- Reuse `lib/github-context.js`; do not add a credential store or dependency.
- Never print, persist, cache, or pass a token as a command-line argument.
- Prevent proxy recursion by resolving the first real `gh` executable that is
  not Forge's proxy.
- Unbound and non-enabled clones must preserve native behavior and ambient env.
- Missing, invalid, or mismatched enabled bindings fail closed.
- Two repositories in concurrent processes must resolve independently.
- Tools with embedded OAuth that do not call system Git or `gh` remain outside
  this guarantee and must be documented.

## Acceptance evidence

- Unit tests cover enable/disable, credential protocol, auth bypass,
  pass-through, recursion prevention, secret-clean failures, and concurrent
  per-repository selection.
- A packaged-bin test proves the `gh` proxy is shipped.
- Focused tests and repository validation pass from the isolated worktree.

