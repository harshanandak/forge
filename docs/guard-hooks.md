# Device guard cutover

The Forge guard block checks command text, typed file reads and searches, and
tool results. It reads the existing device credential registry for output
matching and keeps its values inside the host adapter. It returns decisions
and fixed guidance. The inspection operations return file metadata and
summary statistics.

## Operations

Enable the shipped `forge/guard` block under `blocks` in a Forge project:

```yaml
guard:
  source:
    builtin: forge/guard
```

- Send a PreToolUse event to `forge --hook guard.command` on stdin.
- Send a Codex PostToolUse event or Claude Code PostToolBatch event to
  `forge --hook guard.output` on stdin.
- Use `forge safe-inspect metadata <path>` for the byte count and modification
  time. `forge safe-inspect summary <path>` also reports JSON validity and the
  redaction marker count. Pass an absolute path when running these commands
  from the installed `templates/guard` directory.

## Harness settings

After owner approval, use the absolute path to the installed
`templates/guard/run.mjs` and the absolute path to the Node executable. Add the
Forge command hook alongside the existing destructive-command hook and keep
that hook active. Forge tracks migration of the local `rm`, `mkfs`, and `dd`
checks in forge-1614. Configure the Forge hooks as synchronous commands with a
15-second timeout.

| File                      | Event           | Command arguments                |
| ------------------------- | --------------- | -------------------------------- |
| `~/.claude/settings.json` | `PreToolUse`    | `<node> <run.mjs> guard.command` |
| `~/.claude/settings.json` | `PostToolBatch` | `<node> <run.mjs> guard.output`  |
| `~/.codex/hooks.json`     | `PreToolUse`    | `<node> <run.mjs> guard.command` |
| `~/.codex/hooks.json`     | `PostToolUse`   | `<node> <run.mjs> guard.output`  |

Use `type: "command"` and omit the matcher so typed tools and shell tools reach
the guard. In Claude Code use exec form with `command` set to the Node
executable and `args` set to the launcher path and operation. Set
`onFailure: "block"` on the Claude command guard. In Codex quote both paths in
the command using the hook shell's quoting rules, then review and trust the
changed hooks with `/hooks`. Use forward slashes in quoted Windows paths. If
using PowerShell, prefix the quoted Node executable with `&`.

Use the launcher for harness settings because the Forge CLI emits the Forge
result envelope. The launcher selects the installed CLI and bundled Forge
configuration independent of the tool's working directory and PATH. A missing
CLI, timeout, malformed input or failed Forge invocation produces a deny or
block decision. The launcher discards child diagnostics. The guard operations
use stateless context and can continue checking when unrelated Forge state
is locked. A failed credential registry read withholds output.

Codex replaces a blocked result. Claude Code's batch hook stops the agentic
loop before the next model call. A blocked Claude result may remain in the
transcript, so discard the affected conversation before resuming work. Verify
the installed Claude version supports the batch event before switching.
See the [Claude Code hook reference](https://code.claude.com/docs/en/hooks#posttoolbatch-decision-control)
and [Codex hook reference](https://learn.chatgpt.com/docs/hooks#posttooluse).

Before replacing an existing output hook, check deny, warn, allow, output
block and launcher failure with fake values in a disposable session. Keep a
copy of the prior hook groups so the owner can restore them if a harness fails
the check.
