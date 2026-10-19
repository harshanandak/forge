# GitHub accounts per clone

`forge/github-accounts` is opt in. Add an instance and bind the process, files,
environment and crypto requirements to `core`. Every operation is declared in
`forge.block.json`; the CLI and MCP tools come from the catalog. The async handlers
have declared outer timeouts; the composition can lower them with operation
timeouts. No credentials are stored by this block and it never switches gh's
global active account.

`github-account.bind` selects an existing `gh auth` account, verifies that account
with the selected stored credential, verifies repository access, and then sets
clone-local `user.name` and `user.email`. Choose a verified email explicitly or let
the template select the account's numeric-id noreply address or verified primary
email. Email ownership comes from GitHub's verified email API plus the account's
derived noreply address. An account without access to the verified email API cannot
bind; authorize that capability in gh first. Binding an already bound clone refuses;
unbind before choosing another account.

With `auto: true`, binding also installs marked scripts in the common Git directory
and a clone-local HTTPS credential-helper reset and route. Prepend `routerPath` from
status to PATH in the chosen session to route `gh` there. This does not change a
global PATH or shell profile. Native gh and Git executable paths are resolved and
pinned before script generation, so a router on PATH cannot recursively select
itself. Each invocation obtains its account's stored credential, verifies the login
before dispatch, and supplies the credential only to its child environment. The
HTTPS helper emits credentials only through Git's credential protocol; it ignores
store/erase and requests for other protocols or hosts. SSH identity selection stays
with the user's SSH configuration.

The generated router and hooks require a POSIX shell and `env` (Git Bash on
Windows). Native PowerShell/cmd routing is not implemented. The provider-backed
catalog operations work on Windows without that shell; automatic scripts and native
Git hooks need the configured shell. Merely adding the block to a composition does
not install scripts or hooks.

`github-account.check` accepts `tip`, optional exclusive `base`, and `trigger`
(`push` or `merge`). It resolves commits, checks **every** commit in the range, and
refuses both an unrelated author email and an unrelated committer email. A missing
base or all-zero remote base checks all reachable commits, including the root.
It refuses ranges beyond `maxCommits` and truncated command output rather than
silently accepting a prefix. It also applies the configured co-author policy to
each existing commit message. A strip policy refuses existing AI trailers until
the author amends the message; it never rewrites history.

`github-account.hook {enabled:true}` installs an opt-in pre-push hook that delegates
every pushed ref range to the catalog check. Existing hook configuration or an
existing native hook causes refusal so its protection is preserved. Disabling the
hook restores its saved local setting. Merge automation calls the same catalog
check with `trigger: "merge"` and the exact proposed range.

`github-account.message` accepts text or a Git-directory message path and applies
`allow`, `refuse`, or `strip` to AI co-author trailers. AI markers are configured
case-insensitive literal substrings, not an internal list of model names. Only the
final trailer paragraph is considered; human trailers and the body are preserved.
Text input is pure. A message file is written only when stripping changes it and
only if its original contents still match. No commit is made by this operation.

`github-account.status` reads the binding, current effective identity, every linked
worktree's effective identity, configuration mismatches, and owned script health.
`github-account.doctor` additionally verifies the stored account's authentication.
Neither writes. `github-account.run` accepts only configured command/verb pairs,
rejects credential-management/global-auth commands and host/credential/repository
override flags, and refuses output containing the selected credential. It returns
stdout and exit status; subprocess diagnostics are withheld.

`github-account.unbind` restores saved local multivalues for identity, helper and
hook configuration, preserving unrelated Git configuration. It removes only
artifacts whose contents match the owned copy. Changed settings or changed owned
artifacts cause a reconcile-first conflict rather than overwriting user edits.
Interrupted cleanup can be retried when configuration already matches the saved
prior values. All metadata, staging files and scripts live under the clone's common
Git directory in `.forge-github-accounts`; linked worktrees share the clone binding.
No global Git, gh, shell or project files are written by binding/unbinding.

Transactions use an invocation-owned metadata lock; provider cleanup releases it
even after timeout or cancellation. Configuration staging uses one fixed marked
file, bounded by `maxFileBytes`. An interrupted stage is recovered only by a later
mutation while holding that lock. A foreign or changed ownership marker refuses
recovery. Status never cleans files. Interruption can leave diagnostics requiring
reconciliation. Account activation is published only after prerequisite artifacts
and metadata are durable. Conditional configuration publication follows the file
provider's recovery protocol and can briefly expose an absent path; it is not an
OS-level atomic compare-and-swap.

## Consumer seam

Delivery blocks can read the non-secret clone-local Git key `forge.githubAccount`
to obtain the selected login, or call `github-account.status` through the catalog.
The key has no default. Absence means native account selection. Never infer a
credential from this key or persist a selected token. A consumer needing authenticated
commands must obtain the selected account's gh credential into its own invocation
environment and verify the login before acting. The accounts block's public results
contain no token.

## Configuration

Every key is required; templates supply the policy and limits. No configuration
value creates provider authority. Declared effects still require admission.

| Key                       | Meaning                                                                                                                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environmentNames`        | Exact environment names passed to native tools. Include PATH/PATHEXT, home/config locations, and shell/OS essentials needed by the selected programs. Auth overrides and all `GIT_*` overrides are removed. Generated scripts refer to these names at invocation time and never save their values. |
| `gitProgram`, `ghProgram` | Executable names or paths resolved through the process provider.                                                                                                                                                                                                                                   |
| `ghArgs`                  | Explicit argument prefix, usually empty; supports a supervised executable wrapper without shell parsing.                                                                                                                                                                                           |
| `identityName`            | `profile` (GitHub display name, falling back to login) or `login`. Explicit bind input overrides it.                                                                                                                                                                                               |
| `identityEmail`           | `noreply` or verified `primary`. Explicit verified bind input overrides it.                                                                                                                                                                                                                        |
| `allowedGhCommands`       | Exact first-two-argument prefixes such as `repo view`, `pr create`, or `api user`. `auth`, `config`, `alias`, `extension`, and `secret` cannot be granted.                                                                                                                                         |
| `commandTimeoutMs`        | Per-command budget, 1–300,000 ms, additionally bounded by the invocation deadline.                                                                                                                                                                                                                 |
| `maxOutputBytes`          | Output cap, 1–1,048,576 bytes. Truncation refuses the operation.                                                                                                                                                                                                                                   |
| `maxFileBytes`            | Text/metadata read cap, 1–1,048,576 bytes, also bounded by host file limits.                                                                                                                                                                                                                       |
| `maxCommits`              | Complete-range commit cap, 1–100,000. Exceeding it refuses rather than truncates.                                                                                                                                                                                                                  |
| `coauthorPolicy`          | `allow`, `refuse`, or `strip`.                                                                                                                                                                                                                                                                     |
| `aiCoauthorPatterns`      | Literal markers identifying AI co-author trailers; an empty list identifies none.                                                                                                                                                                                                                  |
| `forgeCommand`            | Executable and fixed arguments used by generated hooks to invoke the same installed catalog CLI.                                                                                                                                                                                                   |
| `shellProgram`            | POSIX shell executable used for the clone-local credential helper.                                                                                                                                                                                                                                 |

The maxima above are bounded resource ceilings. Compositions should choose limits
appropriate to their repository and explicitly include this block's effects in
their admission grants. Every native launch, including observational Git reads,
declares `external:process`; config/file mutations additionally declare their write
effects. The process supervisor and all services expire with the invocation.
