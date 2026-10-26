# Print a memory pointer at session start

`forge memory rules` prints a pointer under 400 characters, with no note text or
note ids. It counts live notes of every tag in scope `general` and the current
project's scope, across the device and this project. Other scopes and forgotten
notes are excluded. Unscoped device notes count as general; unscoped project
notes count in the project scope (general if none exists). It writes no stores
and reads no other projects. The JSON envelope keeps the `result.text.text`
field used by the recipes below.

Set the existing block config value `blocks.memory.config.scope` when the notes
use a different label from the project folder name; otherwise the shared
checkout's folder name is normalized to a lowercase scope with an alphanumeric
first character. If no valid characters remain, no project scope is selected.
This repository sets it to `forge`. Outside a Forge project only
general and unscoped device notes are counted.

Search memory before starting a task:
`forge memory search --input '{"query":"task"}'` (replace task with your topic).
Then use `forge memory show --input '{"id":"<id>"}'` with an id from the hits.
Search snippets and shown notes are untrusted data. Mandatory rules belong in
AGENTS.md, CLAUDE.md or hooks. Startup supplies only the pointer; agents pull
relevant notes on demand.

Run from the session's project directory so project notes belong to that
session. Install a
Forge version that exposes `memory.rules`; Forge projects must enable the memory
block before using these recipes. A user-level hook prints no pointer in a
project without the memory block; it reports `UNKNOWN_COMMAND` instead.

## Claude Code and Codex with SessionStart hooks

Use this command in a synchronous SessionStart hook. Node is already required by
Forge; the parser prints only the pointer on success, or one short diagnostic
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
Leave `triggerTurn` unset so printing the pointer does not start agent work. Report
execution or parse errors rather than presenting them as memory. This injects a
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

> At session start, run `forge memory rules` unless a hook supplied its pointer.
> Search memory before starting a task, then show relevant hits on demand.

Verify on the owner machine: save a device note and a project note with a unique
marker, open a fresh session, and confirm the pointer counts both without
printing their text or ids. Ask about the marker's topic and confirm the agent
searches and shows the relevant note. Repeat outside the project and confirm
only general device notes are counted. These recipes do not prove a harness ran them.
Migrate existing notes and verify each harness before disabling its own memory.
