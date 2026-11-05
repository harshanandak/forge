# GitHub accounts

Consumer: agents preparing the first commit or push in a GitHub repository.
Enable the `forge/accounts` built-in block, run `forge accounts plan --json`, and relay `result.ask` unchanged.
The agent calls `accounts use --input` only for a clear yes or named account, with `approval: {quote, source}`.
For other clear replies it calls `accounts decline`; if unsure, it asks again before acting.
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

Commit-time authors are enforced at push by forge-228 accounts check; S1 verifies identity at bind time.
S1 also reports unpushed email hazards in the ask. Deliberately wrong reply relay is outside S1 (forge-886).
Forge installs no hook.
Credential routing, push access verification, revocation and author rewriting ship in later slices.
