# Optional repository-scoped GitHub account context

**Date:** 2026-09-08

**Status:** Approved for dev after independent plan review

**Forge issue:** `ee4869d5-77af-4959-909c-190e99b3ada0`

## Approach selected

Build this as an optional Forge capability first, merge and verify it, then explicitly enable it only in the CuraPod clones that need account isolation. CuraPod is the first adopter, not the place where account-selection logic lives.

“First class” means supported, diagnosable, and tested—not mandatory. With no clone-local `github.account`, unmarked/local commands do no account-context work. A marked GitHub route performs one local `git config --local --get github.account` lookup, then preserves today's behavior without a `gh` call, network request, or environment mutation.

The minimum opt-in feature is one clone-local account binding, native GitHub CLI multi-account storage, one central registry guard plus explicit GitHub-runner propagation across every supported Forge route, and one cross-platform launcher that passes the selected account token to an explicitly requested child process without persisting or printing it.

## Purpose

Git has three independent identities that are easy to confuse:

1. Commit author: `user.name` and `user.email`.
2. Git transport credentials: HTTPS credential helper or SSH key.
3. GitHub API identity: the account selected by `gh`.

Forge currently launches `gh` as a child process. Those calls inherit the ambient shell environment, so concurrent terminals can silently use the wrong globally active GitHub account. `gh auth switch` changes shared host-level state and is therefore not a safe concurrency primitive.

## Success criteria

- A clone can declare its expected GitHub login through clone-local `github.account`; nothing account-specific is committed.
- The feature is disabled by default. A single-account user who never runs `forge github use` sees no behavioral change; only marked GitHub routes add one local Git-config lookup.
- Forge removes ambient GitHub token/host variables while asking native `gh auth token --hostname github.com --user <login>` for that account's stored credential.
- Before a configured repository runs a GitHub-dependent Forge command, Forge resolves the live login with `gh api --hostname github.com user` and fails closed on a case-insensitive mismatch or missing authentication.
- Repositories without a Forge GitHub binding behave exactly as they do today.
- `forge github status --json` reports the expected login, binding source, live login, local Git author, classified origin transport, and repository access without exposing raw credential-helper commands, credential-bearing URLs, or credentials.
- `forge github run -- <program> [args...]` launches any explicitly trusted agent or shell in the selected context with structured arguments and cross-platform command-shim handling.
- Two bound processes can operate concurrently without calling `gh auth switch` or changing shared active-account state.
- CuraPod adoption happens only after the feature is merged and the installed Forge build is verified.

## Constraints

- Entirely opt-in; no clone-local `github.account` means no `gh` call, network request, token retrieval, or environment mutation at the account-selection seam.
- Forge must never persist or print a credential.
- No new credential store. A direct `cross-spawn` runtime dependency is allowed for the one cross-platform interactive launcher; Forge must not reimplement Windows `.cmd` escaping.
- No mutation of global `gh`, Git credential-helper, SSH, remote, or commit-author configuration.
- Selected credentials are passed only to actual `gh` children, narrowly scoped trusted background GitHub workers, and the explicit `forge github run` child—not to `process.env`, stage enforcement, tests, browser openers, or unrelated Git children.
- GitHub.com only in V1; host-plus-login contexts require a later design.

## User contract

Multi-account mode is enabled only by the user's explicit `forge github use` action. Installing Forge or running `forge setup` never enables it automatically.

### Bind a clone to an already-authenticated account

```text
forge github use <login>
```

The command:

1. Checks that `<login>` exists in native GitHub CLI account storage by invoking `gh auth token --hostname github.com --user <login>` with captured output and ambient GitHub token/host variables removed for that lookup.
2. If the account is absent, stops with exact `gh auth login` recovery guidance. Forge does not start login or change the active account.
3. Uses the selected token only in the verification child environment to verify that the live API login matches `<login>` case-insensitively.
4. Verifies the account can view the current repository.
5. Only after verification writes clone-local `github.account=<login>`.

Forge does not rewrite the commit author, credential helper, SSH configuration, or remote. Those mechanisms already have native Git solutions and remain visible in `status` with actionable diagnostics.

### Inspect

```text
forge github status
forge github status --json
```

