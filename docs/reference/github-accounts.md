# Optional GitHub accounts per clone

Use this when you keep personal and work GitHub accounts signed in at the same
time. It is off by default. Installing Forge or running `forge setup` does not
select an account. Unbound projects keep native account selection.

## Sign in once, select per clone

From a normal terminal outside any previously launched account session, run:

```sh
gh auth login --hostname github.com --web --skip-ssh-key
```

Complete the browser flow for one account, then repeat for the other account.
Choose the intended browser account each time. Keep your existing Git transport
choice and decline Git credential-helper changes unless you deliberately want
them. GitHub CLI owns login and credential storage; Forge does not create another
credential store. Native `gh` normally uses the system credential store, but can
fall back to a plaintext file when that store is unavailable. See
[GitHub CLI login](https://cli.github.com/manual/gh_auth_login).

Do not paste tokens into chat, commands, project files, shell profiles, or `.env`
files. You do not need to export or persist `GH_TOKEN` for this workflow. If your
normal terminal already supplies GitHub token variables, remove those overrides
from that session before interactive login; do not print their values.

Inside the work clone:

```sh
forge github use WORK_LOGIN
forge github status
forge github run -- codex
```

Inside the personal clone, in another terminal:

```sh
forge github use PERSONAL_LOGIN
forge github status
forge github run -- t3
```

Replace the uppercase labels with your GitHub logins. Both sessions can remain
open together. Substitute any installed, trusted CLI harness or shell for `codex`
or `t3`, such as `claude`, `pwsh`, or `bash`.

`use` verifies the named stored account and repository access, then writes only
`git config --local github.account`. It does not log in, switch the globally
active account, or modify another clone. Linked Git worktrees normally share this
clone-local configuration; use separate clones when you need separate bindings.

Supported GitHub-dependent Forge commands use the binding automatically. To give
the same identity to a harness's own `gh` calls, start that harness with
`forge github run --`. Already-running terminals and harnesses are not changed.

The launcher deliberately gives its child GitHub authority through transient
environment variables. Only launch programs you trust with that account. Forge
does not persist the token, but the launched program can access it. Harnesses or
tools using their own credentials instead of the inherited `gh` environment are
outside this guarantee.

## Check or undo

```sh
forge github status --json
forge github unset
```

Status reports the selected and verified login, clone-local binding source,
effective Git author, origin transport, helper classification, and repository
access. It does not print tokens, raw remote URLs, or raw credential-helper
commands. Treat author and account labels as personal information when sharing
diagnostics.

`unset` is safe to repeat. It removes only the clone binding, not either stored
login. It does not revoke authority from a running child: close that session and
start a new one after changing or removing a binding.

## Three separate identities

| Identity | Controlled by |
| --- | --- |
| GitHub API account used by supported Forge routes | Clone-local `github.account` |
| Commit author | Git `user.name` and `user.email` |
| Fetch/push authentication | SSH configuration or the HTTPS credential helper |

Forge does not change your author, origin, SSH keys, or credential helper.
Existing SSH keys and host aliases remain valid; custom aliases must resolve to
`github.com` for Forge's repository-access check. HTTPS and SSH GitHub.com origins
are supported; insecure HTTP/Git transports and Enterprise hosts are not V1 targets.

HTTPS has one important coupling: if Git uses `gh auth git-credential` as its
helper, Git commands inside the explicitly launched session may use that session's
selected token too. Other HTTPS helpers and SSH key selection remain independent.
For native multi-account transport, keep separate SSH keys/aliases or configure
your HTTPS credential manager to distinguish repository URLs (`useHttpPath`).
These are optional Git choices, not Forge setup steps; see
[GitHub's multi-account transport guide](https://docs.github.com/en/account-and-profile/how-tos/account-management/managing-multiple-accounts).

## Platforms and recovery

The command syntax is the same on Windows, macOS, and Linux. Windows executable
and `.cmd` launchers are supported; quote paths or arguments containing spaces.
Everything after `run --` belongs to the child, including `--help`, `--version`,
and `--path`. Git Bash is still required for Forge's existing Windows Bash helpers.

- **Account missing or expired:** run the browser login again from a normal
  terminal, then retry `use` or `status`. Forge never starts login automatically.
- **Account mismatch:** stop and check the clone with `forge github status`.
  Reauthenticate the intended account, or explicitly bind the correct login.
  A failed `use` leaves the prior binding intact.
- **Repository access denied:** check organization membership, SSO authorization,
  and the intended repository with its administrator. Account identity alone does
  not grant repository access.
- **Git push still uses the wrong account:** check the separate transport and
  commit-author configuration above; changing the Forge API binding does not
  replace SSH or credential-manager setup.
- **Unsupported GitHub CLI:** upgrade `gh` to a version supporting named-account
  token retrieval. Unbound projects do not need that capability.
- **Program not found:** install the harness and check its executable name/PATH.

The supported workflow entrypoints are `forge`, `forge-workflow`, and the compiled
Forge executable. Direct developer invocation of `node bin/forge-cmd.js` is an
internal legacy utility, not an account-isolated V1 entrypoint.

## CuraPod adoption

Only after this Forge feature is merged, the merged build is installed, and its
acceptance checks pass: open each intended CuraPod clone, run
`forge github use WORK_LOGIN`, verify `forge github status`, then launch the
chosen harness with `forge github run --`. Keep personal clones separately bound
to `PERSONAL_LOGIN`. This example does not discover or modify existing CuraPod
repositories, remotes, keys, or accounts automatically.
