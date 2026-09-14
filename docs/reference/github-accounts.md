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
forge github use WORK_LOGIN --auto
forge github status
codex
```

Inside the personal clone, in another terminal:

```sh
forge github use PERSONAL_LOGIN --auto
forge github status
t3
```

Replace the uppercase labels with your GitHub logins. Both sessions can remain
open together. Substitute any installed, trusted CLI harness or shell for `codex`
or `t3`, such as `claude`, `pwsh`, or `bash`.

`use --auto` verifies the named stored account and repository access, installs a
marked router beside the current Forge launcher, then writes only clone-local Git
settings: the account selector, an automatic-routing marker, and an absolute
GitHub HTTPS credential-helper route. It refuses to overwrite a non-Forge `gh`
launcher in that directory. It does not store a credential, log in, switch the
globally active account, or modify another clone. Linked Git
worktrees normally share this clone-local configuration; use separate clones when
you need separate bindings.

The opt-in `gh` router reads the clone marker on each invocation. In an enabled
clone it selects the named account for the real GitHub CLI process; elsewhere it
passes through unchanged. The complete `gh auth` namespace always passes through
so login and recovery remain native. HTTPS Git uses the same account through the
clone-local helper. SSH key selection remains controlled by SSH configuration.
Enablement stops if another `gh` resolves before Forge on `PATH`, instead of
claiming automatic routing when the router cannot run. Run automatic setup from
an installed Forge command; transient `npx`/`bunx` package-runner shims are ignored.

Repositories can therefore be opened normally in T3 Code, VS Code, terminals,
Codex, or Claude Code. Shell-based `gh` and HTTPS Git commands started with that
clone as their working directory route automatically when the application PATH
resolves Forge's router first. Start a new terminal or application after changing
PATH order; POSIX shells may also need `hash -r`. A program that invokes an
absolute `gh` executable or bypasses shell command resolution cannot be
intercepted and must use `forge github run -- PROGRAM` or its own account setting.

`forge github use LOGIN` without `--auto` preserves the original explicit mode.
Supported Forge routes use the binding, and arbitrary trusted children can still
be launched with `forge github run -- PROGRAM`.

## Check or undo

```sh
forge github status --json
forge github auto --disable
forge github unset
forge github router --uninstall
```

Status reports the selected and verified login, clone-local binding source,
router reachability, effective Git author, origin transport, helper classification, and repository
access. It does not print tokens, raw remote URLs, or raw credential-helper
commands. Treat author and account labels as personal information when sharing
diagnostics.

`auto --disable` removes only Forge-owned transparent routing and keeps the clone
binding. `unset` is safe to repeat and removes both the binding and Forge-owned
routing. The machine router remains because other clones may use it and passes
through unchanged outside enabled clones. After disabling every opted-in clone,
`router --uninstall` removes only marked Forge router files. None of these commands
removes a stored login or revokes authority from a running child: close that
process after changing or removing a binding.
The safe order is: disable or unset every opted-in clone, run `router --uninstall`
last, then uninstall Forge itself. Package managers cannot clean clone-local Git
configuration after the executable is gone. If that order was missed, reinstall
Forge and run `forge github auto --disable` or `forge github unset`; these commands
remove only Forge-owned configuration. Do not use `git config --unset-all` because
another local HTTPS helper may share the same key.

## Three separate identities

| Identity | Controlled by |
| --- | --- |
| GitHub API account used by Forge and automatic `gh` routes | Clone-local `github.account` + `github.auto` |
| Commit author | Git `user.name` and `user.email` |
| Fetch/push authentication | SSH configuration or the HTTPS credential helper |

Forge does not change your author, origin, or SSH keys. Automatic mode owns only
the clone-local GitHub HTTPS helper it installs and refuses to replace another
clone-local helper.
Existing SSH keys and host aliases remain valid; custom aliases must resolve to
`github.com` for Forge's repository-access check. HTTPS and SSH GitHub.com origins
are supported; insecure HTTP/Git transports and Enterprise hosts are not V1 targets.

Automatic mode routes canonical GitHub HTTPS remotes through the selected native
GitHub CLI account. SSH key selection remains independent; keep separate SSH
keys/aliases when using SSH. See
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
- **Router conflict:** another `gh` launcher already exists beside Forge. Forge
  leaves it untouched; move or remove it deliberately before retrying.
- **Router shadowed:** put Forge's launcher directory before the native GitHub CLI
  directory on PATH, restart the application, and rerun `use --auto`.
- **Explicit repository override:** `gh -R` and `gh --repo` still use the account
  bound to the current working clone; run them from the clone whose identity you intend.

The supported workflow entrypoints are `forge`, `forge-workflow`, and a compiled
Forge executable whose directory is on PATH; it installs the router beside itself. Rerun `use --auto`
after moving a compiled executable or changing Forge installation managers so
the marked launchers refresh their target. Direct developer invocation of `node bin/forge-cmd.js` is an
internal legacy utility, not an account-isolated V1 entrypoint.

## CuraPod adoption

Only after this Forge feature is merged, the merged build is installed, and its
acceptance checks pass: open each intended CuraPod clone, run
`forge github use WORK_LOGIN --auto`, verify `forge github status`, then open the
chosen harness normally. Keep personal clones separately bound
to `PERSONAL_LOGIN`. This example does not discover or modify existing CuraPod
repositories, remotes, keys, or accounts automatically.
