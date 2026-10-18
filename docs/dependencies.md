# Dependency ledger

A dependency is acceptable when it adds real value we would otherwise build and maintain, its project is active and well run, and it fits the Bun-first build without forcing a user's toolchain. There is no numeric ceiling. Every dependency has an entry below, and every runtime dependency sits behind exactly one adapter in `src/adapters/<name>/` (declared in that folder's `adapter.json`). `test/structure/dependency-ledger.test.ts` and `test/structure/dependency-boundary.test.ts` fail on a dependency with no entry, no adapter, or an import outside its adapter.

Each entry is a `### <package>` heading with these fields: **Saves** (what we would otherwise build), **Maintenance**, **Transitive packages**, **Fit** (Node 24/26 and Bun), **Licence**, **Trust**, **Swap proof**, and for runtime dependencies **Adapter**. Every `overrides` entry gets a `### override: <package>` entry with **Issue** and **Expires** (`YYYY-MM-DD`); an expired override fails the test.

Not npm dependencies, so not entries here: Bun itself is pinned by `packageManager` (and `bun lint` / `bun fmt` run on a Bun canary build in CI until a stable Bun ships them; the scripts fail fast on a Bun without them), and `git` is the only external tool the shipped package may require.

## Runtime dependencies

Each one gets an entry here and an adapter in the same pull request.

### yaml

- **Saves:** a YAML 1.2 parser and serializer for `.forge/config.yaml` (settled decision 5): strict parsing with duplicate-key, alias and custom-tag refusal, line-numbered errors, and output that reads back to the same value. A correct YAML 1.2 implementation is a large, subtle piece of code we would otherwise write and keep up.
- **Maintenance:** actively maintained by Eemeli Aro, also a YAML spec contributor; 2.9.1 published 2026-09-11, a 3.0 line in prerelease alongside.
- **Transitive packages:** 0.
- **Fit:** pure JavaScript with no install scripts; `engines` `node >= 14.6`. Used by the published package on Node 24/26 and by our tests under Bun 1.4.3 (the codec contract suite in `test/adapters/l4-config/` runs against it). Strict settings: `version: "1.2"`, core schema, `strict`, `uniqueKeys`, `merge: false`, aliases refused (`maxAliasCount: 0`), and parse budgets enforced around it.
- **Licence:** ISC.
- **Trust:** published to npm by its single long-standing maintainer; the exact version and integrity hash are pinned in `bun.lock`. About 686 kB unpacked.
- **Swap proof:** only `src/adapters/config-yaml/` imports it, behind `ConfigCodecPort`; the codec contract suite passes for this adapter and for an in-memory JSON fake, so another YAML library (or the 3.x line) replaces it by changing that one folder.
- **Adapter:** `src/adapters/config-yaml/` (`ConfigCodecPort`).

## Development dependencies

### typescript

- **Saves:** the emit of the published `dist/**/*.js` and `.d.ts` files, which Bun cannot produce; type checking itself is `bun check`.
- **Maintenance:** Microsoft's native compiler line; 7.0.2 published 2026-10-16 on the 7.x line.
- **Transitive packages:** 0 JavaScript packages; 20 optional platform binaries (`@typescript/typescript-<os>-<cpu>`), of which one is installed per machine.
- **Fit:** runs as a native binary under Node 24/26 and Bun alike; it only runs in our build, never in the published package. Verified locally with Bun 1.4.3 on Windows; CI covers Linux, macOS and Node 26.
- **Licence:** Apache-2.0.
- **Trust:** published to npm by the TypeScript team; the exact version and integrity hash are pinned in `bun.lock`.
- **Swap proof:** `tsconfig.build.json` is plain `tsc` options; any emitter that produces the same `dist/` layout passes `tools/pack-smoke`.

### @types/bun

- **Saves:** type definitions for `bun:test` and `Bun.*` used by tests and structure guards, so `bun check` covers them.
- **Maintenance:** released in step with Bun (1.4.3 published 2026-10-12); lives in DefinitelyTyped.
- **Transitive packages:** 2 (`bun-types`, `undici-types`), plus the shared `@types/node`.
- **Fit:** only `tsconfig.json` (tests and tools) loads it; `tsconfig.build.json` loads Node types only, so Bun APIs cannot compile into the published package.
- **Licence:** MIT.
- **Trust:** DefinitelyTyped publish pipeline; version and integrity pinned in `bun.lock`.
- **Swap proof:** removing it only affects test files; the package build does not reference it.

### @types/node

- **Saves:** type definitions for the Node 24 APIs the shipped code uses.
- **Maintenance:** DefinitelyTyped; 24.19.2 published 2026-10-09.
- **Transitive packages:** 1 (`undici-types`).
- **Fit:** pinned to the 24 line, the Node floor; no runtime code.
- **Licence:** MIT.
- **Trust:** DefinitelyTyped publish pipeline; version and integrity pinned in `bun.lock`.
- **Swap proof:** types only; the compiled output is identical without it, only the type check changes.
