# GitHub accounts

Consumer: agents preparing the first commit or push in a GitHub repository.
Enable the `forge/accounts` built-in block, run `forge accounts plan --json`, and relay `result.ask` unchanged.
The agent calls `forge accounts use --input` only for a clear yes or named account, with `approval: {quote, source}`.
It calls `forge accounts decline --input` only for a clear no, with the same approval fields.
For any unclear reply it asks again and calls neither operation.
Forge checks only that quote and source are non-empty, and records them verbatim. It does not interpret the reply.
No terminal confirmation substitutes for the owner's chat reply.

The block runs Git and GitHub CLI through the process port. GitHub CLI 2.81.0 introduced
`auth status --json hosts`; older versions use its text account and active-account lines.
The token's own `gh api user` call supplies the numeric noreply id and display name, and proves the token belongs to the named login.
Forge stores no tokens. `git` and `gh` run by absolute path, found by skipping project, temp, relative and work-tree
PATH entries, and children get `PATH` set to the pinned git directory only. Ambient token, `GH_HOST`, `GH_REPO` and `GIT_*`
variables are dropped from the git and gh calls above. The bind-time identity probes still inherit the caller's environment, as described below. Only `gh auth` calls receive the APPDATA, GH_CONFIG_DIR and XDG_CONFIG_HOME paths.
Each `gh api` call gets the bound login's token from `gh auth token --hostname github.com --user <login>` in the child
environment only (never argv), with `GH_HOST=github.com`, an owned GH_CONFIG_DIR in the common Git directory and
`GH_PROMPT_DISABLED=1`. Captured gh output has the token redacted. Hosts other than github.com fail closed.
`plan` proposes the remote owner first, then the only signed-in account that can push ("push access", read from `permissions.push` of the origin), then the commit email.
When a signed-in account owns the remote, no permission lookup runs: the owner is the proposal either way. `use` checks that `gh api user` returns the named login and its id, and that paginated `user/emails` lists any custom commit email (the generated noreply address needs no listing, so a noreply-only account makes no email call).
`use` with a named login skips gh's account listing: the token lookup is the proof the login is signed in. It still reads the unpushed commits and git identities, so the ask recorded in the audit carries the commit and email hazards.
An unreadable email list (a token without the user:email permission) is accepted only for the generated noreply address; a list that fails partway is refused.
Token lookups are never recorded in error diagnostics, and API output is redacted before it is captured.
Bind-time Git identity probes inherit the caller's full environment, including Git config and identity overrides.
The approved absolute gh path, size and modification time are checked on later contact.

Private device files live under `~/.forge/accounts`. The clone gets one marked include in the
common Git config, a hashed owned identity file and an applied record referring to the approval audit.
Another clone of the exact origin inherits the same approval. A changed or orphaned include refuses.
An interrupted apply resumes on `plan` or `use` only when the clone files are an exact ordered prefix of the approved binding's bytes. Recovery checks the account fingerprint and approval audit, takes over only locks whose recorded owner process is dead, holds both locks, completes missing writes with compare-and-write guards, and appends one apply audit entry. Live or unproven lock owners still refuse. All three exact files already present count as complete and need no recovery audit. `check` stays read-only and names `forge accounts plan` as the repair for a recoverable interruption. Changed, orphaned, declined or out-of-order files still refuse without rewriting them.

`forge accounts check --json` refuses a push range holding any commit whose author or committer email is not
one of the bound account's `commitEmails`, and names each wrong commit, field and email. Pass `--input '{"base":"<sha>","tip":"<sha>"}'`
for an exact range (a pre-push hook passes the remote and local sha); with no input it checks every commit reachable from HEAD and
not from a remote-tracking ref. More than `maxCommits` (config, default 500) commits fails closed.
An all-zero `base` means a new branch and checks the tip's full history. Shallow history (`ACCOUNT_SHALLOW_HISTORY`) and a non-empty `info/grafts` file (`ACCOUNT_GRAFTED_HISTORY`) are refused, because they can hide commits.
An unbound repo returns `ACCOUNT_UNBOUND`, a missing or changed include `ACCOUNT_INTEGRITY`, and a declined repo passes with a note.
The check runs Git only, with the same pinned environment, and never calls gh.
S1 verifies identity at bind time and reports unpushed email hazards in the ask. Deliberately wrong reply relay is outside S1 (forge-886).
Forge installs no hook: the git block's hook install owns hook files and runs the check at pre-push.
Credential routing (helper and SSH), revocation and author rewriting ship in later slices.
