# Done-claim Stop guard

Run `forge agent guard` (or name an adapter with `forge agent guard <id>`). Add the printed entries to their destination, keeping every other entry; Forge never edits that file. Stop checks done claims; PreToolUse adds the [command guard](command-guard.md). Review and trust the hooks before use. Re-render after moving or reinstalling Forge: the absolute package companion uses its adjacent CLI from any directory. The synced companion is for inspection.

After removing fenced and inline code, any word "done", "fixed", "ready" or "verified" (any case) requires either an `Unverified:` line or a `Not covered: ...` line (a dash also works) plus a current-HEAD PASS receipt among the first three code-free receipt ids. Labels may use `*`/`**` and list bullets. Progress such as "not done yet" also blocks once; add `Unverified:` when proof is missing. The hook reads `forge check show` in the nearest Forge project up to the git root, needs no network, respects `stop_hook_active`, and exits silently outside a git repo or Forge project.

Both [Claude Code](https://code.claude.com/docs/en/hooks#stop) and [Codex](https://developers.openai.com/codex/hooks#stop) document stdin `cwd`, `last_assistant_message`, `stop_hook_active` and stdout `{"decision":"block","reason":"..."}`. No transcript parsing is needed.
