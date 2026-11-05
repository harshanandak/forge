# GitHub accounts

Consumer: agents preparing the first commit or push in a GitHub repository.
Enable the `forge/accounts` built-in block, run `forge accounts plan --json`, and relay `result.ask` unchanged.
After the owner's chat reply, call `accounts use --input` with the chosen login and `approval: {quote, source}`.
No terminal confirmation substitutes for that reply. `accounts decline` records an approved refusal.

The block runs Git and GitHub CLI through the process port. GitHub CLI 2.81.0 introduced
`auth status --json hosts`; older versions use its text account and active-account lines.
GitHub's public user lookup supplies the numeric noreply id and display name.
No tokens are requested or stored. Detection drops ambient token and Git override variables.
Only gh discovery receives the non-token APPDATA, GH_CONFIG_DIR and XDG_CONFIG_HOME paths.
The approved absolute gh path, size and modification time are checked on later contact.

Private device files live under `~/.forge/accounts`. The clone gets one marked include in the
common Git config, a hashed owned identity file and an applied record referring to the approval audit.
Another clone of the exact origin inherits the same approval. A changed or orphaned include refuses.
Interrupted writes and concurrent use refuse; inspect the private lock before recovering it.

Wrong-author push checks follow in forge-228. This slice reports unpushed email hazards in the ask.
Forge installs no hook.
Credential routing, push access verification, revocation and author rewriting ship in later slices.
