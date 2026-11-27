# Forge

Forge is a local command-line tool for developers and coding agents to track work
and run project checks.

## Install

Install Git and Node.js 24.15 or later in the 24.x series, or Node.js 26 and later.
npm comes with Node.js. Run this in a terminal.

```sh
npm i -g forge-workflow
forge --help
```

## Quickstart

In a Git repository that already has a commit and a test script, skip to
`forge template import delivery`. To try Forge in a new folder, create a small
npm project with a test script that prints the Node.js version.

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

Import the delivery template, generate agent skills, and create and claim an issue.

```sh
forge template import delivery
forge skills sync
forge issue create --title "First task" --kind task
forge issue claim demo-1
forge check run
```

`demo-1` is the first issue in the demo. In your own project, use the ID returned
by `forge issue create`. In an interactive terminal, Forge supplies the default
session for the claim. For scripted claims, set `FORGE_SESSION` to a stable session name.

Forge detects the demo's npm test script. Look for `PASS` and a receipt ID in the
result from `forge check run`. The receipt records which commit Forge checked.

## What you can do

- **Track work.** Use `forge issue ready` to find open issues with no blockers or
  live claims. Use `forge issue show demo-1` to see the demo issue and its claim.
- **Set up a coding agent.** `forge template import delivery` adds the delivery
  blocks to project configuration. `forge skills sync` writes skills and their
  command references. Start with the `forge-loop` skill to plan, build, check,
  and review a change.
- **Check changes before pushing.** `forge check run` runs project checks and
  records a receipt. In a repo with an approved GitHub account binding,
  `forge accounts check` checks the author and committer email on outgoing commits.
- **Check a pull request before merging.** `forge check gate --pr <number>`
  checks GitHub requirements and verifies a passing receipt for the current
  head. See the [check block documentation][checks] for the gate's full rules.

Use `forge <noun> <verb> --help` for command examples and arguments. Add `--json`
to help for the machine-readable contract.

## How Forge works

A template sets up blocks in `.forge/config.yaml`. The same block definitions
supply CLI commands, generated agent skills and the tools an MCP client can call.
Checks run the commands declared or detected for your project. Gates can use
those check results to decide whether a change can proceed.

Forge 0.0.11 supports local projects only. The project store and device store
live on your machine. If Forge reports a missing registered store, restore it
from backup. See the [local release runbook][release] and [security policy][security].

### Claim identity

Claims belong to a device and session. To keep a claim across scripted calls
on the same device, pass the same `FORGE_SESSION` each time. See the
[work block documentation][work] for session and device identity rules.

## Upgrade and rollback

The store upgrade in 0.0.11 is one-way. Back up both the project and device
stores before upgrading. Upgrade every Forge installation on the machine
together. Older builds can fail with schema or context errors on upgraded
stores, including writes in other projects that use the shared device store.

Retain migration `003_device_session_identity`. To roll back, restore both
pre-upgrade backups and run the older build. Existing leases without a device
still accept their original actor and session.

## Install and network

Forge declares no npm install hooks. Its native dependency `koffi` runs an
install script that tries a prebuilt binary and falls back to building from source.

Local issue reads and memory searches read local state without sending it
anywhere. GitHub account setup, pull request checks and merges, and issue closes
that verify a linked PR use `gh`. Some lane operations fetch from the configured
Git remote. The project check commands you run can make their own requests.

Outside the 0.0.11 support boundary, [experimental cloud sign-in][cloud] and
cloud-bound issue and lane operations can send requests to the configured Forge
cloud origin.

## Device memory

Use `forge memory add --level device "Remember the release checklist"` to save
a note on this machine, then `forge memory search "release checklist"` to find
it. Device memory works without a Forge project. Project-level notes require
one. See the [memory scope guide][memory] for how Forge finds notes.

## MCP

After importing the delivery template, add this section to `.forge/config.yaml`
to expose the issue and check commands as MCP tools.

```yaml
mcp:
  expose: [issue, check]
```

Configure your MCP client to start `forge --mcp` as a stdio server from the
project folder.

Forge admits up to eight concurrent tool executions per stdio connection.
When all slots are occupied, a new execution receives `MCP_BUSY` immediately.
Wait for a call to finish, then try again. Protocol checks, tool listing, and
`catalog_list` and `catalog_describe` stay available while the server is full.

Cancelling a request stops its runtime invocation and releases its slot after
cleanup. Any writes already committed at the cancellation point remain in
place. Check the affected state before repeating a cancelled write.

## Owner approval

Forge asks the owner before admitting a block, granting effects, recovering a
store, or forgetting, restoring or adopting memory. A terminal user confirms
the requested operation. An agent asks the owner in chat and relays the reply.
This records consent. Protect local state with operating system permissions.

## Write a block

Follow [Writing a block](docs/writing-a-block.md) and the
[hello block example](examples/hello-block). Forge exports ESM JavaScript and
TypeScript declarations for `node16` and `bundler` resolution. CommonJS consumers
use dynamic `import()`.

## Contributing

See the [contributing guide][contributing] for repository setup and checks.
Report vulnerabilities through the [security policy][security].
Forge uses the [MIT License][license].

[checks]: https://github.com/harshanandak/forge/blob/main/src/blocks/check/README.md
[cloud]: https://github.com/harshanandak/forge/blob/main/docs/reference/cloud.md
[contributing]: https://github.com/harshanandak/forge/blob/main/CONTRIBUTING.md
[license]: https://github.com/harshanandak/forge/blob/main/LICENSE
[memory]: https://github.com/harshanandak/forge/blob/main/templates/delivery/harness/memory-rules.md
[release]: https://github.com/harshanandak/forge/blob/main/docs/release.md
[security]: https://github.com/harshanandak/forge/blob/main/SECURITY.md
[work]: https://github.com/harshanandak/forge/blob/main/src/blocks/work/README.md
