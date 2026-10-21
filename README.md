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

The demo's first issue is `demo-1`. In another repository, use the id returned
by create. Check results include a receipt and a status; inspect that status
before proceeding. Skills are written under `.agents/skills`.

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

Install Bun 1.4.3+. From a clone of this repository:

```sh
bun install
bun run build
bun run test:unit
bun run check
bun run test:structure
```

The `test:integration` script runs process and Git journeys. `test:pack` builds,
packs and installs the package with npm, then runs its packed journeys on Node.
The `test` script runs all lanes. CI runs the full matrix. Lint and format
scripts require a canary Bun that supplies those built-ins. Read
[AGENTS.md](AGENTS.md) and [CODING_STANDARDS.md](CODING_STANDARDS.md) before editing.
