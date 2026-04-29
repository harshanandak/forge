# Forge Workflow: Dependency Chain Research

**Date**: 2026-02-23
**Branch**: feat/skills-restructure
**Objective**: Map every dependency the Forge workflow installs, how it installs them, what their own prerequisites are, and how the user is informed throughout.

---

## 1. What Forge Installs — Complete Map

### Quick Setup Flow (`bunx forge setup --quick`)

```
quickSetup()
 ├── checkPrerequisites()
 ├── Copy AGENTS.md
 ├── setupCoreDocs()
 ├── autoInstallLefthook()
 ├── autoSetupToolsInQuickMode()
 │    ├── autoSetupBeadsInQuickMode()
 │    ├── initializeOpenSpec() (only if already installed)
 │    └── initializeSkills() (only if already installed)
 ├── loadAndSetupClaudeCommands()
 ├── setupSelectedAgents()
 ├── installGitHooks()
 └── configureDefaultExternalServices()
```

### Every Tool — Install Method and Command

| Tool | Install Method | Command Used | Platform Branch |
|------|---------------|--------------|-----------------|
| **Lefthook** | npm/bun devDep | `bun add -d lefthook` | No |
| **Beads** | npm global | `npm install -g @beads/bd` | ⚠️ No Windows branch |
| **OpenSpec** | Skip if missing | `openspec init` only if found | No |
| **Skills** | Skip if missing | `skills init` only if found | No |
| **Git hooks** | via lefthook | `lefthook install` → hooks from lefthook.yml | No |
| **Context7 MCP** | npx at runtime | `npx -y @upstash/context7-mcp@latest` | Auto for Claude Code, Continue |
| **Grep.app MCP** | npx at runtime | `npx -y @ai-tools-all/grep_app_mcp` | Auto for Claude Code, Continue |
| **Agent config files** | File copy | Copies .claude/, .cursor/, .github/, etc. | Yes (path handling) |
| **AGENTS.md** | File copy | from package | No |
| **docs/WORKFLOW.md** | File copy | from package | No |

---

## 2. Dependencies of Each Tool

### Beads (`@beads/bd`)

- **Language**: Go binary (pre-compiled, ~114MB `.exe` on Windows)
- **Runtime deps**: None — self-contained binary
- **Install prerequisites**:

| Install Path | Prerequisites | Works on Windows? |
|-------------|--------------|-------------------|
| `npm install -g @beads/bd` | npm/bun | ⚠️ Broken — Issue #1031, closed "not planned" |
| `irm .../install.ps1 \| iex` | PowerShell 5+ | ✅ Recommended on Windows |
| `curl .../install.sh \| bash` | bash, curl | ❌ Needs Git Bash or WSL |
| `go install .../bd@latest` | Go 1.24+ | ✅ Works |
| `brew install beads` | Homebrew | macOS/Linux only |

- **Build-from-source deps** (only if no pre-compiled binary):
  - macOS: `icu4c`, `zstd`
  - Linux: `libicu-dev`, `libzstd-dev`
  - Windows: Go 1.24+ (no ICU required — uses pure Go regex backend)

- **What `bd init` creates**: `.beads/` directory with `issues.jsonl`, `metadata.json`, `config.yaml`, `README.md`, `.gitignore`

- **Critical gap**: forge.js uses `npm install -g @beads/bd` on ALL platforms including Windows, where this is broken. The PowerShell installer (`install.ps1`) is never called.

### OpenSpec (`@fission-ai/openspec`)

