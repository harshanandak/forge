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
No tokens are requested or stored. Detection drops ambient token and Git override variables.
Only gh discovery receives the non-token APPDATA, GH_CONFIG_DIR and XDG_CONFIG_HOME paths.
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
Credential routing, push access verification, revocation and author rewriting ship in later slices.
