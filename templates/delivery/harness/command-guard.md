# Command guard

Run `forge agent guard` or `forge agent guard <id>`. Merge both printed entries into the named file, preserving every existing setting and hook. Stop checks completion claims; PreToolUse with matcher `Bash` checks command text. Forge never edits your hook file.

The command guard applies in every repository. It refuses environment dumps, printing secret-named variables, reading credential files, provider secret listings, and recursive removal of a root or home directory. Each refusal exits 2 with one fixed reason on stderr. Reasons never include command contents, variable names or paths. Allowed commands produce no output and exit 0.

Refusal reasons:

- `env-dump`: request one ordinary variable explicitly.
- `secret-variable`: test whether the secret is present instead of printing it.
- `secret-file`: inspect a redacted example instead of credential contents.
- `provider-env`: use presence checks instead of listing provider secret values.
- `rm-root`: choose a specific project directory instead of a root or home directory.
- `unsupported-payload`: the shell command must be a string.

Ordinary commands pass: `git status`, `bun test`, `env FOO=1 bun test`, removal of `./dist`, `printenv HOME`, `echo $PATH`, and `cat .env.example`. Quoted commit messages that mention refused commands also pass.

It checks quotes, escapes, command chains, pipes, subshells, runner prefixes and shell `-c` strings up to three levels. Unreadable JSON and other tools pass silently; a Bash payload without a string command is refused. It never executes the command it reads.

Codex needs `features.hooks` enabled. Run `/hooks` to review and trust the hook. Review and trust it in Claude Code too. Re-render after moving or reinstalling Forge because commands point to the installed package.

This is a text check, not a sandbox. It does not inspect globs, variables holding commands, eval, aliases, functions, scripts, language runners, xargs, find actions, remote SSH commands, command substitution used as a removal target, recursive readers reaching credentials, or cwd-relative wipes. PowerShell and other tools are outside this Bash matcher. Keep the harness sandbox and permission rules.
