# Step 3 — CI cross-compile job: 5 targets + per-platform smoke test

**Issue:** f13b5073-3b9f-4098-bbe4-432b7bd69485
**Epic:** 6f11d483-5cf0-4fce-86a4-42c82dff0897 ([dist] Single static binary via `bun build --compile`)
**Deliverable:** `.github/workflows/build-binary.yml`
**Date:** 2026-07-13

## Goal

Produce distributable `forge` binaries for every canonical target on CI, smoke-test
what the runner can execute, gate on npm-vs-binary parity, and upload each binary as
a named workflow artifact. This step **produces + verifies + uploads** only. It does
**not** wire the GitHub Release upload — that is Step 4 (50afbc47).

## Key finding: Bun cross-compiles all targets from ONE runner

Proven locally on a Windows host (bun 1.3.6). A single machine compiled the native
host target **and** all six cross targets successfully:

The seven targets that compiled from the single host: `bun-windows-x64` (native
host), `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`,
`bun-linux-x64-musl`, `bun-linux-arm64-musl`. Each `--target=<t>` compile finished
in a few seconds. (Exact binary sizes/timings vary by bun version and dependency
tree — reproduce them with the compile command below rather than trusting a pinned
number.)

**No target needs its own OS runner** — the workflow is a single `ubuntu-latest`
matrix job that cross-compiles via `--target=<t>`. Musl variants are cheap, so they
are included.

## Architecture

Three jobs:

1. **`set-matrix`** — emits the target matrix as JSON. PR events → `[bun-linux-x64]`
   only (keep PR cost low). `workflow_dispatch` + release tags → all 7 targets. The
   `build` job consumes it via `fromJSON(needs.set-matrix.outputs.targets)`.
2. **`build`** (matrix over targets) — checkout → setup-node/bun → `bun install` →
   **regenerate embed manifest** (`bun scripts/gen-embedded-assets.mjs`) → compile
   `bun build --compile --target=<t> --define FORGE_COMPILED=true ./bin/forge.js` →
   assert artifact non-empty → smoke test (only `matrix.smoke` targets) → upload the
   binary as artifact `forge-<target>`.
3. **`parity`** — runs `bun scripts/parity-check.mjs`, which self-builds the native
   binary (`bun run build:binary`) and asserts the npm setup tree and the binary
   setup tree are byte-identical. This is the authoritative drift gate and also
   exercises the native binary end-to-end (`setup --quick --yes`).

### Why regenerate the manifest inside the job

The workflow never relies on the committed `lib/embedded-assets.generated.mjs`. Each
`build` leg regenerates it fresh via `bun scripts/gen-embedded-assets.mjs`. The
generator is deterministic (it prints a stable content fingerprint on each run), so
every target in the matrix embeds byte-identical content. The fingerprint value is
emitted by the generator for audit — run the script to see the current value rather
than relying on a pinned copy here.

## Triggers

| Event | Targets | Smoke | Parity |
|-------|---------|-------|--------|
| `pull_request` (paths: bin/lib/scripts/package.json/bunfig.toml/this workflow) | bun-linux-x64 only | yes (linux-x64) | yes |
| `workflow_dispatch` | all 7 | linux-x64 | yes |
| `push` tag `v*` (release build) | all 7 | linux-x64 | yes |

## Smoke coverage (honest gap statement)

`ubuntu-latest` is glibc x64, so only **bun-linux-x64** runs natively and gets a real
smoke test: `--version` (asserts `Forge v…`) + `setup --quick --yes` in a temp git
dir + `ready`. All other targets (windows, darwin/arm64/x64, linux-arm64, both musl)
**cannot execute on the runner** and are **artifact-only** here: the workflow asserts
each produced binary exists and is non-empty, but does not run it. Their runtime is
covered separately by the npm-side cross-OS test matrix (`test.yml`) and by downstream
install/use. Adding real darwin/windows/arm smoke would require dedicated OS runners
(and QEMU for arm) — deferred as a possible follow-up, not required for this step.

## Local proof (commands from the workflow, run on the host)

These are the exact commands the workflow runs; each was executed locally and
passed. Run them yourself to reproduce (outputs — file counts, sizes, fingerprint —
are generated dynamically and intentionally not pinned here):

- `bun scripts/gen-embedded-assets.mjs` — regenerates the embed manifest and prints
  the asset count + content fingerprint.
- `bun build --compile --target=<t> …` — compiled all seven targets from the host.
- `<binary> --version` — prints `Forge v<version>` and exits 0.
- `bun scripts/parity-check.mjs` — reports equal npm/binary file counts and
  `PARITY OK` (byte-identical setup trees); it self-builds the binary and runs
  `setup --quick --yes`.

## Conventions followed

Matches existing workflows: `actions/checkout@v6`, `oven-sh/setup-bun@v2` (bun
`1.3.12`), `actions/setup-node@v6` (node 24), `actions/upload-artifact@v7`,
`permissions: contents: read`, `concurrency` group with cancel-in-progress, path
filters on PR.

## Out of scope (filed elsewhere)

- GitHub Release upload / install script → Step 4 (50afbc47).
- Binary bloat from embedding all of `scripts/` → 7a584ad4.
