# npm Runtime Package Hotfix

## Problem

`forge-workflow@0.1.0-beta.6` installs from npm but the CLI exits with
`MODULE_NOT_FOUND` because root runtime modules import unpublished workspaces by
repository-relative paths and the root tarball omits those workspaces.

## Decision

Use npm's existing bundled-dependency mechanism. Root runtime code imports
`@forge/memory`, `@forge/memory-contracts`, and `@forge/flow` by package name;
the root manifest declares and bundles those workspaces. This preserves their
package boundaries without publishing separate scoped packages.

## Scope

- Add a packed-root fresh-install regression that runs the CLI and quick setup.
- Replace repository-relative runtime workspace imports with package imports.
- Bundle the three internal runtime workspaces in the root npm package.
- Advance the immutable correction to `0.1.0-beta.7`.

## Constraints

- No external dependency changes.
- Do not overwrite or unpublish beta.6.
- Keep npm `latest` unchanged.
- Tag and publish only after exact-head CI and manual merge.

## Rollback

Before publication, delete the beta.7 draft release and tag. After npm
publication, publish a later beta; npm versions are immutable.
