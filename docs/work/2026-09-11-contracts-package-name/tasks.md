# Tasks

## Task 1: Rename the contracts package boundary

OWNS: the contracts workspace directory, root and product package manifests,
`bun.lock`, all tracked consumers/tests/docs, validation risk-manifest source
and generated output, package metadata assertions, `CHANGELOG.md`.

What to implement: mechanically replace the former Memory-qualified workspace
and npm package name with `contracts` / `@forge/contracts`, without changing
exports, schemas, behavior, or versions.
Add the public Forge repository, homepage, bugs URL, existing MIT license, and
explicit public publish access to all three bundled workspace manifests.

TDD steps:

1. Run the structural and installed-package tests before the rename and confirm
   they encode the old name.
2. Change the assertions first and confirm the focused structural test fails
   because `packages/contracts` does not exist.
3. Rename the workspace and update all tracked references.
4. Assert the packed workspace manifests carry repository, MIT, and public-access metadata.
5. Regenerate `bun.lock` and the validation risk manifest using repository tools.
6. Run zero-hit search, focused package tests, installed-package smoke, lint, and
   full validation.
7. Commit: `fix: rename contracts package`.

Expected output: only `@forge/contracts` and `packages/contracts` remain, packed
installation succeeds, and all validation is green.
