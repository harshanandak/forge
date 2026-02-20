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

## Scope Assessment

- **Classification**: Strategic (new feature, architecture change)
- **Complexity**: High (catalog + detection + recommendation + installation)
- **Timeline**: PR5.5 (1-2 days) + PR6 (4-5 days)
- **Risk**: Medium (additive, but touches setup flow)
- **Dependencies**: PR5.5 before PR6

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
