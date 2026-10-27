# Done-claim Stop guard

Run `forge agent guard` (or name an adapter with `forge agent guard <id>`). Add the printed entry to its destination, keeping every other entry; Forge never edits that file. Review and trust the hook before use. Re-render after moving or reinstalling Forge: the absolute package companion uses its adjacent CLI from any directory. The synced companion is for inspection.

Affirmative done, fixed, ready or verified claims require a current-HEAD PASS receipt id and a `Not covered: ...` line (a dash also works), or an explicit "unverified". Code, questions and negated claims are ignored. The hook reads `forge check show` at the git root, needs no network, blocks only once using `stop_hook_active`, and exits silently outside a git repo or Forge project.

Both [Claude Code](https://code.claude.com/docs/en/hooks#stop) and [Codex](https://developers.openai.com/codex/hooks#stop) document stdin `cwd`, `last_assistant_message`, `stop_hook_active` and stdout `{"decision":"block","reason":"..."}`. No transcript parsing is needed.