Status is read-only and distinguishes `unbound`, `unauthenticated`, `mismatch`, `no_repository_access`, and `ready`. Diagnostics never include token values, raw credential-file content, raw credential-helper commands, or credential-bearing remote URLs.

### Launch an isolated session

```text
forge github run -- codex
forge github run -- claude
forge github run -- t3
forge github run -- pwsh
```

Forge retrieves the bound account's token from native `gh` storage, validates it, and supplies it only to the explicit child as `GH_TOKEN` and `GITHUB_TOKEN`, with `GH_HOST=github.com`. Other environment variables are preserved. Forge uses `cross-spawn` with an argument array so POSIX executables, Windows `.exe` files, and Windows `.cmd` shims behave consistently without caller-built shell strings.

This command intentionally delegates the selected account's GitHub authority to the launched process. The token is never printed, written to disk by Forge, or placed on a command line.

### Remove the binding

```text
forge github unset
```

This removes only the clone-local `github.account` key. It does not log out an account, revoke a token, change a remote, or erase the local author.

## Configuration and precedence

The clone-local Git `github.account` value is authoritative after opt-in. `forge github use` writes it with `git config --local`; global Git configuration, `includeIf`, and environment overrides do not enable V1. Forge does not create the key during normal setup.

For a bound clone, Forge obtains the selected credential through GitHub CLI's documented named-account command. A private context owns the credential and creates per-child environments; it never mutates or returns `process.env`. The live-login guard catches an unexpected credential before a GitHub-dependent handler runs.

For an unbound clone, a marked route performs only the local Git-config lookup. Forge does not call `gh`, retrieve a token, mutate an environment, or verify an account. Native `gh`, Git, and environment behavior remains authoritative.

Login values accept only GitHub-compatible safe characters and are passed as one argument, never through a shell.

## Runtime design

```text
forge command
  -> command registry
  -> unmarked command: existing behavior, immediately continue
  -> marked command: read clone-local github.account
  -> no binding: existing behavior, immediately continue
  -> binding present: gh auth token --hostname github.com --user <login> (sanitized child, captured, never logged)
  -> binding present: gh api --hostname github.com user (selected child environment)
  -> pass a private GitHub runner/context to the handler
  -> existing command handler
  -> only gh children receive the selected credential
```

## Alternatives considered

| Option | Concurrent same-host accounts | Forge stores/reads secrets | User effort | Decision |
| --- | --- | --- | --- | --- |
| Keep native single-account behavior | No isolation needed | No | None | Default for most users. |
| `gh auth switch` before each command | No; it changes shared active-account state | No | Repeated and error-prone | Do not automate. |
| Export a manually managed `GH_TOKEN` per terminal | Yes | Token is placed in each process environment | High; PAT creation/rotation is manual | Supported natively, but unnecessary when `gh` already stores both accounts. |
| SSH host aliases only | Git transport only; does not select the `gh` API identity | No | Medium/high | Preserve existing setups, not a complete solution. |
| Directory-based Git `includeIf` | Commit identity and some Git settings only | No | Medium | Useful advanced Git setup, but it does not select `gh` identity. |
| Separate `GH_CONFIG_DIR` profiles | Intended to be yes | No | Separate login/config lifecycle | Rejected for V1: more state to own, plus an unresolved macOS keychain report against an older `gh` release. |
| Native accounts + `gh auth token --hostname github.com --user` + Forge launcher | Yes | Transiently, in selected child environments | One explicit bind, then one launch command | Recommended V1. |

The recommended option is deliberately a thin wrapper over GitHub CLI's existing multi-account and named-token mechanisms. Forge adds only the missing clone-local selection, verification, and child scoping; it does not duplicate Git's existing commit-identity or transport features. It also aligns with the still-open upstream proposal to make `github.account` repository-aware, which gives Forge a simple future deletion path if `gh` gains the feature natively.

## Technical research

The primary-source comparison is recorded in [research/multi-account-options.md](research/multi-account-options.md). It compares native switching, manual tokens, configuration directories, host selection, HTTPS credential managers, SSH aliases, Git conditional includes, and the thin Forge wrapper.

Evidence is rung 2 for documented/source behavior and live upstream issue/PR state, and rung 3 for eliminating the shared-state race by construction. A two-account cross-platform acceptance run remains required before release; it is not yet rung 4 or 5.

### Shared module

