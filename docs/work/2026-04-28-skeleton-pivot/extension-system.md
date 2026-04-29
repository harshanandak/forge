# Forge Extension Import/Management System — Design

**Status:** Proposal
**Date:** 2026-04-28
**Layer fit:** Sits at Layer 2 (swappable defaults). Extensions register skills/stages/commands without forking core (Layer 1) and remain overridable by `patch.md` (Layer 3).

---

## 1. MANIFEST EXAMPLE — `extension.yaml`

```yaml
apiVersion: forge.dev/v1
kind: Extension
metadata:
  name: superpowers              # short, kebab-case
  author: obra                   # GitHub user/org or npm scope
  version: 1.4.2                 # semver
  license: MIT
  homepage: https://github.com/obra/superpowers
spec:
  type: [skill, command]         # skill | stage | gate | adapter | command | hook
  layer: 2                       # 1=rails, 2=default, 3=override
  entry:
    skills: ./skills             # dirs merged into .claude/skills/<author>/
    commands: ./commands         # *.md merged into .claude/commands/<author>/
    stages: ./stages/*.js        # registered via lib/commands/_registry
  forge: ">=0.9.0 <2.0.0"        # peer-range against forge core
  dependencies:
    - gh:anthropics/claude-skills@^1.0.0
  hooks:
    postInstall: ./hooks/install.sh   # sandboxed, no net, ro-fs except $EXT_DIR
    preUninstall: ./hooks/cleanup.sh
  permissions: [fs:read, fs:write:.forge, exec:git]
  checksum: sha256-...           # populated by forge.lock, ignored if present in source
```

---

## 2. SOURCE RESOLVERS — CLI → install path

| Command | Resolver | Install path |
|---|---|---|
| `forge add gh:obra/superpowers@v1.4.2` | GitHub release tarball | `.forge/extensions/obra/superpowers/` |
| `forge add npm:@acme/forge-stage-deploy` | npm registry (no install in node_modules; tarball-extract) | `.forge/extensions/@acme/forge-stage-deploy/` |
| `forge add ./local/my-stage` | symlink (dev) or copy (`--copy`) | `.forge/extensions/_local/my-stage/` |
| `forge add https://example.com/x.tgz` | raw tarball (requires `--allow-untrusted` unless checksum supplied) | `.forge/extensions/_url/<sha8>/` |
| `forge add gist:user/abc123` | GitHub gist single-file skill | `.forge/extensions/gist/<user>/<id>/` |

Resolver dispatch is prefix-based; the leading `<scheme>:` selects the resolver module under `lib/extensions/resolvers/<scheme>.js`. Each resolver returns `{tarballStream, sourceMeta}` and writes to a temp dir, runs `validateManifest()`, then atomically renames into `.forge/extensions/<author>/<name>/` (versioned subdir kept for rollback as `.forge/extensions/.cache/<author>-<name>-<ver>.tar`).

**Registration:** post-install, `forge` regenerates `.forge/registry.json` (a flat index of all skills/commands/stages contributed by every installed extension). The 7 agent dirs are re-synced via existing `scripts/sync-commands.js` so `.claude/commands/<author>/<cmd>.md`, `.codex/...` etc. all see the new content.

---

## 3. COLLISION RESOLUTION

Names live in **author-namespaced subtrees** on disk (`.claude/commands/obra/plan.md`) but resolve against a **flat command table** at agent-load time. When two extensions both contribute `/plan`, the registry surfaces them as `/obra:plan` and `/gsd:plan`; the bare `/plan` stays bound to Forge core (Layer 1) unless the user opts in via `forge alias /plan obra:plan` (writes to `.forge/aliases.yaml`, Layer 3). Stages collide similarly — a stage extension declaring `kind: stage` with `name: validate` registers as `validate@<author>` and only replaces the default when explicitly selected in `.forge/stages.yaml`. Detection runs at install time: `forge add` prints a collision report and exits non-zero unless `--force` or an alias is provided.

---

## 4. TRUST MODEL

**`forge.lock`** (top-level, committed):
```yaml
version: 1
extensions:
  obra/superpowers:
    version: 1.4.2
    source: gh:obra/superpowers
    resolved: https://github.com/obra/superpowers/archive/refs/tags/v1.4.2.tar.gz
    integrity: sha256-7f8e...c11a
    signature: minisign:RWS...      # optional
    installedAt: 2026-04-28T10:14:00Z
    installedBy: user@befach.com
```

**`.forge/audit.log`** (append-only NDJSON):
```
{"ts":"2026-04-28T10:14:00Z","action":"install","ext":"obra/superpowers","ver":"1.4.2","sha":"7f8e..","trust":"signed","actor":"user@befach.com"}
{"ts":"2026-04-28T11:02:11Z","action":"update","ext":"obra/superpowers","from":"1.4.2","to":"1.5.0","sha":"a91b..","trust":"checksum-only"}
{"ts":"2026-04-28T11:30:02Z","action":"remove","ext":"acme/foo","reason":"user"}
```

