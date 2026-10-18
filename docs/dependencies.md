# Dependency ledger

A dependency is acceptable when it adds real value we would otherwise build and maintain, its project is active and well run, and it fits the Bun-first build without forcing a user's toolchain. There is no numeric ceiling. Every dependency has an entry below, and every runtime dependency sits behind exactly one adapter in `src/adapters/<name>/` (declared in that folder's `adapter.json`). `test/structure/dependency-ledger.test.ts` and `test/structure/dependency-boundary.test.ts` fail on a dependency with no entry, no adapter, or an import outside its adapter.

Each entry is a `### <package>` heading with these fields: **Saves** (what we would otherwise build), **Maintenance**, **Transitive packages**, **Fit** (Node 24/26 and Bun), **Licence**, **Trust**, **Swap proof**, and for runtime dependencies **Adapter**. Every `overrides` entry gets a `### override: <package>` entry with **Issue** and **Expires** (`YYYY-MM-DD`); an expired override fails the test.

Not npm dependencies, so not entries here: Bun itself is pinned by `packageManager` (and `bun lint` / `bun fmt` run on a Bun canary build in CI until a stable Bun ships them; the scripts fail fast on a Bun without them), and `git` is the only external tool the shipped package may require.

## Runtime dependencies

### @modelcontextprotocol/server

- **Saves:** MCP framing, protocol negotiation, era-specific wire codecs, stdio lifecycle, protocol errors and notifications. Node built-ins supply streams, not an MCP implementation. The adapter uses the SDK's `serveStdio` factory entry to serve both protocol eras without a protocol implementation of our own.
- **Maintenance:** official TypeScript SDK maintained at [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk); stable v2 implements the 2026-07-28 specification. Version 2.3.1 is pinned by owner decision; upgrades need review because the 2.3.0 API changes include per-request serving and redirect handling (plan section 6.2).
- **Transitive packages:** two distinct runtime packages: `@modelcontextprotocol/core` 2.3.1 and `zod ^4.2.0`; core depends on the same zod range. Verified from registry metadata and isolated installs on 2026-10-18. No client package is needed.
- **Fit:** isolated installation succeeds with Node 24.18.0, Node 26.12.0 and Bun 1.4.3. The local adapter wire suite passes legacy `2025-11-25` initialize and modern `2026-07-28` metadata/discovery, tool listing/calls/errors and idempotent close. The artifact fixture is `test/surface/fixtures/artifact.mjs`; runtime results are recorded in the PR. The SDK declares Node >=20. No install scripts or user toolchain assumptions are added.
- **Licence:** Apache-2.0 (published package metadata and LICENSE).
- **Trust:** official scoped registry package; intended runtime declaration is exact `2.3.1`. L0 owns `package.json` and `bun.lock`; this lane requests that declaration and the lockfile in its PR, rather than editing shared files. Until L0 lands it, a clean install cannot load the adapter and dependency structure checks correctly fail.
- **Swap proof:** `McpTransportPort` is the only caller-facing interface. The same generated `McpHandlers` serve both eras through the adapter. The wire contract suite exercises discovery, structured/text envelope parity, protocol versus operation errors and owned-handle cleanup; the catalog is a fake and imports no runtime implementation.
- **Adapter:** `src/adapters/mcp-transport/` implements `src/ports/mcp-transport.ts`.
- **Conformance shortfall:** the official `@modelcontextprotocol/conformance` 0.1.16 runner's `server --help` accepts only `--url`, with no stdio transport option. `list --server --spec-version 2026-07-28` exits 1: `Unknown spec version: 2026-07-28` (valid date versions stop at 2025-11-25). Consequently official conformance is **not proven on either era** for this stdio adapter. Local wire journeys are narrower evidence, not certification. No HTTP transport, substitute SDK, or custom protocol implementation was added to hide this gap. Host interoperability remains an integration acceptance item. [SDK stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/stdio/) describes the factory's dual-era selection.

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
