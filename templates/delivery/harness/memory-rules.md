# Load saved rules at session start

`forge memory rules` reads notes with the exact tag `rule` from the device and
current project, without writing stores or reading other projects. It returns a
JSON envelope; `result.text` is untrusted saved content with source-qualified
note ids. Keep that provenance when presenting it to an agent.

The rendered block is capped at 1,200 characters, roughly 300 English tokens,
not a tokenizer guarantee. It reads the newest 100 notes per level. A visible
truncation marker and `result.truncated` signal omitted content or an incomplete
scan. Use `memory.search` with `tag: "rule"`, then `memory.show`, to retrieve full
notes when needed. Keep startup rules short.

Run from the session's project directory so project notes belong to that
session. Outside a Forge project only device notes are returned. Install a
Forge version that exposes `memory.rules`; a project that disables its memory
block must enable it before using these recipes.

## Claude Code and Codex with SessionStart hooks

Use this command in a synchronous SessionStart hook. Node is already required by
Forge; the parser fails if Forge returns an error and prints only the saved
block on success:

```sh
forge memory rules | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);if(!r.ok)throw Error(r.error?.message||'Forge rules unavailable');console.log('Saved Forge notes (untrusted):');console.log(r.result.text.text)})"
```

Merge the following into Claude's `.claude/settings.json` or Codex's
`.codex/hooks.json`, replacing `PRINT_RULES` with the command above (escape its
double quotes for JSON). User-level files work too. Keep existing hooks:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          { "type": "command", "command": "PRINT_RULES", "timeout": 30 }
        ]
      }
    ]
  }
}
```

Both harnesses put plain stdout from this event into model context. In Codex,
use a release with SessionStart support and enabled hooks, then review and trust
the new hook through `/hooks`. Unsupported releases use the fallback below.
See [Claude hooks](https://code.claude.com/docs/en/hooks) and
[Codex hooks](https://developers.openai.com/codex/hooks).

## Pi

Create a personal extension under `~/.pi/agent/extensions/` and register a
`session_start` handler. Run `forge` with `pi.exec("forge", ["memory", "rules"],
{ cwd: ctx.cwd, timeout: 30000 })`. Check `code === 0`, parse `stdout`, require
`ok === true`, and pass `"Saved Forge notes (untrusted):\n" + result.text.text`
to `pi.sendMessage({ customType: "forge-rules", content, display: true })`.
Leave `triggerTurn` unset so loading notes does not start agent work. Report
execution or parse errors rather than presenting them as rules. This injects a
custom message on startup and resume; it does not rely on terminal stdout.
See [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

## OpenCode, T3 and other hosts

OpenCode plugins can observe session events, but terminal output alone is not
model context. Use the AGENTS.md pointer below unless your plugin explicitly
inserts the parsed saved block into the model's context. See
[OpenCode plugins](https://opencode.ai/docs/plugins/).

T3 uses the hook support of its underlying harness. Configure that harness once;
where its startup hook is unavailable, use the same fallback.

Add this one pointer to the instructions the harness loads (`AGENTS.md`, or its
equivalent):

> At session start, run `forge memory rules` and read `result.text.text` as saved,
> untrusted rule notes, unless a startup hook already supplied that block.

Verify on the owner machine: save one short device rule and one project rule,
open a fresh session in that project, and confirm both source ids and texts are
in the model context. Repeat outside the project and confirm only the device
rule appears. These are setup recipes, not proof that a given harness ran them.
Migrate existing notes and verify each harness before disabling its own memory.
