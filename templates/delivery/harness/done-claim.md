# Done-claim Stop guard

After importing delivery, run `forge agent guard` (or `forge agent guard <id>`).
It prints the destination file and a Stop entry. Add that entry, keeping every other
entry; Forge never edits global configuration. Review and trust it through your
hook settings before use. Re-render after moving or reinstalling Forge: its command
uses the absolute package copy of forge-build's `done-claim.mjs`, so it works from
any directory without resolving a project skill path. The synced companion is a
copy for inspection, not the user-wide command.

On done, fixed, ready or verified, include a PASS receipt id from `forge check run`
for current HEAD and a `Not covered: ...` line, or say "unverified". The hook reads
that receipt with `forge check show`, needs no network, and blocks only once using
`stop_hook_active`. Outside a git repo or Forge project it exits silently.

Both [Claude Code](https://code.claude.com/docs/en/hooks#stop) and
[Codex](https://developers.openai.com/codex/hooks#stop) document stdin fields
`cwd`, `last_assistant_message`, `stop_hook_active` and stdout
`{"decision":"block","reason":"..."}`. No transcript parsing is needed.
