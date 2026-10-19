# Git workspaces and opt-in hooks

Named consumers: delivery compositions use workspace bindings and guarded push. Other compositions can select any operation independently. Registration activates nothing.

`worktree.create` accepts an explicit branch and relative worktree name. With no `base`, it fetches the configured remote's declared default branch and records the selected ref and commit. Only that remote-tracking refspec has a leading `+`, so a rewritten remote default can be refreshed without resetting a local branch. It never forks from an unrelated checkout's current branch. An explicit invalid base creates no branch or directory. Existing branches are preserved and refused rather than reset. The issue and run fields are links; the block never closes issues or advances a workflow.

Bindings are namespaced state records with revisions and events. Creation counts stored bindings, including `creating` and `uncertain` reservations, before reserving a new key. An atomic batch updates the reservation and a shared capacity revision so concurrent creations cannot both consume the last slot. Interrupted or failed creation leaves a visible `uncertain` binding that requires reconciliation; request replay is not permission to repeat an external effect. Successful removal retires its binding through the generic revision-checked state delete; history remains and recreation never reuses a revision. Creation and non-dry cleanup also reclaim legacy `removed` records. `worktree.list` skips those legacy records without changing Git or state.

`worktree.remove` requires the binding revision and exact head. It checks ownership and takes invocation-scoped Git HEAD, index and branch ref locks before checking identity, revision and dirtiness again. Direct Git commits and branch switches use these same locks. Git then performs its own final dirty check. The operation requires Git's files ref storage and never passes a force flag. `worktree.clean` only considers its active bindings. A head equal to its recorded creation base is unstarted and is kept, even when Git ancestry says merged. Started branches qualify through ancestry or a single combined patch's squash equivalence. Dirty or uncertain work is kept. `dryRun` writes nothing and requires `fetchBeforeClean: false`.

`branch.push` requires the local branch's expected SHA, pushes that exact commit with normal Git hooks enabled, and reads the remote ref back. It does not run checks, enforce a branch naming policy, infer a workflow or start a background service. A moved local head is refused; remote readback disagreement is uncertain and requires reconciliation.

## Configuration

All required values are explicit. A template can supply them; this block supplies no team policy defaults.

| Key                         | Meaning and bounds                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `remote`                    | Configured remote name used for default branch discovery, fetch and push.                                                         |
| `worktreeRoot`              | Project-relative directory containing managed worktrees. Traversal and absolute paths are refused.                                |
| `commandTimeoutMs`          | Per-command budget, 1–300000 ms, also capped by the invocation deadline.                                                          |
| `maxOutputBytes`            | Per-command evidence cap, 1024–1048576 bytes. Truncated evidence is refused.                                                      |
| `maxWorktrees`              | Stored binding and live worktree cap, and state scan page size, 1–1000 entries. Creating and uncertain reservations count.        |
| `fetchBeforeClean`          | Whether cleanup refreshes the default branch. Fetch is forbidden during a dry run.                                                |
| `envNames`                  | Explicit environment variable names to select from the host, at most 1024. Include the command's PATH and platform prerequisites. |
| `hookDirectory`, `hookArea` | Directory relative to the selected project, private Git or common Git root. It must already be the effective hook directory.      |
| `hookCommand.executable`    | Explicit command to execute. It must resolve before installation or healthy status.                                               |
| `hookCommand.args`          | Argv elements, at most 64. The tiny shell hook quotes each element.                                                               |
| `hookCommand.files`         | At most 100 project-relative prerequisite files. Missing files make the hook inactive.                                            |
| `hookMaxBytes`              | Bounded hook/prerequisite read budget, 64–65536 bytes.                                                                            |

## Hook ownership

`hook.install` is an explicit request. It writes a two-line hook exclusively into the configured directory and area only when Git reports that directory as effective. For native hooks, choose `hookArea: common` and `hookDirectory: hooks`. An existing user hook at the requested name is preserved; unrelated hooks remain in place. A mismatching manager path is reported rather than changed. Installation and removal never modify `core.hooksPath` or another Git configuration key, including during concurrent user configuration changes.

The block stores owned bytes and the effective directory in state. Removal requires those exact bytes; edited files and user replacements are preserved. An interrupted creation can leave a reserved receipt whose file ownership is unconfirmed. After reading status, `hook.install` with `adoptExisting: true` explicitly adopts only bytes matching that reservation. Confirmed creations resume without rewriting the file. Status reads actual bytes, the effective hooks path, command resolution, declared prerequisite files and the POSIX executable bit; Windows does not use that bit. No hook is installed as a side effect of another operation.

## Service and authority boundary

The block requires invocation-scoped `process`, `files`, `environment` and `state` services. Process execution uses the shared `ProcessPort`; clone files use exclusive creation, expected-byte removal and invocation-scoped Git metadata locks. Every mutating operation declares its noun's state write effect and `external:write`. Process launches declare `external:process` even for observations; selecting explicit configured `envNames` declares `environment:read`. Hook reads declare `files:read`, and file mutations/metadata locks declare `files:write`. The current MCP read-only filter consequently hides these process-based observations. Commands carry the invocation's cancellation signal, deadline, full explicit environment and bounded output. Git location/config override variables are removed, and interactive prompting is disabled. No credential is returned in operation output.

The lane's shared provider assembly is a separate prerequisite. The block contains no host-specific wiring and adds no runtime dependency.
