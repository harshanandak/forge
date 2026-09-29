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
- Zero-argument, help, completion, configuration, and other local-only `gh`
  operations bypass account resolution.
- User-installed aliases and extensions inherit the clone-selected account just
  like built-in network commands; extension management is not an ambient-account
  escape hatch. Arbitrary user-installed code remains outside Forge's
  wrong-destination guarantee.
- Tokens stay in native `gh` storage and process memory only.
- Missing accounts and malformed or duplicate `github.auto` values fail closed.

## Implementation

1. Extend the existing Git config helpers with one auto marker and the scoped
   credential-helper configuration.
2. Add dedicated lightweight credential and proxy entrypoints. Common routing
   retrieves the named token and starts native `gh`; it does not call the live API
   or enumerate help, aliases, and extensions on every invocation.
3. On explicit opt-in, install marked router launchers beside the active Forge
   launcher. The proxy resolves and invokes the real GitHub CLI, skipping marked
   routers; package installation alone never shadows `gh`.
4. Record canonical clone paths, enabled state, and router ownership, never
   credentials, in machine-local Forge state under the existing router lock.
   Registration is durable before `github.auto`
   is enabled; disable removes clone config before the registry entry. Missing or
   corrupt registry state, enabled-but-unregistered state, or an unavailable
   registered clone fails closed. Global uninstall refuses while any verified clone
   remains enabled and prunes only entries it can prove are disabled.
5. Update lifecycle, security, packaging, Windows/POSIX, and installed-product
   behavior tests.
6. Update the account reference and changelog.

## Boundaries

- No `gh auth switch`, shell-profile edits, SSH rewriting, Git author changes,
  token cache, new dependency, or embedded-app OAuth integration.
- Automatic routing supports public `github.com`. An explicit non-public host
  fails closed before the selected public credential is injected; GHES routing
  remains native and outside this feature.
- Built-in destinations from arguments, URLs, `GH_HOST`, `GH_REPO`, and repository
  inference fail closed on conflict or non-public targets before credential
  injection. Arbitrary code inside user-installed aliases and extensions is
  outside Forge's wrong-destination guarantee.
- A process that invokes an absolute `gh` binary or bypasses shell command
  resolution is outside transparent interception and keeps the explicit launcher.
- The scoped helper is installed only after account and repository access
  validation. Enable refuses to replace a pre-existing clone-local scoped
  helper it does not own.

## Verification

- Focused lifecycle/context/proxy tests.
- Generated Windows launchers preserve spaces, quotes, percent signs, carets,
  exit codes, and other command payloads without a second `cmd.exe` expansion.
- A packaged PATH-based integration test runs the real Forge router/proxy/helper
  chain for two clone-local accounts concurrently, plus unbound and fail-closed
  cases. Tests may substitute native `gh` at the process boundary but may not
  substitute Forge itself.
- A release acceptance run uses two real securely stored accounts without
  printing their tokens.
- Warm median added latency, measured over at least five runs, is at most 250 ms
  for unbound/local-only routing, 1,000 ms for a bound `gh` route before native
  command work, and 1,000 ms for credential-helper resolution.
- Manifest and package-bin checks.
- Lint and full Forge validation using the repository's supported runners.
