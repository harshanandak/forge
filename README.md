# Forge

Forge provides commands, MCP tools and agent skills from the same block catalog.
The npm package is `forge-workflow`; the command is `forge`.

## Quickstart

Install Node 24.15 or later 24.x, or Node 26 and later (Node 25 is not supported)
and Git. npm ships with Node. Bun is needed
only for contributing to Forge.

```sh
npm install --global forge-workflow
forge --help
```

In an existing Git repository with a commit and a test script, start at the
template import below. To try it in a new directory, create this demo first.
Its test script is a smoke check that prints the Node version.

```sh
mkdir demo
cd demo
git init
npm init -y
npm pkg set scripts.test="node --version"
npm install --package-lock-only
git add package.json package-lock.json
git -c user.name=Example -c user.email=example@example.com commit -m "Initialize demo"
```

Import the delivery template, generate skills and run the detected check:

```sh
forge template import delivery
forge skills sync
forge check run
forge issue create --title "First task" --kind task
forge issue show demo-1
```

Start delivery with `forge-loop`. It routes a settled slice to `forge-build`
(including opening the PR), feedback to `forge-review`, and a checked PR to
`forge-land`. Sync also installs the review thread helpers beside their skill.

The demo's first issue is `demo-1`. In another repository, use the id returned
by create. Check results include a receipt and a status; inspect that status
before proceeding. Skills are written under `.agents/skills`. Start or resume
with `/forge-loop`; it routes vague requests to `forge-intake` for decision
rounds before framing and slicing.

Project state writes register the store's location on this device. If that
store later disappears, state reads and writes report its missing path. Restore
the store from backup, or run `forge store reinit` to start a new empty store
and identity. Recovery replaces the old same-root device registration and refuses
if a store is present. It grants no permission to later calls. Fresh project reads
create nothing.
Detection requires the device registration: older stores become registered on
their next write, and losing both stores removes the evidence of prior state.

Help is short text. Operation results default to JSON. For full schemas:

```sh
forge issue --help --json
forge catalog describe issue.create
```

For a project-local installation (`npm install --save-dev forge-workflow`),
invoke the installed entry point directly in frequent scripts or agent commands:

```sh
node node_modules/forge-workflow/dist/bin/forge.js issue list
```

This avoids npm's `npx` startup and package resolution on every invocation.
The globally installed `forge` command also runs the installed entry point.
Windows measurements and the profiling method are in
[Local read performance](docs/local-read-performance.md).

## Claim identity

An issue claim belongs to a device plus a session. Agent and harness names are
labels: renewal records the current caller's names, and refusals and `issue show`
identify the holder. CLI and MCP calls keep their own caller classification;
renewal and release events name the caller that performed the operation.

A trimmed, nonempty `FORGE_SESSION` takes precedence. Otherwise Forge combines
the native Codex and Claude session IDs present, in that fixed order, into a
readable key tagged `codex:<id>` and `claude-code:<id>`, joined with `+`.
IDs are percent-encoded to keep separators unambiguous. Codex uses its root
`CODEX_SESSION_ID`, falling back to `CODEX_THREAD_ID` on older builds;
Claude uses `CLAUDE_CODE_SESSION_ID`. Nested harnesses
get distinct identities; native subagents inheriting the same IDs share their
session intentionally. `CODEX_COMPANION_SESSION_ID` is plugin metadata and does
not count. Without a session source, a terminal with TTY stdin uses `local-cli`;
non-TTY CLI and MCP calls refuse every leased operation, including claims,
renewals and releases. Set `FORGE_SESSION` for those calls. To recover a claim
made from an interactive terminal, set `FORGE_SESSION=local-cli` on the same
device.

Forge creates a device ID as `<sanitized-lowercase-hostname>-<UUID>` once in
`device-id` under `FORGE_DEVICE_ROOT` (default `~/.forge`) and reads it thereafter.
The hostname uses only lowercase letters, digits and hyphens, with `device` as
the fallback. Existing identity files are preserved. `FORGE_DEVICE_ID` overrides that
file for cloned images and CI. An unavailable identity refuses acquisition rather
than using the root path. Reads do not create identity files. Deliberately sharing
a claim across harnesses requires the same `FORGE_SESSION`; across machines it
also requires the same `FORGE_DEVICE_ID`, because device remains part of the key.

This release makes a one-way state-store upgrade. Back up project and device
stores before upgrading, and upgrade every Forge installation on a machine
together. Pre-change builds fail against upgraded stores with schema or context
errors; they do not reliably recognize the new migration marker. The device
store also carries the marker, so old-build writes fail across all projects on
that machine. Retain migration `003_device_session_identity`; rollback requires
restoring the pre-upgrade backups and using the older build. Existing leases without a device
still accept their original actor and session. See the
[work block documentation](src/blocks/work/README.md) for the full rules.

## Device memory

Device memory works from any folder, without importing a template or creating a
project config:

```sh
forge memory add "Remember the release checklist"
forge memory search "release checklist"
```

Outside a Forge project, people default to device memory; agents must specify
`level: "device"`. Notes are shared with other folders and projects on the same
device. Project-level writes, moves and exports require a Forge project. Reads
create no stores, and device-only calls create no project state. A configured
project keeps its own block selection and level policy.

In any git checkout, device memory uses the shared checkout's normalized folder
name or its alias in `memory-scopes.json` under `FORGE_DEVICE_ROOT`, including
from nested folders and linked worktrees. A valid project's memory scope override
takes precedence. Project config is read from the current folder; nested folders
do not inherit it. Outside git and a Forge project, the scope is `general`.
New device notes default to the resolved scope; an explicit `scope: null` leaves
them unscoped. If project config cannot load, `memory scope`, `rules`, `search`,
`show` and device-level `add` remain available with a warning. The repo override
and project-level memory remain unavailable until the config is repaired; other
commands retain their config errors.

Run `forge memory rules` at session start for a pointer under 400 characters:
note counts for general and this project's scope, with commands to search by
topic and show relevant notes on demand. It prints no note text or ids. Use only
search hits in the named scopes or unscoped. See the
[per-harness recipes](templates/delivery/harness/memory-rules.md) for automatic
startup pointers and the single AGENTS.md fallback.

## Write a block

Copy the complete [hello block](examples/hello-block) and follow
[Writing a block](docs/writing-a-block.md) to check, add, admit and run it.
The example and guide also ship in the npm package.

## MCP

After importing the template, add this top-level section to
`.forge/config.yaml` to expose issue and check tools directly:

```yaml
mcp:
  expose: [issue, check]
```

Configure your MCP client to launch the `forge` executable with the argument
`--mcp` and the project directory as its working directory. To launch it yourself:

```sh
forge --mcp
```

This is a stdio server: the client sends MCP requests on stdin and reads replies
from stdout. After connection, `tools/list` includes `issue_create` and
`check_run`. `catalog_describe` provides schemas; `catalog_call` can invoke an
exposed operation by name when it is outside the direct-tool budget. Exposure
rules still apply to that fallback.

## Contributing

Install Bun 1.4.4+. From a clone of this repository:

```sh
bun install
bun run build
bun run test:unit
bun run check
bun run test:structure
```

The `test:integration` script runs process and Git journeys. `test:pack` builds,
packs and installs the package with npm, then runs its packed journeys on Node.
The `test` script runs all lanes. CI runs the full matrix. Lint requires a canary
Bun; format is available in stable Bun 1.4.4. Read
[AGENTS.md](AGENTS.md) and [CODING_STANDARDS.md](CODING_STANDARDS.md) before editing.