Add `lib/github-context.js` with small functions for:

- reading and writing clone-local Git config through `git config --local` argument-array calls;
- validating the selected account value;
- retrieving a named account's credential in an ambient-token-free child environment without logging it;
- retaining that credential in a private context that can run `gh` or build an explicit child environment without mutating `process.env`;
- resolving the live GitHub login; repository permission is queried only by `github use` and `github status`;
- formatting stable status data and mismatch errors.

Runners, base environment, and platform are injectable for tests. The module returns no credential-bearing public result and never embeds raw subprocess errors in diagnostics.

### Central enforcement

Extend command-module metadata with `githubAuth`:

- `true`: this command requires a verified configured account;
- function: determine the requirement from arguments for composite commands such as `forge pr`;
- absent: do nothing; no Git-config lookup, token retrieval, environment mutation, or account check.

The registry validates this metadata as absent, boolean, or function. It invokes context preparation after successful stage enforcement and immediately before the handler. Help requests remain available without authentication. The verified private context is passed through the handler's existing options seam; it does not alter `process.env`.

Supported route matrix:

- `ship`, `merge`, and `shepherd`, plus `pr ship`, `pr merge`, and `pr shepherd`; `pr preflight` and help stay local;
- `clean`, with the credential attached only to its `gh` runner, not its Git runner;
- `team` only for `workload` when it resolves `--me`, `add`, `verify`, `sync`, and `claim`; `team epic`, explicit-developer workload, and help stay local;
- `push` and `hooks session-start`, which may wake a detached shepherd worker; only that trusted worker receives the selected GitHub environment;
- `serve`, where only the snapshot generator receives the selected GitHub environment and the browser opener does not;
- `skill eval --full`, whose PR-attribution calls receive the private GitHub runner; static skill operations stay local.

`setup`, ordinary `status`, local issue operations, and `preflight` remain untouched. `forge github status` performs its own explicit read-only account and repository-access checks.

`bin/forge.js` and the package aliases that target it are the supported public CLI surface. `bin/forge-cmd.js` is not a package binary; this feature does not claim account isolation for direct developer invocation of that legacy test utility. A structural test locks that boundary, and removing or rerouting the legacy dispatcher is separate cleanup rather than security theater inside this feature.

### Git transport and commit identity

Forge V1 does not configure commit identity or Git transport. `forge github status` reports the effective `user.name`, `user.email`, remote protocol, and credential-helper/SSH condition so the user can see all three identity layers together without Forge taking ownership of them.

An agent launched with `forge github run` inherits the selected GitHub token variables. Git transport remains independently configured in general, but an HTTPS setup that deliberately uses GitHub CLI as its credential helper may consume the delegated token; status documents that coupling. Other credential helpers remain responsible for HTTPS transport. GitHub's documented native choices remain `credential.useHttpPath=true` for HTTPS or separate SSH keys/host aliases for SSH.

Existing SSH remotes continue to work, but Forge V1 does not generate keys, upload public keys, rewrite remotes, or edit `~/.ssh/config`. Those are persistent security-sensitive operations and are not required to solve the `gh` concurrency problem. `status` diagnoses SSH remotes and explains that their key selection remains SSH configuration's responsibility.

## Edge cases and failure behavior

| Condition | Result |
| --- | --- |
| No binding | Preserve current Forge behavior. |
| Selected account is not authenticated | Exit before a guarded handler; show the native `gh auth login` recovery action without starting it. |
| Live login differs from expected | Exit with `GITHUB_ACCOUNT_MISMATCH`; compare case-insensitively and show bounded expected/actual logins only. |
| Ambient token or host selects the wrong context | Ignore it for named-token retrieval; selected `gh` children use the verified token and explicit `github.com` host. |
| Account cannot view the repository | Fail `use`/`status` with an actionable repository-access error; normal guarded commands let their real operation report authorization failure. |
| Child program is missing | Return its normal executable-not-found error without changing the binding. |
| GitHub CLI lacks named-account flags | Fail only the opted-in route with version/upgrade guidance; unbound routes never run a capability probe. |

## Security review

