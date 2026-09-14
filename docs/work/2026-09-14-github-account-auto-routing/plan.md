# Plan: transparent GitHub account routing

Decisions needed: none.

## Goal

Let a user opt a clone into automatic account routing once, then open it
normally in T3 Code, VS Code, a terminal, Codex, or Claude Code. System `gh`
and HTTPS Git use the clone's named GitHub CLI account without launching each
harness through Forge or changing the global active account.

## Contract

```text
gh secure account store
        |
clone github.account + github.auto=true
        |
        +-- system gh proxy -> selected child-only GH_TOKEN -> real gh
        `-- scoped Git credential helper -> selected credential response
```

- `forge github use <login> --auto` is the explicit opt-in.
- Existing `forge github use <login>` and unbound repositories keep their
  current behavior.
- `forge github auto` enables an existing valid binding; `auto --disable`
  removes only Forge-owned transparent routing.
- `forge github unset` removes both clone-local selectors, never native logins.
- The complete `gh auth` namespace always bypasses selection.
- Tokens stay in native `gh` storage and process memory only.

## Implementation

1. Extend the existing Git config helpers with one auto marker and the scoped
   credential-helper configuration.
2. Add an internal `github credential` protocol endpoint and `github proxy`
   endpoint to the existing command module.
3. On explicit opt-in, install marked router launchers beside the active Forge
   launcher. The proxy resolves and invokes the real GitHub CLI, skipping marked
   routers; package installation alone never shadows `gh`.
4. Update lifecycle, security, packaging, and Windows/POSIX behavior tests.
5. Update the account reference and changelog.

## Boundaries

- No `gh auth switch`, shell-profile edits, SSH rewriting, Git author changes,
  token cache, new dependency, or embedded-app OAuth integration.
- A process that invokes an absolute `gh` binary or bypasses shell command
  resolution is outside transparent interception and keeps the explicit launcher.
- The scoped helper is installed only after account and repository access
  validation. Enable refuses to replace a pre-existing clone-local scoped
  helper it does not own.

## Verification

- Focused lifecycle/context/proxy tests.
- Manifest and package-bin checks.
- Lint and full Forge validation using the repository's supported runners.
