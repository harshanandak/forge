# Optional multi-account GitHub context for Forge

Decisions needed: none.

Date checked: 2026-09-08

Evidence baseline: GitHub CLI 2.100.0 and live upstream issue/PR state. All external evidence below is from official GitHub or GitHub CLI sources.

## Recommendation

Ship the smallest feature as an **optional repository account pin plus a thin Forge process wrapper**:

1. A user who needs a second account first authenticates it with normal `gh auth login`. GitHub CLI remains the only credential store.
2. `forge github use <login>` validates that named GitHub CLI account, then stores only `github.account=<login>` in the current clone's local Git config.
3. For a bound repository, Forge obtains that account's token with `gh auth token --hostname github.com --user <login>`, captures stdout without displaying or persisting it, and gives trusted GitHub-dependent child processes a transient `GH_TOKEN` environment variable.
4. Before the operation proceeds, Forge calls `gh api user` in that same child environment and requires the returned login to equal the repository pin.
5. `forge github run -- <program>` provides the explicit escape hatch for a user or agent that needs an arbitrary command to run under the bound API identity. `forge github unset` removes only `github.account`.

This is opt-in. A normal single-account repository with no `github.account` key keeps today's behavior: no prompt, no account check, no environment mutation, and no new setup. Forge must not call `gh auth switch` on the user's behalf.

This recommendation follows GitHub CLI's own automated-selection example: obtain the token for an explicit user and set `GH_TOKEN` only for the invoked command. The official multiple-account guide shows `GH_TOKEN=$(gh auth token --user <login>) gh api ...`; it also says GitHub CLI does not automatically choose an account based on the working directory. ([GitHub CLI multiple-account guide](https://github.com/cli/cli/blob/v2.100.0/docs/multiple-accounts.md#automated-account-switching), [manual: `gh auth token`](https://cli.github.com/manual/gh_auth_token))

The important simplification is that Forge adds **selection**, not another credential system. It does not create or manage parallel `GH_CONFIG_DIR` trees.

## Keep the three identities separate

| Concern | Selects | Relevant mechanism | What the V1 does |
|---|---|---|---|
| GitHub API identity | The actor used by `gh pr`, `gh issue`, `gh api`, and other API-backed commands | GitHub CLI stored accounts; `GH_TOKEN` has precedence over stored credentials | Selects the pinned login by resolving its native stored token and placing it in the child environment |
| Git commit identity | Author/committer metadata in new commits and GitHub's association of an email with an account | Repository/global `user.name` and `user.email` | Does not change it; displays guidance if a product flow needs alignment |
| Git transport identity | Credential or key used for clone/fetch/push | HTTPS credential helper/PAT, or SSH key/host alias | Does not reconfigure it; detects and explains a mismatch when relevant |