- Persistent authentication remains owned by GitHub CLI. Forge captures a selected token in a private context only long enough to build narrowly scoped child environments; it never prints, returns, serializes, caches, writes, or installs it in `process.env`.
- All calls use executable-plus-argument arrays. The explicit interactive launcher uses `cross-spawn` for safe Windows `.cmd` resolution rather than composing caller-controlled shell strings.
- Account input is validated before being passed to Git or `gh`.
- Login is verified from the live GitHub API, not inferred from `gh auth status` text.
- Repository access is checked separately from account identity during `use` and `status`, not as a redundant preflight before every operation.
- Account mismatch fails after any local stage gate and before a GitHub-dependent handler.
- Errors are allow-listed fields rather than raw subprocess stdout, stderr, environment, remote URLs, or helper values.

Relevant upstream behavior: [GitHub CLI 2.100.0 multiple-account design](https://github.com/cli/cli/blob/v2.100.0/docs/multiple-accounts.md), [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment), [GitHub CLI account switching](https://cli.github.com/manual/gh_auth_switch), [open repository-selection request](https://github.com/cli/cli/issues/12459), [open `GH_CONFIG_DIR` keychain report](https://github.com/cli/cli/issues/12885), and [GitHub multiple-account guidance](https://docs.github.com/en/account-and-profile/how-tos/account-management/managing-multiple-accounts).

## Compatibility

- No binding means no new preflight, environment rewrite, or network call; a marked GitHub route performs one local Git-config lookup.
- Normal `forge setup` and ordinary single-account workflows do not mention or enable multi-account mode.
- Existing command handlers keep their behavior but route `gh` execution through the private context; Git and unrelated child execution remain untouched.
- The static command manifest already requires whole command modules, so metadata and the new `github` command remain bundleable after normal manifest regeneration.
- Windows, macOS, and Linux process behavior is covered through one direct launcher dependency already present transitively in the development lockfile.

## Acceptance scenarios

1. Bind two temporary clones to two fake native accounts, launch both concurrently, and prove each GitHub child sees only its selected login.
2. Set wrong ambient `GH_TOKEN`, `GITHUB_TOKEN`, and `GH_HOST`; prove named-token retrieval ignores them and selected children use the explicit account on GitHub.com.
3. Make named-account token retrieval return the wrong login; prove the guard blocks the guarded command before its handler.
4. Run a local-only command with broken GitHub auth; prove it remains available.
5. Run `forge pr preflight`; prove it is not blocked, while `forge pr ship` is blocked on mismatch.
6. Pass malformed account values; prove no Git or `gh` child is spawned.
7. Run status and error paths with credential-bearing remote/helper/subprocess canaries; prove none are emitted in text or JSON.
8. Use an unbound repository; prove behavior matches the current baseline.
9. Prove the route matrix, including detached monitor, snapshot, and full skill-eval paths, gives the credential only to the GitHub child and never to tests, Git, or browser-opening children.
10. Build the compiled executable and run the same status/guard/launcher smoke checks through it on Windows and one POSIX CI lane.
11. Before release, record a redaction-safe manual receipt showing two real stored accounts operating concurrently on the target Windows machine. Store account labels and pass/fail only—never token material.

## Rollout

1. Implement and validate in the isolated Forge worktree.
2. Push and open a Forge PR linked to the feature issue.
3. Resolve review and CI findings at the exact PR head.
4. Merge only after required checks and ownership gates pass; verify `origin/master` contains the merge.
5. Install the merged Forge build.
6. Replace the temporary CuraPod launcher/configuration with `forge github use` in each distinct CuraPod clone.
7. Run `forge github status --json` and a read-only Forge GitHub operation in every CuraPod clone.

## Ambiguity policy

Implementation may proceed without another decision only when the design and existing code support one interpretation with at least 80% confidence. Below that threshold—especially for secret exposure, credential-helper mutation, or host/account precedence—stop and ask rather than broadening V1.

## Out of scope

- A committed organization-wide account policy.
- Token storage, migration, refresh, or revocation.
- Running GitHub CLI login, logout, refresh, or account-switch operations.
- Forge-managed `GH_CONFIG_DIR` profiles.
- Commit author configuration.
- HTTPS credential-helper configuration, SSH key generation/upload, and remote rewriting.
- GitHub Enterprise Server hosts in V1.
- Automatically discovering every repository under the user's home directory.
- Changing Forge actor/lease identity; GitHub account selection and Forge coordination identity remain separate.
