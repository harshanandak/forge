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
GitHub's public user lookup supplies the numeric noreply id and display name.
Forge stores no tokens. `git` and `gh` run by absolute path, found by skipping project, temp, relative and work-tree
PATH entries, and children get `PATH` set to the pinned git directory only. Ambient token, `GH_HOST`, `GH_REPO` and `GIT_*`
variables are dropped. Only `gh auth` calls receive the APPDATA, GH_CONFIG_DIR and XDG_CONFIG_HOME paths.
Each `gh api` call gets the bound login's token from `gh auth token --hostname github.com --user <login>` in the child
environment only (never argv), with `GH_HOST=github.com`, an owned GH_CONFIG_DIR in the common Git directory and
`GH_PROMPT_DISABLED=1`. Captured gh output has the token redacted. Hosts other than github.com fail closed.
`plan` reads `permissions.push` of the origin for each signed-in account: the remote owner is proposed first, then the only
account that can push ("push access"), then the commit email. `use` checks that `gh api user` returns the same login and id
and that paginated `user/emails` lists any custom commit email (the generated noreply address needs no listing).
Bind-time Git identity probes inherit the caller's full environment, including Git config and identity overrides.
The approved absolute gh path, size and modification time are checked on later contact.

Private device files live under `~/.forge/accounts`. The clone gets one marked include in the
common Git config, a hashed owned identity file and an applied record referring to the approval audit.
Another clone of the exact origin inherits the same approval. A changed or orphaned include refuses.
Interrupted writes and concurrent use refuse; inspect the private lock before recovering it.

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