- **Language**: Node.js (pure JS/TS, not a compiled binary)
- **Runtime**: Node.js ≥ 20.19.0
- **Own dependencies** (transitive, pulled on install):
  - `@inquirer/core`, `@inquirer/prompts` — CLI prompts
  - `commander` — CLI argument parsing
  - `chalk` — terminal colors
  - `fast-glob` — file pattern matching
  - `ora` — **spinner** (ironically OpenSpec has a spinner, Forge doesn't)
  - `yaml` — YAML parsing
  - `zod` — schema validation
  - `posthog-node` — analytics (sends usage telemetry)
- **Install prerequisites**: Node.js 20+ only
- **Works on Windows**: ✅ Yes — pure Node.js
- **What `openspec init` creates**: `openspec/` directory with proposal templates
- **Forge behavior**: Only initialized if already installed. Never force-installed. If not on machine, silently skipped.

### Lefthook

- **Language**: Go binary (same distribution model as Beads)
- **Runtime deps**: None — zero dependencies
- **Own npm dependencies**: Uses `optionalDependencies` for platform-specific binaries:
  - `lefthook-darwin-arm64`, `lefthook-darwin-x64`
  - `lefthook-linux-arm64`, `lefthook-linux-x64`
  - `lefthook-win32-x64`, `lefthook-win32-arm64`
- **Install prerequisites**: npm/bun only (binary bundled in npm package)
- **Works on Windows**: ✅ Yes — ships Windows binary via npm optionalDependencies
- **What lefthook installs** (via lefthook.yml): 3 git hooks:
  - `commit-msg`: `bunx commitlint --edit {1}` — enforces conventional commits
  - `pre-commit`: `node .forge/hooks/check-tdd.js` — TDD enforcement
  - `pre-push`: branch protection + ESLint + test suite
- **Pre-push hooks use bash syntax** (`if [ $? -ne 0 ]`) — ⚠️ breaks on Windows without Git Bash
- **Transitive from hooks**: `commitlint` pulled via bunx at runtime (not pre-installed)

### GitHub CLI (`gh`)

- **Not installed by Forge** — must be pre-installed by user
- **Checked in**: `checkPrerequisites()` — fatal error if missing
- **Auth status**: checked as warning (not fatal)
- **Download**: https://cli.github.com
- **No version requirement specified** in forge.js

### MCP Servers (Context7, Grep.app)

- **Not pre-installed** — downloaded at runtime when agent first uses them
- **Mechanism**: `npx -y @upstash/context7-mcp@latest` — npx downloads and runs on demand
- **Prerequisites**: npx (comes with npm) or bunx
- **Context7 own deps**: Unknown — uses `@latest`, no version pinned
- **Grep.app own deps**: Unknown — no version pinned
- **Version pinning gap**: Both use `@latest` — breaking changes can silently break research workflow
- **Auto-configured for**: Claude Code (`.mcp.json`)
- **Manual setup required for**: Cursor, Cline

---

## 3. Transitive Dependencies (What Each Tool Pulls In)

```
Forge setup triggers:
│
├── npm install -g @beads/bd
│   └── Pre-compiled Go binary (no transitive npm deps)
│
├── bun add -d lefthook
│   └── lefthook-win32-x64 (or platform binary) via optionalDeps
│       └── No further deps
│
├── lefthook install (from lefthook.yml)
│   ├── commit-msg hook → bunx commitlint (runtime, not pre-installed)
│   │   └── @commitlint/cli + @commitlint/config-conventional (in devDeps ✓)
│   ├── pre-commit hook → node .forge/hooks/check-tdd.js (local file)
│   └── pre-push hook → bunx eslint (runtime)
│       └── eslint (in devDeps ✓)
│
├── npx @upstash/context7-mcp@latest (at agent runtime)
│   └── Unknown — @latest, not audited
│
└── npx @ai-tools-all/grep_app_mcp (at agent runtime)
    └── Unknown — no version pinned
```

**Key finding**: Beads and Lefthook have zero transitive npm dependencies (Go binaries). OpenSpec has ~8 transitive Node.js deps but all are benign utilities. The MCP servers are the unknown — they run as subprocesses with whatever deps they pull.

---

## 4. User-Facing Progress Reporting

### What the user currently sees

```
[ASCII Banner]
  Forge v1.6.0
  Quick Setup

Checking prerequisites...
  ✓ git version 2.x
  ✓ gh version 2.x
  ✓ node v22.x
  ✓ bun v1.x

  Created: AGENTS.md (universal standard)

📦 Installing lefthook for git hooks...
  ✓ Lefthook installed

📦 Installing Beads globally...
  ✓ Beads installed globally
📦 Initializing Beads...
  ✓ Beads initialized

[1/1] Setting up Claude Code...
  ✓ ...

Installing git hooks (TDD enforcement)...
  ✓ Lefthook hooks installed (local)

==============================================
  Forge v1.6.0 Quick Setup Complete!
==============================================

Next steps:
  1. Start with: /status
  2. Read the guide: docs/WORKFLOW.md
```

### What's MISSING from the UX

| Missing Element | Impact |
|----------------|--------|
| No spinner/progress bar | User can't tell if it's hung or working |
| No step counter in quick mode | "Step 3 of 6" would orient the user |
| No post-install verification | "Beads installed" ≠ `bd version` actually works |
| Silent skips for OpenSpec/Skills | User doesn't know they weren't installed |
| No total time estimate | Network-heavy steps (beads download) feel like hangs |
| No retry feedback | If npm fails, just says "run manually" with no context |
| No success summary with versions | Should show: `bd 0.49.1 ✓`, `lefthook 1.10.x ✓` |

### Interactive mode step counter (exists but only in agent setup)

```
[1/1] Setting up Claude Code...  ← This exists for agent files
```

But NOT for the tool installation steps (beads, openspec, lefthook).

---

## 5. Windows-Specific Gaps

### What forge.js does detect on Windows
- `process.platform === 'win32'` → uses `where.exe` instead of `which`
- CRLF handling (line 85): `.split(/\r?\n/)` on path resolution
- chmod skipped with warning (line 2886)

### What forge.js does NOT do on Windows
- Does NOT detect Windows and switch to `install.ps1` for beads
- Does NOT warn about bash-syntax lefthook hooks
- Does NOT check for Git Bash or WSL
- Does NOT offer PowerShell alternative for beads

### Windows failure sequence (current behavior)
```
1. forge.js runs npm install -g @beads/bd
2. npm postinstall runs PowerShell Expand-Archive
3. File locking error (EPERM) — bd.exe never lands
4. forge.js catches error, prints "Run manually: npm install -g @beads/bd && bd init"
5. User retries npm install → same EPERM → stuck in loop
6. pre-push hook runs bash syntax → fails on Windows CMD
7. User has lefthook installed but hooks don't fire correctly
```

### Correct Windows flow (not yet implemented)
```
1. Detect win32
2. Run: powershell -Command "irm https://.../install.ps1 | iex"
3. Verify: bd version
4. Run: bd init
5. For lefthook hooks: verify Git Bash is available, or use Node.js equivalents
```

---

## 6. Full Flow — Zero to Working

### macOS / Linux
```bash
# Prerequisites (manual)
# - git (https://git-scm.com)
# - gh (https://cli.github.com) + gh auth login
# - Node.js 20+ (https://nodejs.org)
# - bun (https://bun.sh)

# Install Forge (triggers postinstall → copies AGENTS.md baseline)
npx forge-workflow
# OR add to project:
bun add -d forge-workflow

# Full setup (single command)
bunx forge setup --quick

# Verify
bd version        # should show 0.49.x
lefthook version  # should show 1.10.x
bd ready          # should show open issues
```

### Windows (correct flow — not what forge currently does)
```powershell
# Prerequisites (manual)
# - Git for Windows (https://git-scm.com) — includes bash
# - gh CLI (https://cli.github.com) + gh auth login
# - Node.js 20+ (https://nodejs.org)
# - bun (https://bun.sh)

# Install beads FIRST (before forge setup) — npm is broken on Windows
irm https://raw.githubusercontent.com/steveyegge/beads/main/install.ps1 | iex

# Then install Forge
npx forge-workflow

# Full setup
bunx forge setup --quick

# Verify
bd version        # should work now (was pre-installed)
lefthook version  # should work (ships Windows binary via npm)
```

---

## 7. Key Gaps — Priority Order

| Priority | Gap | Fix |
|----------|-----|-----|
| P0 | Beads npm install broken on Windows | Detect win32, use install.ps1 |
| P0 | No post-install verification | Run `bd version` after install, fail loudly if not working |
| P1 | OpenSpec/Skills silently skipped | Show clear message: "OpenSpec not found — install with: ..." |
| P1 | lefthook.yml pre-push uses bash syntax | Replace `if [ $? -ne 0 ]` with cross-platform Node.js scripts |
| P1 | MCP servers use @latest | Pin versions: `@upstash/context7-mcp@1.x.x` |
| P2 | No spinner during installs | Add ora (already a dep of OpenSpec — ironic) |
| P2 | No step counter in quick mode | "Step 3/6: Installing Beads..." |
| P2 | No versions in success summary | Show installed versions at end |
| P3 | Go not mentioned as Windows fallback | Document: if install.ps1 fails → go install |
| P3 | OpenSpec telemetry (posthog-node) | Document/allow opt-out |
| P3 | GitHub integration not set up post-install | Add `bd config set github.org/repo` prompt |

---

## Sources

- [Beads Installation Docs](https://steveyegge.github.io/beads/getting-started/installation)
- [npm install broken on Windows #1031](https://github.com/steveyegge/beads/issues/1031) — closed "not planned"
- [OpenSpec GitHub](https://github.com/Fission-AI/OpenSpec)
- [OpenSpec package.json](https://github.com/Fission-AI/OpenSpec/blob/main/package.json)
- [Lefthook npm](https://www.npmjs.com/package/lefthook) — 0 dependencies, platform binaries via optionalDeps
- [Lefthook Installation Docs](https://lefthook.dev/installation/node.html)
- [Beads install.ps1](https://github.com/steveyegge/beads/blob/main/install.ps1)
