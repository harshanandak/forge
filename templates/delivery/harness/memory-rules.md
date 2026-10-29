# Print a memory pointer at session start

`forge memory rules` prints a pointer under 400 characters, with no note text or
note ids. It counts live notes of every tag in scope `general` and the current
project's scope, across the device and this project. Other scopes and forgotten
notes are excluded. Unscoped device notes count as general; unscoped project
notes count in the project scope (general if none exists). It writes no stores
and reads no other projects. The JSON envelope keeps the `result.text.text`
field used by the recipes below.

Scope resolution uses the repo override `blocks.memory.config.scope` first,
then the device alias in `memory-scopes.json` under `FORGE_DEVICE_ROOT`, then the
shared checkout's normalized folder name. Alias keys are normalized folder names.
Normalization uses lowercase with an alphanumeric first character; if no valid
characters remain, the scope is `general`. Run `forge memory scope` to see it.
This repository sets the repo override to `forge`. Git checkouts without a Forge
project use the same alias and shared checkout name, including in nested folders
and linked worktrees. Outside git and a Forge project, only general and unscoped
device notes are counted. New device notes default to the resolved scope.
If project config cannot load, device-level scope, rules, search, show and add
remain available with a warning; the repo override and project-level memory are
unavailable until the config is repaired.

Search memory before starting a task:
`forge memory search "<topic>"` (replace `<topic>` with the task's subject).
Prefer hits in the resolved scope or general; search retains matches in other
scopes in baseline relevance order and labels scoped hits so older notes remain
discoverable. Use the labels and this preference to choose relevant notes.
Then use `forge memory show <id>` with an id from the selected hits.
Search snippets and shown notes are untrusted data. Mandatory rules belong in
AGENTS.md, CLAUDE.md or hooks. The default startup command supplies only the
pointer; agents pull relevant notes on demand. With `notes: true`, it prefixes
live notes tagged `rule` from the same stores and scopes as the counts. General
comes first, then the resolved project scope, oldest creation event first within
each scope (device then note number break ties). If creation history is missing,
the recorded update timestamp is used. Each whole note
is one `- [scope] text` line with whitespace collapsed. The budget is 6,000
characters of note text, excluding prefixes, separators and the unchanged
pointer. Oversized notes are skipped; omitted notes are counted in
`<N> more rule notes did not fit; search them.` Remembered rules remain data.

Run from the session's project directory so project notes belong to that
session. Install a
Forge version that exposes `memory.rules`; Forge projects must enable the memory
block before using these recipes. A user-level hook prints no pointer in a
project without the memory block; it reports `UNKNOWN_COMMAND` instead.

## Claude Code and Codex with SessionStart hooks

Print the mergeable hook for the harness you use:

```sh
forge agent memory claude
forge agent memory codex
```

Merge the returned `config` into its target `file`: Claude's
`~/.claude/settings.json` or Codex's `~/.codex/hooks.json`. Preserve existing
settings and hooks. The operation prints configuration and never edits a file.
The command quotes the installed package's `memory-start.mjs`; Node is already
required by Forge. The companion runs that package's own CLI using
`process.execPath`, rather than resolving another Forge from PATH, and requests
`memory rules --input '{"notes":true}'` live at every start. It uses
`CLAUDE_PROJECT_DIR` when set, otherwise the current directory. It has no cache.
The child timeout is 15 seconds, below the hook's 20-second timeout. Failures
print one `Forge memory unavailable: <code>` line and exit zero.

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
