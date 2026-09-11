# Rename the contracts package

Status: approved
Date: 2026-09-11
Issue: `4d41ffb7-8793-4a17-a30b-92130db69672`

## Purpose

Use the product-neutral name `@forge/contracts` and workspace path
`packages/contracts` before the package is first published. The former
Memory-qualified name incorrectly presented shared Flow, Memory, monitoring,
claim, and receipt contracts as a Memory-only surface.

## Success criteria

- The package is named `@forge/contracts` at `packages/contracts`.
- Every runtime consumer, workspace dependency, bundled dependency, test,
  validation selector, generated manifest, lock entry, and current design or
  release reference uses the new name and path.
- A repository-wide tracked search finds no former Memory-qualified package
  name or workspace path.
- Fresh root packing and installation loads `@forge/contracts`, `@forge/memory`,
  and `@forge/flow` through the installed package.
- All three workspace manifests identify the public Forge repository and MIT
  license, explicitly publish with public access, and packed manifests preserve
  that metadata.
- Focused boundary tests, full validation, and exact-head CI pass before beta.7.

## Approach selected

Rename both the npm identity and workspace directory in one mechanical change.
Update generated artifacts through their repository generators and regenerate
`bun.lock` with the pinned Bun runtime. No compatibility alias or forwarding
package is added because live npm checks confirmed neither package name has
been published.

Rejected alternatives:

- Rename only the npm identity: leaves a misleading internal path and recurring
  translation cost.
- Publish an alias: creates a permanent extra package for a name no user has
  consumed.

## Constraints

- Do not change contract schemas, exports, validation behavior, or versions.
- Do not add a dependency or exemption.
- Preserve generated-file and protected-path gates.
- Keep the repository public and its tracked MIT license authoritative; do not
  manufacture an OpenSSF score before npm publication makes packages scorable.
- Do not publish beta.7 until this rename is merged and verified.

## Edge cases

- Workspace symlink tests must expect the new scoped package path.
- The standalone tarball smoke must pack the renamed workspace and require the
  new npm name.
- Risk-manifest owner ids and generator labels use `contracts`; generated JSON
  must be regenerated, not hand-maintained.
- Historical planning records are pre-release design authority, not a released
  compatibility record, so they are corrected to the selected name.

## Security and failure analysis

The relevant supply-chain risk is dependency confusion from leaving active
references to an unpublished old name. A zero-hit tracked search and exact
workspace dependencies prevent accidental registry resolution. Explicit
repository and license metadata gives registry and security tooling the source
link it needs after publication. No credential, network write, or new executable
path is introduced.

## TDD scenarios

1. Structural package-boundary tests are updated first and fail because the new
   `packages/contracts` workspace does not yet exist, then pass after the
   complete rename.
2. The installed-package smoke fails to load `@forge/contracts` until root
   bundling and workspace manifests are updated.
3. The risk-manifest check fails after the source rename until the generated
   manifest is regenerated.

## Out of scope

- Contract schema or API changes.
- Publishing the release.
- Compatibility aliases for unpublished names.

## Ambiguity policy

Proceed only with mechanical name/path substitutions covered above. Any schema,
runtime behavior, version, or public export change is outside this plan and must
stop for a separate decision.
