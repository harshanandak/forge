# Ask first: harness rules for one-way doors

Forge can't stop `npm publish`, `git push --force` or a branch delete. Only the harness can. Skill text says "ask first"; these rules make the harness actually ask. Copy the ones you want. They cover three doors from the template's `doors` value: publish, force-push and delete-branch.

## Claude Code

Add `ask` rules to `.claude/settings.json` (shared) or `.claude/settings.local.json` (just you). Rules run deny, then ask, then allow, so an `ask` rule wins over a broad `allow` such as `Bash(git push *)`.

```json
{
  "permissions": {
    "ask": [
      "Bash(npm publish *)",
      "Bash(bun publish *)",
      "Bash(pnpm publish *)",
      "Bash(yarn npm publish *)",
      "Bash(git push --force *)",
      "Bash(git push -f *)",
      "Bash(git push --force-with-lease *)",
      "Bash(git push * --force *)",
      "Bash(git push * -f *)",
      "Bash(git push * --delete *)",
      "Bash(git branch -D *)",
      "Bash(gh pr merge * --delete-branch *)"
    ]
  }
}
```

Docs: https://code.claude.com/docs/en/permissions ("Manage permissions" and "Permission modes").

## Codex

Codex reads Starlark rules from `rules/` next to a config layer: `~/.codex/rules/default.rules` for you, or `<repo>/.codex/rules/` once the project is trusted. `decision = "prompt"` asks before each matching command. Restart Codex after adding a rule.

```python
prefix_rule(pattern = [["npm", "bun", "pnpm"], "publish"], decision = "prompt",
            justification = "publish is a one-way door")
prefix_rule(pattern = ["git", "push", ["--force", "-f", "--force-with-lease", "--delete"]],
            decision = "prompt", justification = "force-push or branch delete")
prefix_rule(pattern = ["git", "branch", "-D"], decision = "prompt",
            justification = "branch delete")
```

A prefix rule matches the start of a command, so it does not see a flag placed after the remote (`git push origin --force`). Write those pushes with the flag first, or add a rule per remote. Check a rule with `codex execpolicy check --pretty --rules ~/.codex/rules/default.rules -- git push --force`.

Docs: https://developers.openai.com/codex/rules.

## T3 Code

T3 Code runs Claude Code or Codex under the thread's permission mode, so the rules above apply to the harness inside the thread. In a full-access thread (Claude Code `bypassPermissions`) the harness skips prompts, so `ask` rules never ask. For a thread that may reach a door, use a mode that prompts, or turn the `ask` rules into `deny` rules, which block the command instead of prompting.

## What these rules do not do

They ask; they do not judge. The skills still require the owner's reply naming the action, and "continue" or silence is not that reply. A command written another way (a script, an alias, `sh -c`) can slip past a prefix rule; the harness sandbox is the only hard stop.