Verification chain: (1) checksum match against lock, (2) optional minisign/sigstore signature against `.forge/trusted-keys/`, (3) re-validate manifest schema, (4) hook scripts run only with `--allow-hooks` flag (default off; CI env var `FORGE_HOOKS=1`). `--allow-untrusted` skips signature but still records `trust:none` in the audit log; CI can fail on `trust!=signed`.

**Removal:** `forge remove obra/superpowers` runs `preUninstall` hook, deletes `.forge/extensions/obra/superpowers/`, removes corresponding `.claude/commands/obra/*` etc., updates lockfile, writes audit entry. User data under `.forge/data/<author>/<name>/` is preserved by default; `--purge` deletes it. `forge update <ext>` and `forge update --all` resolve newest satisfying semver, diff lockfile, prompt on major bumps.

---

## 5. CROSS-PROJECT CONSUMPTION (Forge as a producer)

Forge ships an npm package `@forge/extensions-sdk` exposing:
- `defineStage({ name, run, gates })`, `defineSkill()`, `defineGate()`, `defineCommand()`
- A `forge.json` export descriptor that the publishing project ships at the root of its tarball, mirroring `extension.yaml`.

Other projects publish: `npm publish` an npm package or tag a GitHub release containing `extension.yaml` + `package.json` with `"forge": { "extension": true }`. Forge core itself publishes its 7 default stages as `@forge/stage-plan`, `@forge/stage-dev`, etc., so a non-Forge project can `forge add npm:@forge/stage-plan` to consume just `/plan`. Minimum exportable surface: the SDK, JSON schema for `extension.yaml`, and the resolver protocol so third parties can host private resolvers (e.g., internal artifactory).

---

## 6. LIFECYCLE HOOKS (sandboxed)

`postInstall`, `preUninstall`, `enable`, `disable` — run via `child_process.spawn` with: cwd=`$EXT_DIR`, env scrubbed to `FORGE_EXT_DIR`/`FORGE_PROJECT_ROOT`/`FORGE_VERSION`, no network unless `permissions: [net]` declared, FS writes restricted to `$EXT_DIR` and `.forge/data/<author>/<name>/` via a Node `fs` wrapper (Linux: bwrap if available; Windows: chdir + path-prefix check). Hooks are off by default; opt in with `--allow-hooks` per-install or `forge config set hooks.allow true`.

---

## 7. OPEN QUESTIONS

1. **Layer-3 override semantics for extensions** — should a user's `patch.md` be able to override an extension's stage, or only Forge core's? (Affects whether extensions are themselves patchable.)
2. **Versioning of the manifest spec** — commit to `apiVersion: forge.dev/v1` now and require migrations later, or stay pre-1.0 with breaking changes allowed until extension count > 20?
3. **Registry/marketplace** — do we host a curated registry (`registry.forge.dev`) for discovery, or stay fully decentralized (gh:/npm: only) at v1?

---

## 8. PRIOR ART — what to copy

- **npm + package-lock.json** — copy lockfile shape, integrity SRI hashes, `dependencies`/`peerDependencies` semver ranges, `npm audit`-style trust signal.
- **Homebrew taps** — copy `user/repo` shorthand resolver and the "tap = arbitrary GitHub repo" model for zero-registry decentralized discovery.
- **mise / asdf plugins** — copy plugin-shim layout (`<author>/<name>/` under a single root) and the `plugin-update`/`plugin-remove` CLI surface.
- **VS Code extensions** — copy `package.json` `contributes` section concept (declarative capability registration: commands, views, settings) and the activation-event lazy-load model so big extensions don't pay startup cost.
- **k3d / kustomize / Argo CD plugins** — copy the layered overlay model for stage overrides and the "kind: Extension / apiVersion" Kubernetes-style manifest familiar to ops users.

---

## Implementation skeleton (where to put code)

| Concern | File |
|---|---|
| Resolver dispatch | `lib/extensions/resolve.js` |
| Per-scheme resolvers | `lib/extensions/resolvers/{gh,npm,local,url,gist}.js` |
| Manifest schema + validator | `lib/extensions/manifest-schema.js` (extends `plugin-manager.js` patterns) |
| Lockfile r/w | `lib/extensions/lockfile.js` |
| Audit log | `lib/extensions/audit.js` |
| CLI commands | `lib/commands/{add,remove,update}.js` (register in `lib/commands/_registry.js`) |
| Sync to agent dirs | extend `scripts/sync-commands.js` to walk namespaced subtrees |
| SDK for producers | `packages/extensions-sdk/` (separately publishable) |
