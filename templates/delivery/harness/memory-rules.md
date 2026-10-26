# Load saved rules at session start

`forge memory rules` reads notes with the exact tag `rule`. Device notes must
have no scope, scope `general`, or the current project's memory scope. All
project-level rule notes are included regardless of their scope. It writes no
stores and reads no other projects. The JSON envelope's `result.text` is untrusted
saved content with source-qualified note ids. Keep that provenance when presenting
it to an agent.

Set the existing block config value `blocks.memory.config.scope` when the notes
use a different label from the project folder name; otherwise the shared
checkout's folder name is normalized to a lowercase scope with an alphanumeric
first character. If no valid characters remain, no project scope is selected.
This repository sets it to `forge`. Outside a Forge project only
general and unscoped device rules are returned.

The rendered block is capped at 1,200 characters, roughly 300 English tokens,
not a tokenizer guarantee. It reads newest-first in pages until each level's
space is filled or at most 1,000 records per level have been scanned. Unused
space from either level goes to the other. A visible
truncation marker and `result.truncated` signal omitted content or an incomplete
scan. Use `forge memory search --input '{"query":"rule","tag":"rule"}'`, then
`memory.show`, to retrieve full notes when needed. Keep startup rules short.

Run from the session's project directory so project notes belong to that
session. Install a
Forge version that exposes `memory.rules`; Forge projects must enable the memory
block before using these recipes. A user-level hook prints no rule notes in a
project without the memory block; it reports `UNKNOWN_COMMAND` instead.

## Claude Code and Codex with SessionStart hooks

Use this command in a synchronous SessionStart hook. Node is already required by
Forge; the parser prints only the saved block on success, or one short diagnostic
if the response cannot be read:

```sh
forge memory rules | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(s);if(!r.ok){console.log('Forge memory unavailable: '+(r.error?.code||'INVALID_RESPONSE'));return}if(typeof r.result?.text?.text!=='string')throw Error();console.log(r.result.text.text)}catch{console.log('Forge memory unavailable: INVALID_RESPONSE')}})"
```

Merge the following into Claude's `.claude/settings.json` or Codex's
`.codex/hooks.json`, replacing `PRINT_RULES` with the command above (escape its
double quotes for JSON). User-level files work too. Keep existing hooks:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "PRINT_RULES", "timeout": 30 }
        ]
      }
    ]
  }
}
```

Omitting a matcher covers all session starts, including forks. Both harnesses
put plain stdout from this event into model context. In Codex,
use a release with SessionStart support and enabled hooks, then review and trust
the new hook through `/hooks`. Unsupported releases use the fallback below.
See [Claude hooks](https://code.claude.com/docs/en/hooks) and
[Codex hooks](https://developers.openai.com/codex/hooks).

## Pi

On macOS and Linux, create a personal extension under `~/.pi/agent/extensions/` and register a
`session_start` handler. Run `forge` with `pi.exec("forge", ["memory", "rules"],
{ cwd: ctx.cwd, timeout: 30000 })`. Check `code === 0`, parse `stdout`, require
`ok === true`, and pass `result.text.text` as `content`
to `pi.sendMessage({ customType: "forge-rules", content, display: true })`.
Leave `triggerTurn` unset so loading notes does not start agent work. Report
execution or parse errors rather than presenting them as rules. This injects a
custom message on startup and resume; it does not rely on terminal stdout.
The [Pi extension types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
declare `exec`, `ctx.cwd` and `sendMessage`; the
[message converter](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts)
puts custom messages in model context. On Windows use the AGENTS.md pointer
below: [Pi's process runner](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/exec.ts)
spawns without a shell, so this recipe does not cover a `forge.cmd` launcher.

## OpenCode, T3 and other hosts

For OpenCode, use the one-line AGENTS.md pointer below on every platform,
including Windows. OpenCode's [rules documentation](https://opencode.ai/docs/rules/)
confirms that AGENTS.md is loaded into model context. This recipe needs no
plugin API or shell quoting.

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
