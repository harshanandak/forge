# Writing a block

Start with `examples/hello-block/`, also included in the `forge-workflow` npm
package. It has five files and no dependencies:

- `forge.block.json` declares the block and its operations.
- `input.schema.json` requires a nonempty text `name` and rejects unknown fields.
- `output.schema.json` requires a text `message` and rejects unknown fields.
- `docs.json` describes `hello.say`, with a working input/output example.
- `index.cjs` exports a CommonJS object keyed by operation name. Its handler
  receives `{input, config, services, signal, deadline}` and returns JSON
  (or a Promise of JSON). This handler only needs `input`.

## Manifest fields

`schemaVersion: forge.block/1` selects the manifest contract. `id` is
`publisher/name`; replace `example.org/hello` with your own identity. `version`
is a semantic version. `authorAbi: forge.author/v2` and
`profile: trusted-action/v2` select the current handler contract.
`entry` names the self-contained CommonJS file; it cannot require dependencies.
`docs` names the operation documentation file. Paths are relative to the block
directory and must stay inside it. Forge captures these files and the schemas
into a digest before executing code.

`operations` maps `noun.verb` names to declarations. For `hello.say`:

- `input` and `output` name the JSON schemas for the handler's argument and return.
- `context: stateless` requires no project state or lease.
- `timeoutMs: 1000` declares a one-second handler budget, adjustable in config.
- `effects: []` declares no external effects; admission alone grants no effects.
- `idempotent: true` says repeating the operation has the same effect.
- `callers: [human, agent]` allows both caller kinds to invoke it.
- `stability: stable` marks the public operation contract stable.

For optional fields and other contexts, see the canonical
[manifest schema](https://github.com/harshanandak/forge/blob/main/schemas/block.json)
and [operation schema](https://github.com/harshanandak/forge/blob/main/schemas/operation.json).

## Check, add, admit, use

Use Node 24.15+ in the 24.x line, or Node 26+, and Git. In a scratch Git project,
install locally with `npm install forge-workflow` (or `npm install <tarball>`).
Copy `node_modules/forge-workflow/examples/hello-block` to `./hello-block`.
Run the following from that project. `npx` uses the locally installed executable.
With a global installation, the equivalent commands start with `forge`.

<!-- The packed journey executes this sequence from the installed guide. -->

```sh
npx forge block check ./hello-block
npx forge block add ./hello-block
npx forge block admit <digest>
npx forge hello say --name World
```

`check` succeeds with `ok: true`, a `blockId` of `example.org/hello`, a
`sha256:` digest and `admitted: false`; it executes no handler and registers
nothing. `add` writes the block source to `.forge/config.yaml`, then returns
`ok: false`, `status: INCOMPLETE`, `ADMISSION_REQUIRED` and exit 2 until admitted.
This is the expected next step: its `repair` contains `forge block admit` with
the same digest returned by `check`. Replace `<digest>` with that exact digest.
Admission is a human decision to execute these captured bytes; the local CLI
authenticates the human, while MCP cannot admit code. `admit` returns
`admitted: true`. The final command returns `ok: true` and
`result: {"message":"Hello, World!"}`. Each command runs in a fresh process.

Changing captured files changes the digest: check, add and admit again after
reviewing the new code. Bad manifests return `INPUT_INVALID`, exit 6, the manifest
path and one sentence per failing field, including spelling suggestions. Fix
every reported field and rerun `check` before proceeding.