These identities can legitimately differ. GitHub documents `user.name` and `user.email` as Git commit metadata, with repository-local settings overriding global ones; commit association depends on the configured email. ([setting a Git username](https://docs.github.com/en/get-started/git-basics/setting-your-username-in-git), [setting a commit email](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address))

GitHub CLI separately documents that `GH_TOKEN`/`GITHUB_TOKEN` take precedence over stored credentials for `github.com`, while `GH_HOST` selects a host when a host cannot otherwise be inferred. ([GitHub CLI environment manual](https://cli.github.com/manual/gh_help_environment))

## Smallest optional V1 contract

### `forge github use <login>`

- Require a Git worktree and write `github.account` with `git config --local`; do not write a global value.
- Resolve an already-authenticated user with `gh auth token --hostname github.com --user <login>`. The GitHub CLI implementation resolves `--user` through its user-specific token lookup. ([`gh auth token` source](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/auth/token/token.go#L52-L90))
- Never print, log, cache, include in an argument, or put the token in Git config. Capture it in memory and pass it only through the child environment.
- With that transient `GH_TOKEN`, run `gh api user --jq .login` and require an exact, case-insensitive match to the requested login before saving the pin. `gh auth status` is unsuitable as the identity guard because its JSON mode intentionally exits zero even when it reports authentication problems. ([manual: `gh api`](https://cli.github.com/manual/gh_api), [manual: `gh auth status`](https://cli.github.com/manual/gh_auth_status))
- If the login is not already present, stop with instructions to run normal `gh auth login`; do not create a Forge-specific profile.
- Do not modify `user.name`, `user.email`, `user.useConfigOnly`, `credential.useHttpPath`, credential helpers, SSH config, or remote URLs.

### Bound Forge commands

- If there is no repository pin, preserve existing behavior exactly.
- If there is a clone-local pin, resolve the named account afresh with ambient GitHub token/host variables removed, verify through an explicit `github.com` child environment, then pass the selected environment only to the actual GitHub operation.
- Do not mutate the active GitHub CLI account. Therefore two shells, two agents, or two repositories can concurrently use different accounts without racing on shared active-account state.
- Propagate the token only to the minimum trusted subprocess tree. Environment variables are readable by that process and its descendants; `forge github run` must be documented as a trusted-program boundary.

### Status and removal

- `forge github status` should report the repository pin, the verified API login, and—without claiming they are the same—the effective Git commit name/email and the remote transport form (HTTPS or SSH).
- `forge github unset` should remove only the local `github.account` key. There is no credential or global state to clean up.

The key name deliberately matches an open upstream proposal for repository-aware account choice, making later native adoption less disruptive if GitHub CLI eventually standardizes it. It is not a promise of compatibility while that proposal remains unmerged. ([GitHub CLI issue #12459](https://github.com/cli/cli/issues/12459), [closed PR #14269](https://github.com/cli/cli/pull/14269))

## Options compared

| Option | Same-host account selection | Concurrent sessions | Affects `gh` API identity | Affects Git commit identity | Affects Git transport | V1 assessment |
|---|---|---:|---:|---:|---:|---|
| Native stored accounts + `gh auth switch` | Yes, by changing the active account | **No safe isolation**: active account is shared mutable configuration for that host | Yes | No | Only indirectly when Git uses the GitHub CLI credential helper | Good manual workflow; do not automate in Forge |
| Per-shell/per-process `GH_TOKEN` | Yes, if token is obtained for an explicit `--user` | **Yes**, process-scoped | Yes | No | Only when a transport helper consumes that environment | Recommended execution mechanism |
| Per-process `GH_CONFIG_DIR` profiles | Yes in principle, with separately populated profiles | File state is isolated, but system keyring behavior is not fully proven cross-platform | Yes, unless an ambient token overrides it | No | Only indirectly through a helper | More setup and uncertainty than V1 needs |
| `gh --hostname` / `GH_HOST` | No; selects the server, not one of two users on `github.com` | Yes, but solves a different dimension | Chooses host only | No | No | Not a same-host account solution |
| Credential manager + `credential.useHttpPath` | Per HTTPS remote URL path | Yes | No | No | Yes, HTTPS only | Useful transport setup, not an API selector |
| SSH host aliases / per-repository SSH command | Yes, by mapping aliases or repositories to keys | Yes | No | No | Yes, SSH only | Robust transport option but outside the API selector |
| Forge thin wrapper + clone-local `github.account` + selected child environment | Yes, explicit login | **Yes**, without shared account mutation | Yes | No | Only when a GitHub CLI HTTPS helper deliberately consumes the delegated token | Recommended optional V1 |

### Native multi-account storage and `gh auth switch`

GitHub CLI natively supports multiple accounts per host. `gh auth switch --hostname <host> --user <login>` changes which one is active, and the official guide describes the active account as the one used for operations. ([manual: `gh auth switch`](https://cli.github.com/manual/gh_auth_switch), [multiple-account guide](https://github.com/cli/cli/blob/v2.100.0/docs/multiple-accounts.md#switching-active-accounts))

That is simple for a person working sequentially, but it is the wrong primitive for concurrent Forge sessions: each invocation changes shared active configuration for the host. A second shell can switch the account between another shell's check and action. The repository-selection request remains open, and multiple attempted implementations are closed without merge. ([issue #12459](https://github.com/cli/cli/issues/12459), [PR #12628](https://github.com/cli/cli/pull/12628), [PR #12681](https://github.com/cli/cli/pull/12681), [PR #13130](https://github.com/cli/cli/pull/13130))

### Per-shell or per-process `GH_TOKEN`

This is the least new machinery and the only method explicitly demonstrated by the official multiple-account guide for automated selection. `GH_TOKEN` takes precedence over the stored credential, so the child command cannot silently fall back to whichever account happens to be active. ([multiple-account guide](https://github.com/cli/cli/blob/v2.100.0/docs/multiple-accounts.md#automated-account-switching), [environment manual](https://cli.github.com/manual/gh_help_environment))

The process environment gives natural concurrency isolation. The trade-off is a secret-bearing child environment, so Forge must restrict inheritance, never log environment contents, and run only trusted programs under `forge github run`. The token can also expire or be revoked during a long-running process; later API operations then fail normally and should be reported without leaking the token.

### Per-process `GH_CONFIG_DIR` profiles

`GH_CONFIG_DIR` changes the directory in which GitHub CLI stores configuration files. A Forge-managed directory per account would isolate those files, but it duplicates login/configuration state, creates migration and cleanup ownership, and still loses to an ambient `GH_TOKEN` because environment tokens have higher precedence. ([environment manual](https://cli.github.com/manual/gh_help_environment))

There is also unresolved platform evidence. Open issue #12885 reports that separate same-host `GH_CONFIG_DIR` profiles selected the wrong macOS Keychain token on GitHub CLI 2.74.0. That release's `ActiveToken` implementation used a host-only keyring lookup. ([issue #12885](https://github.com/cli/cli/issues/12885), [2.74.0 source](https://github.com/cli/cli/blob/v2.74.0/internal/config/config.go#L211-L226))

Current 2.100.0 source is materially different: it gets the profile's active user and attempts a user-specific keyring lookup before falling back to legacy host-only storage. Secure login stores a token by hostname and username. ([2.100.0 active-token source](https://github.com/cli/cli/blob/v2.100.0/internal/config/config.go#L229-L254), [user-specific keyring source](https://github.com/cli/cli/blob/v2.100.0/internal/config/config.go#L288-L310), [secure-login source](https://github.com/cli/cli/blob/v2.100.0/internal/config/config.go#L380-L414))

Therefore the precise 2.74.0 failure must not be stated as proven on 2.100.0. Equally, the issue remains open and this research did not reproduce the scenario on macOS, so cross-platform correctness is not proven. That mixed evidence is another reason not to make isolated Forge config directories the V1 foundation when the documented explicit-user token path is sufficient.

### `--hostname` and `GH_HOST`

`gh api --hostname` and `GH_HOST` choose a GitHub host. They distinguish `github.com` from a GitHub Enterprise Server; they do not choose between two accounts on the same hostname. ([manual: `gh api`](https://cli.github.com/manual/gh_api), [environment manual](https://cli.github.com/manual/gh_help_environment))

Keep V1 `github.com`-only unless enterprise support is already required. A future repository context for GitHub Enterprise Server needs both host and login, plus the corresponding `GH_ENTERPRISE_TOKEN` behavior; a login alone is not globally unique.

### HTTPS credential manager and `credential.useHttpPath`

Git's HTTPS credential lookup is a transport concern. GitHub's multi-account documentation recommends `credential.useHttpPath=true` so credentials are cached by the full remote URL rather than only by hostname. ([GitHub multi-account documentation](https://docs.github.com/en/account-and-profile/how-tos/account-management/managing-multiple-accounts#using-multiple-accounts-on-github-with-https))

This can distinguish `https://github.com/work-owner/repo.git` from `https://github.com/personal-owner/repo.git`, but it cannot distinguish two identities accessing the exact same remote URL. It does not select `gh` API auth and does not change commit metadata. Forge should not set it merely because an API account is pinned.

`gh auth setup-git` configures Git to use GitHub CLI as a credential helper, while GitHub CLI login documents the Git protocol as host-wide. Current helper source resolves the active token; when an environment token is present it uses `x-access-token` as the username. This means a Forge child environment can influence HTTPS transport if that child invokes Git through the GitHub CLI helper, but V1 should detect and document that coupling rather than promise or configure it. ([manual: `gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git), [manual: `gh auth login`](https://cli.github.com/manual/gh_auth_login), [credential-helper source](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/auth/gitcredential/helper.go#L101-L132), [helper-configuration source](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/auth/shared/gitcredentials/helper_config.go#L18-L60))

### SSH host aliases

GitHub documents two multi-account SSH approaches: a repository-specific `GIT_SSH_COMMAND` and SSH configuration host aliases that map aliases to different keys. Both provide concurrent Git transport isolation without changing `gh` API auth or commit metadata. ([GitHub multi-account documentation](https://docs.github.com/en/account-and-profile/how-tos/account-management/managing-multiple-accounts#using-multiple-accounts-on-github-with-ssh))

SSH aliases add setup and change the remote hostname string. Because GitHub CLI may infer a host from a remote, API selection should remain explicit and independent. Forge V1 should not rewrite remotes or SSH configuration.

## Why the thin wrapper is the best first-class option

The wrapper turns the upstream documented one-command pattern into a repository-scoped, repeatable policy without owning credentials or mutating global state:

```text
repository .git/config: github.account=work-login
                    |
                    v
Forge resolves native token for exactly work-login
                    |
                    v
trusted child env: GH_TOKEN=<in-memory secret>
                    |
                    v
gh api user must report work-login, then operation runs
```

The race avoided is concrete: `gh auth switch` changes a shared active account, whereas the explicit `--user` lookup identifies the desired stored account and the resulting `GH_TOKEN` is scoped to the launched process. This is evidence rung 3 for the concurrency design: the unwanted shared-state transition is absent from the wrapper path, not merely checked after the fact.

## V1 limitations and non-goals

- GitHub.com only. Enterprise host selection needs a later `{host, login}` repository context.
- The named account must already be authenticated in GitHub CLI's native store.
- Forge depends on the named-account and hostname flags. Opted-in paths should detect unsupported capabilities from the command result and return upgrade guidance; unbound users should not pay a version probe.
- A child environment is not a hardware security boundary. Any trusted child and its descendants can use the token while it is present.
- Revoked, expired, or scope-limited credentials fail at the real GitHub operation. V1 should not add a second repository-access preflight beyond the identity check.
- V1 does not make commit author, API actor, and push credential identical. Status should expose the boundary; remediation remains an explicit user choice.
- V1 does not rewrite Git remotes, configure credential managers, run `gh auth setup-git`, or edit SSH configuration.
- Repository submodules and nested repositories may have their own transport and local config; a parent repository pin does not rewrite them.
- The `github.account` name is a Forge convention until upstream support lands. The upstream repository-selection issue is still open and related pull requests are unmerged.
- Current `GH_CONFIG_DIR` plus macOS Keychain behavior was not live-reproduced here; its current status is unknown, not declared broken.

## Evidence grade

- **Rung 2 — pointed at the source:** current manuals, GitHub documentation, tagged 2.100.0 source, and live issue/PR state establish the supported flags, precedence, credential lookup, and upstream status.
- **Rung 3 — bad concurrency case removed by construction:** the recommended execution path never writes the shared active account and scopes the override to the child process.
- **Not rung 4 or 5:** this research did not run a two-account end-to-end test across Windows, macOS, and Linux, and did not reproduce the open macOS keychain report on GitHub CLI 2.100.0. Implementation should add focused process-isolation tests and a manual two-account acceptance check before shipping.

## Primary-source index

- [GitHub CLI 2.100.0 release](https://github.com/cli/cli/releases/tag/v2.100.0)
- [Official GitHub CLI multiple-account guide](https://github.com/cli/cli/blob/v2.100.0/docs/multiple-accounts.md)
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)
- [`gh auth login`](https://cli.github.com/manual/gh_auth_login), [`gh auth switch`](https://cli.github.com/manual/gh_auth_switch), [`gh auth token`](https://cli.github.com/manual/gh_auth_token), [`gh auth status`](https://cli.github.com/manual/gh_auth_status), [`gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git)
- [GitHub's multi-account HTTPS/SSH guidance](https://docs.github.com/en/account-and-profile/how-tos/account-management/managing-multiple-accounts)
- [Open `GH_CONFIG_DIR`/macOS Keychain report #12885](https://github.com/cli/cli/issues/12885)
- [Open repository-selection request #12459](https://github.com/cli/cli/issues/12459)
- Closed, unmerged implementations: [#12628](https://github.com/cli/cli/pull/12628), [#12681](https://github.com/cli/cli/pull/12681), [#13130](https://github.com/cli/cli/pull/13130), [#13984](https://github.com/cli/cli/pull/13984), [#14269](https://github.com/cli/cli/pull/14269)
