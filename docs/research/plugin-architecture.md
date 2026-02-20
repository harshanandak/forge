# Research: PR6 — Plugin Architecture & Smart Recommendations

**Date**: 2026-02-20
**Beads Issue**: forge-a7n
**Status**: Research complete, ready for `/plan`

---

## Objective

Transform Forge into a **universal developer toolchain recommender** that detects a project's tech stack and recommends the right combination of CLI tools, skills, MCPs, LSPs, configs, and plugins — with pricing transparency and free alternatives for every paid tool.

---

## Ecosystem Analysis

### The 2026 Plugin Ecosystem

Three universal installation tools now exist:

| Tool | Installs | Command | Agents |
|------|----------|---------|--------|
| [npx skills add](https://skills.sh/) | Skills (SKILL.md) | `npx skills add owner/repo` | 18+ |
| [add-mcp](https://neon.com/blog/add-mcp) | MCP servers | `npx add-mcp owner/repo` | 9+ |
| [Claude Plugins](https://code.claude.com/docs/en/plugins) | Full bundles | `/plugin install` | Claude Code |

Two agent-specific marketplaces:

| Marketplace | Format | Launched |
|-------------|--------|----------|
| [Cursor Marketplace](https://cursor.com/marketplace) | `.cursor-plugin/plugin.json` | Feb 17, 2026 |
| Claude Plugin Marketplace | `.claude-plugin/plugin.json` | 2026 |

### skills.sh Format

Skills use SKILL.md with YAML frontmatter. No publish command — push to GitHub, auto-listed via install telemetry.

```yaml
---
name: my-skill
description: When and why to use this skill.
license: MIT
metadata:
  version: 1.0.0
allowed-tools:
  - bash
---
# Instructions...
```

Directory structure:
```
my-skill/
  SKILL.md              # Required
  scripts/              # Optional
  references/           # Optional
  assets/               # Optional
```

### Claude Code Plugin Format

```
my-plugin/
  .claude-plugin/plugin.json   # Manifest
  skills/                      # Agent skills (SKILL.md)
  commands/                    # Slash commands (.md)
  agents/                      # Custom agents
  hooks/hooks.json             # Event handlers
  .mcp.json                    # MCP configs
  .lsp.json                    # LSP configs
  settings.json                # Default settings
```

### Cursor Plugin Format

```
my-plugin/
  .cursor-plugin/plugin.json   # Manifest
  skills/                      # Agent skills
  rules/                       # Cursor rules (.mdc)
  mcp.json                     # MCP configs
```

---

## Design Principles

### P1: CLI-First, MCP-Fallback

Always prefer CLI tools over MCPs. CLIs work everywhere (all agents, CI/CD, scripts, terminals). MCPs require agent support and protocol overhead.

**Preference order:**
1. CLI tool (universal, scriptable)
2. Skill (portable knowledge, works across agents)
3. Config file (zero runtime, declarative)
4. MCP server (only for live bidirectional agent interaction)

**MCP is justified only when:**
- No CLI equivalent exists (Figma, Context7)
- Live agent interaction genuinely adds value (database exploration mid-chat)
- The tool is inherently interactive (design files, live debugging)

| Service | CLI (Prefer) | MCP (Fallback) | MCP Justified? |
|---------|-------------|----------------|----------------|
| GitHub | `gh` | github-mcp-server | No |
| SonarQube | `sonar-scanner` | sonarqube-mcp-server | Yes (query mid-chat) |
| CodeQL | `codeql` | codeql-mcp | No |
| Snyk | `snyk` | N/A | N/A |
| Stripe | `stripe` | stripe-mcp | Partial (API exploration) |
| Parallel AI | `parallel-cli` | N/A | N/A |
| Vercel | `vercel` | vercel-mcp | No |
| Supabase | `supabase` | supabase-mcp | Yes (live DB queries) |
| Neon | `neonctl` | neon-mcp | Yes (live DB queries) |
| ESLint | `eslint` | N/A | N/A |
| Biome | `biome` | N/A | N/A |
| Playwright | `playwright` | N/A | N/A |
| Context7 | N/A | context7-mcp | Yes (no CLI) |
| Figma | N/A | figma-mcp | Yes (no CLI) |

### P2: Pricing Transparency

Every recommended tool gets a tier classification:

| Tier | Icon | Meaning |
|------|------|---------|
| F | Free | Fully free, open source, no limits |
| FP | Free-Public | Free for open-source repos, paid for private |
| FL | Free-Limited | Free tier with usage caps |
| P | Paid | Requires subscription |

For every paid tool, Forge shows:
- What it costs
- The free alternative
- What you lose with the free version

### P3: Budget Modes

| Mode | Installs | Best For |
|------|----------|----------|
| **Free only** | Only F-tier tools | Solo devs, hobby projects |
| **Open source** | F + FP (free for public) | Open-source projects |
| **Startup** | F + FP + FL (free tiers) | Small teams on free plans |
| **Professional** | All recommended | Teams with budget |
| **Custom** | User picks individually | Full control |

### P4: Tech Stack Detection First

Detect before recommending. Expand `lib/project-discovery.js` to detect:

| Category | Current | Expanded |
|----------|---------|----------|
| Frameworks | React, Next.js, Vue, Express | + Angular, Svelte, Astro, Remix, Nuxt, Fastify, NestJS |
| Languages | TypeScript, JavaScript | + Python, Go, Rust, Java, Ruby |
| Databases | None | Convex, Supabase, Neon, Prisma, Drizzle, MongoDB, PostgreSQL |
| Auth | None | Clerk, Auth.js, Supabase Auth, Firebase Auth |
| Payments | None | Stripe, Paddle, LemonSqueezy |
| CI/CD | GitHub Actions, GitLab | + CircleCI, Vercel |
| Code Quality | ESLint | + Biome, Oxlint, SonarCloud, CodeQL |
| LSPs | None | TypeScript, Python, Rust, Go, Java |
| Testing | node:test | + Vitest, Jest, Playwright, Cypress |

---

## Complete Tool Catalog

### By Workflow Stage

#### Stages 1-2: `/status` + `/research`

| Tool | Type | Tier | Free Alternative |
|------|------|------|-----------------|
| `parallel-cli` | CLI | P | Built-in WebSearch |
| Context7 | MCP | F | — |
| grep.app | MCP | F | — |
| Perplexity | MCP | FL ($20/mo) | WebSearch + Context7 |
| Firecrawl | MCP | FL ($19/mo) | Built-in WebFetch |

#### Stage 3: `/plan`

| Tool | Type | Tier | Free Alternative |
|------|------|------|-----------------|
| Beads | CLI | F | — |
| OpenSpec | CLI | F | — |
| Linear | CLI (`linear`) | FL | Beads (free) |
| Jira | CLI (`jira`) | P | Beads (free) |

#### Stage 4: `/dev`

**LSP Servers (all free):**

| LSP | Detect When | Install |
|-----|------------|---------|
| TypeScript LS | `typescript` in deps | `.lsp.json` |
| Pyright | `*.py` files | `.lsp.json` |
| rust-analyzer | `Cargo.toml` | `.lsp.json` |
| gopls | `go.mod` | `.lsp.json` |

**Framework Skills:**

| Skill | Tier | Detect When |
|-------|------|------------|
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (React) | F | `react` in deps |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | F | `remotion` in deps |
| Convex best practices | F | `convex` in deps |
| Rails conventions | F | `Gemfile` |

**Service CLIs:**

| CLI | Tier | Detect When | MCP Fallback |
|-----|------|------------|-------------|
| `supabase` | FL | `@supabase/supabase-js` | supabase-mcp (live queries) |
| `neonctl` | FL | `@neondatabase/serverless` | neon-mcp (live queries) |
| `stripe` | F (CLI free) | `stripe` in deps | stripe-mcp (API explore) |
| `vercel` | FL | `vercel.json` or Next.js | No |
| `clerk` | FL | `@clerk/nextjs` | clerk-mcp |
| `convex` | FL | `convex` in deps | No |

#### Stage 5: `/check`

**Linting & Formatting (all free):**

| Tool | Detect When | Notes |
|------|------------|-------|
| `eslint` | `eslint.config.js` | Standard, huge plugin ecosystem |
| `biome` | `biome.json` | 10-25x faster, lint+format in one |
| `oxlint` + `oxfmt` | User preference | 50x faster, Rust-based |
| `prettier` | `.prettierrc` | Formatting only |

**Security Scanning:**

| Tool | Type | Tier | Detect When | Free Alternative |
|------|------|------|------------|-----------------|
| `eslint` + eslint-plugin-security | CLI+Config | F | Node.js project | — |
| eslint-plugin-sdl | Config | F | Enterprise | — |
| `npm audit` | CLI | F | Any npm project | — |
| `codeql` | CLI | FP | GitHub repo | eslint-plugin-security |
| `sonar-scanner` | CLI | FP | SonarCloud config | SonarQube Community (free, self-host) |
| `snyk` | CLI | FL (200/mo) | Snyk config | npm audit + CodeQL |
| `semgrep` | CLI | F (OSS rules) | Any project | — |

**Type Checking (all free):**

| Tool | Detect When |
|------|------------|
| `tsc` | `tsconfig.json` |
| `pyright` | Python project |
| `mypy` | `mypy.ini` |

**Testing & Coverage (all free):**

| Tool | Detect When |
|------|------------|
| `node:test` | Node.js project (built-in) |
| `vitest` | `vite.config.*` |
| `jest` | `jest.config.*` |
| `playwright` | Web app project |
| `c8` | Node.js + coverage needed |
| `stryker` | Advanced testing setup |

#### Stages 6-7: `/ship` + `/review`

| Tool | Type | Tier | Detect When | Free Alternative |
|------|------|------|------------|-----------------|
| `gh` | CLI | F | GitHub repo | — |
| `sonar-scanner` (PR analysis) | CLI | FP | SonarCloud config | SonarQube Community |
| CodeRabbit | Config | FP | GitHub integration | Qodo Merge (free, self-host) |
| Greptile | Config | P ($30/mo) | GitHub integration | CodeRabbit (free for public) |
| [Qodo Merge](https://github.com/Codium-ai/pr-agent) | CLI | F | Self-hosted | — |
| Vercel Deploy skill | Skill | FL | Vercel project | `vercel` CLI |

#### Stages 8-9: `/merge` + `/verify`

| Tool | Type | Tier | Detect When |
|------|------|------|------------|
| `gh pr merge` | CLI | F | GitHub repo |
| Changesets | CLI | F | npm package / monorepo |
| release-please | Config | F | GitHub repo |
| Lefthook | CLI | F | Git hooks needed |

---

## Key Decisions & Reasoning

### D1: CLI-first, MCP as enhancement only

**Decision**: Prefer CLI tools over MCPs in all recommendations
**Reasoning**: CLIs work in every agent (18+), every CI/CD pipeline, and every terminal. MCPs require agent-specific support and add protocol overhead. CLIs are also easier to debug and script.
**Evidence**: `gh` CLI covers 100% of GitHub MCP functionality. `sonar-scanner` CLI covers 90% of SonarQube MCP. Most MCPs are thin wrappers around CLIs anyway.

### D2: Pricing tiers with mandatory free alternatives

**Decision**: Every paid tool recommendation must show a free alternative
**Reasoning**: Forge targets individual devs through enterprise teams. Cost should never block adoption. Users should make informed choices, not discover surprise bills.
**Trade-off**: More complex recommendation UI, but dramatically better user trust.

### D3: Budget modes for quick setup

**Decision**: Offer 5 preset budget modes (Free/OpenSource/Startup/Professional/Custom)
**Reasoning**: Most users know their budget constraint upfront. Presets avoid 20+ individual toggle decisions during setup.

### D4: Expand project-discovery.js detection

**Decision**: Detect 20+ frameworks, databases, auth, payments, CI/CD, LSPs
**Reasoning**: The recommendation engine is only as good as its detection. Current detection (4 frameworks, 2 languages) is too narrow for a universal recommender.
**Implementation**: File-presence and dependency-based detection (same pattern as current `detectFramework()`).

### D5: Absorb forge-mlm into PR6

**Decision**: Close forge-mlm beads issue, fold unique features into PR6
**Reasoning**: skills.sh (`npx skills add`) and add-mcp (`npx add-mcp`) already handle installation. forge-mlm's custom registry client, publish, and search commands are redundant. Only unique features (sync, validate, AI creation) survive — sync and validate go to PR6, AI creation to PR8.

### D6: Publish our skills to skills.sh in PR5.5

**Decision**: Restructure parallel-ai (split into 4) and sonarcloud skills for skills.sh before PR6
**Reasoning**: PR6 will recommend third-party skills for installation. Our own skills should be in the same format and installable the same way. PR5.5 is a lightweight prerequisite.

### D7: Plugin catalog as data, not code

**Decision**: Store the tech-stack-to-tool mapping as a JSON/JS data structure, not hardcoded logic
**Reasoning**: Makes it easy to add new tools, update pricing, and community-contribute mappings without touching recommendation logic.

---

## Architecture

### PR5.5: Skills Restructure (1-2 days)

Restructure existing `.claude/skills/` for skills.sh compatibility:

```
Before:                          After:
.claude/skills/                  skills/ (repo root, skills.sh format)
  parallel-ai/                     parallel-web-search/
    SKILL.md (monolithic)            SKILL.md
    api-reference.md                 references/api-reference.md
    quick-reference.md             parallel-web-extract/
    research-workflows.md            SKILL.md
  sonarcloud/                      parallel-deep-research/
    SKILL.md                         SKILL.md
    reference.md                     references/research-workflows.md
                                   parallel-data-enrichment/
                                     SKILL.md
                                   sonarcloud-analysis/
                                     SKILL.md
                                     references/reference.md
                                   citation-standards/  (rule)
                                     SKILL.md
```

All skills use `parallel-cli` as primary method (fallback to curl).

### PR6: Plugin Architecture (4-5 days)

```
lib/
  plugin-catalog.js         # Tool database (JSON mapping)
  plugin-recommender.js     # Detection → recommendation logic
  plugin-installer.js       # Orchestrate installs
  project-discovery.js      # EXPANDED: 20+ detections

bin/forge.js
  forge setup               # ENHANCED: recommendation UI
  forge recommend           # NEW: standalone recommendation
  forge install <tool>      # NEW: install specific tool
```

**Catalog structure:**
```javascript
{
  tools: {
    "eslint-plugin-security": {
      type: "config",
      tier: "free",
      detectWhen: [{ dep: "express" }, { dep: "fastify" }, { file: "package.json" }],
      install: "npm install -D eslint-plugin-security",
      stage: "check",
      category: "security",
      alternatives: []
    },
    "sonar-scanner": {
      type: "cli",
      tier: "free-public",
      detectWhen: [{ file: "sonar-project.properties" }],
      install: "npm install -D sonarqube-scanner",
      stage: "check",
      category: "security",
      paidDetails: { price: "EUR 30/mo", threshold: "100K LoC private" },
      alternatives: [
        { tool: "sonarqube-community", tier: "free", tradeoff: "Self-hosted, 19 languages" },
        { tool: "eslint-plugin-security", tier: "free", tradeoff: "Catches ~60% of issues" }
      ]
    }
  }
}
```

---

## TDD Test Scenarios

### Plugin Catalog Tests (`test/plugin-catalog.test.js`)

1. Every tool has required fields (type, tier, detectWhen, install, stage)
2. Every paid tool has at least one free alternative
3. Every MCP-type tool has CLI preference documented
4. Tier values are valid (free, free-public, free-limited, paid)
5. No duplicate tool entries
6. Categories cover all 9 workflow stages

### Detection Tests (`test/plugin-detection.test.js`)

1. Detects React from `react` in dependencies
2. Detects Supabase from `@supabase/supabase-js` in dependencies
3. Detects Stripe from `stripe` in dependencies
4. Detects TypeScript LSP need from `tsconfig.json`
5. Detects Biome from `biome.json` presence
6. Returns empty for unrecognized stack
7. Priority: CLI detection over MCP for same service

### Recommendation Tests (`test/plugin-recommender.test.js`)

1. Free-only mode excludes all paid and freemium tools
2. Open-source mode includes free-public but not free-limited
3. Professional mode includes everything
4. Custom mode respects individual toggles
5. Recommendations include alternatives for every paid tool
6. CLI tools are recommended before MCPs for same service
7. Detected LSPs appear in recommendations

### Installation Tests (`test/plugin-installer.test.js`)

1. `npx skills add` called for skill-type tools
2. `npx add-mcp` called for MCP-type tools (when justified)
3. npm install called for config-type tools
4. `.lsp.json` updated for LSP-type tools
5. Installation respects budget mode filter
6. Failed installations don't block other installs

---

## Implementation Risk Analysis

### R1: npm Package Extraction — Breaking Existing Users

**Risk**: Removing `.claude/skills/` from the `files` array means users who `npm update` will lose bundled skills.

**Severity**: MEDIUM

**Analysis**:
- npm replaces the entire package on update — skills files vanish from `node_modules/`
- The `setupClaudeAgent()` function (bin/forge.js:1916) copies from `packageDir` paths — if skills aren't there, copy silently fails
- The `postinstall` script (`node ./bin/forge.js`) runs `minimalInstall()` which doesn't reference skills
- Skills are referenced in `.claude/commands/research.md` as recommended tools (soft reference, not hard dependency)

**Mitigation**:
1. Add `fs.existsSync()` guards before copying skills from packageDir
2. Show migration notice during setup: "Skills are now installed separately via `npx skills add`"
3. Don't remove skills from `files` in PR6 — **defer to PR7** after skills.sh publishing is validated

**Decision**: **Defer skill extraction to PR7.** PR6 adds the catalog + recommendation engine. PR7 publishes skills to skills.sh and removes them from the npm package. This avoids a breaking change before the alternative install path is proven.

### R2: Cross-Platform Prerequisite Checking

**Risk**: `execFileSync` with `go version`, `gh --version`, `jq --version` behaves differently across platforms.

**Severity**: MEDIUM

**Analysis**:
- Windows: `execFileSync('go', ['version'])` works for `.exe` but NOT for `.cmd`/`.bat` wrappers (some npm-installed CLIs use these)
- Windows: `where.exe` returns multiple lines; must take first line only
- macOS (Apple Silicon): Homebrew at `/opt/homebrew/bin/` may not be in non-interactive shell PATH
- `jq --version` outputs `jq-1.7.1` (non-standard format with prefix)
- `go version` output includes platform info: `go version go1.22.0 windows/amd64`

**Mitigation**:
1. Use the existing `secureExecFileSync()` pattern (bin/forge.js:71-94) which already resolves via `where.exe`/`which`
2. For version checks, only check command exists (exit code 0), don't parse version strings
3. Wrap all checks in try/catch, return structured `{ met: [], missing: [] }`
4. Add platform-conditional tests with `test.skip` for Windows-specific behavior

### R3: Installation Orchestration Pitfalls

**Risk**: Real-world installs can fail in many ways — timeouts, prompts, permissions, partial state.

**Severity**: HIGH

**Analysis**:
- `npx` may prompt "Need to install the following packages... Ok to proceed?" — blocks in non-interactive mode
- `go install` requires GOPATH/GOBIN on PATH — installed binary may not be found after install
- Global npm installs (`npm install -g`) need root/admin on some systems
- Network failures leave partial installation state with no rollback
- `PKG_MANAGER` global (bin/forge.js:62) defaults to `'npm'` if `checkPrerequisites()` hasn't run

**Mitigation**:
1. Always use `--yes` flag with npx: `npx --yes skills add owner/repo`
2. Add 60s timeout for npm installs, 120s for `go install`, 30s for version checks
3. Track per-tool results: `{ installed: [], failed: [], skipped: [], prerequisitesMissing: [] }`
4. Never abort batch on single failure — continue installing remaining tools
5. Detect package manager before any install (don't rely on global state)

**Decision**: **Defer actual installation orchestration to PR6.5 or PR7.** PR6 focuses on `forge recommend` (read-only, zero side effects). Installation via `forge install` comes later after recommendation output is validated with real projects.

### R4: Catalog Scope — 90+ Tools Is Too Ambitious

**Risk**: 90+ tool entries means 90+ data assertions, 90+ detection rules, massive maintenance burden.

**Severity**: HIGH

**Analysis**:
- Tool versions, pricing, URLs, and free alternatives change frequently
- Each tool's `detectWhen` rules need testing — combinatorial explosion of project types
- Review burden: a 500+ line data file is hard to review in one PR
- Many tools will never be detected because they serve niche stacks

**Decision**: **Start with 30-35 core tools in PR6.** Expand to 90+ in PR8. Core tools cover:
- The most common JS/TS stacks (React, Next.js, Vue, Angular, Express, NestJS)
- Essential code quality (ESLint, Biome, Prettier)
- Security scanning (npm audit, eslint-plugin-security, SonarCloud)
- Testing (node:test, Vitest, Jest, Playwright)
- Forge workflow tools (Beads, OpenSpec, Skills CLI, gh, lefthook)
- Skills: parallel-ai, sonarcloud, vercel-agent-skills
- MCPs: Context7 (justified — no CLI equivalent)

### R5: Setup Flow Integration Conflicts

**Risk**: Adding `forge recommend` to the setup flow may conflict with existing tools installation.

**Severity**: MEDIUM

**Analysis**:
- Current setup flow: `checkPrerequisites()` → agent selection → `setupProjectTools()` (Beads, OpenSpec, Skills) → complete
- `checkPrerequisites()` calls `process.exit(1)` on failure — `forge recommend` must NOT depend on this
- `setupProjectTools()` at bin/forge.js:3370 already handles Skills CLI installation
- If `forge recommend` also suggests Skills CLI, user gets asked twice

**Integration approach**:
1. `forge recommend` is a **standalone command** — works without setup, never calls `process.exit()`
2. `forge setup` OPTIONALLY shows recommendations AFTER current tool setup completes
3. Recommendations come after `setupProjectTools()`, framed as "Additional tools for your stack"
4. No conflict with existing Skills CLI prompt — recommendations suggest individual skills (e.g., `npx skills add vercel-labs/agent-skills`), not the Skills CLI itself

### R6: `bin/forge.js` Size Concerns

**Risk**: bin/forge.js is already 4,407 lines. Adding more logic makes it harder to maintain.

**Severity**: LOW

**Analysis**: New commands (`recommend`, `install`) will be thin dispatchers in `main()`, delegating to `lib/plugin-recommender.js` and `lib/plugin-installer.js`. This follows the existing pattern (commands delegate to lib/ modules).

**Mitigation**: Each new command is ~10-15 lines in `main()`. All logic lives in lib/ modules.

---

## Setup Flow Architecture

### Current Flow (bin/forge.js)

```
main() [line 3944]
  ├─ parseFlags()
  ├─ handlePathSetup() (if --path)
  └─ if command === 'setup':
      ├─ quickSetup()                    [if --quick]
      ├─ handleSetupCommand()            [if agents specified]
      └─ interactiveSetupWithFlags()     [interactive mode]
            ├─ checkPrerequisites()      [line 351] → git, gh, node, pkg manager
            ├─ setupAgentsMdFile()       [AGENTS.md]
            ├─ setupCoreDocs()           [docs/ARCHITECTURE.md, etc.]
            ├─ loadAndSetupClaudeCommands() [.claude/commands/*.md]
            ├─ setupSelectedAgents()     [agent-specific configs]
            └─ displaySetupSummary()
```

### Project Tools Sub-Flow

```
setupProjectTools() [line 3370]
  ├─ promptBeadsSetup()      [line 3105] → check/install/init @beads/bd
  ├─ promptOpenSpecSetup()   [line 3199] → check/install/init openspec
  └─ promptSkillsSetup()     [line 3317] → check/install/init @forge/skills
```

### New Flow (PR6 additions)

```
main() [line 3944]
  ├─ ... existing commands ...
  ├─ if command === 'recommend':
  │     └─ handleRecommend(flags)        [NEW — standalone, no setup required]
  │           ├─ detectTechStack()       [lib/project-discovery.js — expanded]
  │           ├─ recommend()             [lib/plugin-recommender.js]
  │           └─ displayRecommendations()
  └─ if command === 'setup':
        └─ interactiveSetupWithFlags()
              ├─ ... existing flow ...
              └─ showRecommendations()   [NEW — optional, after tool setup]
                    ├─ detectTechStack()
                    ├─ recommend()
                    └─ "Run 'forge recommend' for more details"
```

### Key Design Decisions

1. **`forge recommend` is read-only** — no installations, no side effects, safe to run anytime
2. **`forge setup` shows brief recommendations** — teaser after existing tool setup
3. **`forge install <tool>` deferred** — comes in PR7 after recommendation output is validated
4. **Never calls `process.exit()`** — `forge recommend` always succeeds (even with empty results)
5. **Detects package manager independently** — doesn't rely on global `PKG_MANAGER` state

### Example Output: `forge recommend`

```
$ forge recommend --budget startup

Detected stack: Next.js + TypeScript + Supabase + Stripe

Recommended tools for your project:

  RESEARCH
  ✓ Context7 MCP          [F]  Live library docs       npx add-mcp context7
  ✓ parallel-ai skill     [F]  Web research            npx skills add parallel-ai

  DEV
  ✓ TypeScript LSP         [F]  Type checking           .lsp.json
  ✓ Supabase CLI           [FL] Local dev, migrations   npm install -D supabase
  ✓ Stripe CLI             [F]  Webhook testing         brew install stripe/stripe-cli/stripe

  CHECK
  ✓ ESLint                 [F]  Linting                 npm install -D eslint
  ✓ eslint-plugin-security [F]  Security rules          npm install -D eslint-plugin-security
  ✓ SonarCloud skill       [FP] Quality gate            npx skills add sonarcloud

  SHIP
  ✓ gh CLI                 [F]  PR workflow             https://cli.github.com
  ✓ Lefthook               [F]  Git hooks               npm install -D lefthook

  Skipped (budget: startup):
  ✗ Greptile              [P]  $30/mo  → Free alt: CodeRabbit (free for public repos)
  ✗ Snyk                  [P]  $25/mo  → Free alt: npm audit + eslint-plugin-security

[F]=Free  [FP]=Free-Public  [FL]=Free-Limited  [P]=Paid

Run 'forge install <tool>' to install individually.
Run 'forge install --all' to install all recommended tools.
```

---

## PR Deferral Strategy

### PR6 Scope (This PR) — Catalog + Recommendations

| Component | Action | Why in PR6 |
|-----------|--------|-----------|
| `lib/plugin-catalog.js` | CREATE | Core data structure, no side effects |
| `lib/plugin-recommender.js` | CREATE | Read-only engine, no side effects |
| `lib/project-discovery.js` | EDIT (additive) | Expanded detection powers recommendations |
| `bin/forge.js` | EDIT | Add `recommend` command (thin dispatcher) |
| `test/plugin-catalog.test.js` | CREATE | Data validation tests |
| `test/plugin-detection.test.js` | CREATE | Detection accuracy tests |
| `test/plugin-recommender.test.js` | CREATE | Recommendation logic tests |
| `test/plugin-recommend.test.js` | CREATE | CLI command tests |

**Risk**: LOW — all read-only, no installations, no file mutations, no side effects

### PR7 Scope (Deferred) — Installation + Skill Extraction

| Component | Action | Why deferred |
|-----------|--------|-------------|
| `lib/plugin-installer.js` | CREATE | Side effects (runs npm/go/npx), needs real-world validation |
| Prerequisite checking | Part of installer | Cross-platform complexity needs careful testing |
| `forge install` command | CREATE | Depends on installer being battle-tested |
| Skill extraction from npm `files` | EDIT package.json | Breaking change — needs migration path proven first |
| Skills publish to skills.sh | External | Must publish before removing from npm |
| `test/plugin-installer.test.js` | CREATE | Complex mocking for 7 install methods |
| `test/plugin-setup-integration.test.js` | CREATE | E2E integration with setup flow |

**Risk**: MEDIUM-HIGH — file mutations, subprocess execution, cross-platform issues

### PR8 Scope (Future) — Catalog Expansion

| Component | Action | Why deferred |
|-----------|--------|-------------|
| Expand catalog to 90+ tools | EDIT catalog | Needs community feedback on core 30 |
| Language-specific LSPs | EDIT catalog | Niche, low priority |
| AI tool creation (from forge-mlm) | CREATE | Separate feature, different user flow |

---

## Security Analysis (OWASP Top 10)

### A03: Injection — Command Injection via Tool Names

**Risk**: HIGH
**Applicable**: Yes — `plugin-installer.js` will pass user-influenced data to `execFileSync`
**Mitigation**:
- Use `execFileSync` with array args (never string concatenation)
- Validate tool IDs against catalog (whitelist only)
- Catalog entries are frozen objects — can't be modified at runtime
- All install commands come from catalog data, never user input
**Tests**: Verify tool IDs are validated, reject arbitrary input

### A05: Security Misconfiguration — Installing Untrusted Packages

**Risk**: MEDIUM
**Applicable**: Yes — `npx skills add` and `npm install` fetch from registries
**Mitigation**:
- Only install packages listed in the frozen catalog
- Show exact package name and source before install
- Never auto-install without user confirmation
- `--dry-run` flag shows what would be installed
**Tests**: Verify frozen catalog can't be modified, dry-run produces no side effects

### A06: Vulnerable Components — Recommending Outdated Tools

**Risk**: LOW
**Applicable**: Yes — catalog may recommend tools with known CVEs
**Mitigation**:
- Catalog is a static data file — easy to audit and update
- `npm audit` already runs as part of `/check`
- SonarCloud detects vulnerable dependencies
**Tests**: Existing CI/CD checks catch vulnerable dependencies

### A08: Software and Data Integrity — Catalog Tampering

**Risk**: LOW
**Applicable**: Yes — if catalog is modified, wrong tools could be recommended
**Mitigation**:
- `Object.freeze()` on catalog object — can't be modified at runtime
- Catalog is in lib/ (part of npm package) — protected by npm integrity checks
- Tests validate catalog structure on every CI run
**Tests**: Verify catalog is frozen, verify all entries pass schema validation

### Other OWASP categories (A01, A02, A04, A07, A09, A10)

**Not applicable** — PR6 is read-only (no auth, no data storage, no network requests, no user accounts). Installation in PR7 will need re-evaluation for A03 and A08.

---

## Scope Assessment

- **Classification**: Strategic (new feature, architecture change)
- **Complexity**: Medium (reduced scope — catalog + recommendation only)
- **PR split**: PR6 (catalog + recommend) → PR7 (installer + extraction) → PR8 (expansion)
- **Risk**: LOW for PR6 (read-only), MEDIUM for PR7 (side effects)
- **Dependencies**: None for PR6 (PR5.5 deferred — skills stay bundled for now)

---

## Sources

- [skills.sh — Agent Skills Directory](https://skills.sh/)
- [Vercel — Agent Skills Guide](https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context)
- [Claude Code — Create Plugins](https://code.claude.com/docs/en/plugins)
- [Cursor Plugin Spec](https://github.com/cursor/plugins)
- [Cursor Marketplace Launch](https://www.adwaitx.com/cursor-marketplace-plugins/)
- [add-mcp — Universal MCP Installer](https://neon.com/blog/add-mcp)
- [Vercel Agent Skills Repo](https://github.com/vercel-labs/agent-skills)
- [parallel-cursor-plugin](https://github.com/parallel-web/parallel-cursor-plugin)
- [SonarQube MCP Server](https://www.sonarsource.com/products/sonarqube/mcp-server/)
- [CodeQL MCP Server](https://github.com/JordyZomer/codeql-mcp)
- [Ultracite — Unified Linting](https://github.com/haydenbleasel/ultracite)
- [eslint-plugin-security](https://github.com/eslint-community/eslint-plugin-security)
- [Microsoft eslint-plugin-sdl](https://github.com/microsoft/eslint-plugin-sdl)
- [SonarCloud Pricing](https://www.sonarsource.com/plans-and-pricing/)
- [GitHub Advanced Security Pricing](https://github.com/pricing)
- [CodeRabbit Pricing](https://coderabbit.ai/pricing)
- [Greptile vs CodeRabbit](https://www.greptile.com/greptile-vs-coderabbit)
- [Qodo Merge — Free AI Code Review](https://github.com/Codium-ai/pr-agent)
- [awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit)
- [Biome Migration Guide](https://pockit.tools/blog/biome-eslint-prettier-migration-guide/)
- [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices)
