# Research: PR5.5 — Skills Restructure for skills.sh

**Date**: 2026-02-21
**Beads Issue**: TBD (create during /plan)
**Status**: Research complete, ready for `/plan`

---

## Objective

Restructure the existing monolithic `parallel-ai` skill into 4 focused skills and migrate all skills from `.claude/skills/` to `skills/` (repo root) for skills.sh compatibility. This unlocks PR7's ability to extract skills from the npm package and publish them via `npx skills add harshanandak/forge`.

**Why now**: PR6 recommends skills to users via `forge recommend`. Our own skills should be installable the same way third-party skills are. PR5.5 is the prerequisite that makes Forge "eat its own dogfood."

---

## Codebase Analysis

### Current Skills Structure

```
.claude/skills/
  parallel-ai/
    SKILL.md              (monolithic — covers all 4 APIs)
    api-reference.md      (endpoint docs for all 4 APIs)
    quick-reference.md    (troubleshooting + endpoints table)
    research-workflows.md (3 use-case examples)
    README.md
  sonarcloud/
    SKILL.md              (fork context skill with full API docs)
    reference.md          (comprehensive API reference)
```

### Problems with Current Structure

1. **Too monolithic**: `parallel-ai/SKILL.md` teaches all 4 Parallel AI APIs in one file. Agents load it in full, wasting context on irrelevant APIs.
2. **Wrong install location**: `.claude/skills/` is Claude Code–specific. `skills/` at repo root is the skills.sh standard and works with 20+ agents.
3. **Inconsistent naming**: `parallel-ai` doesn't map to a specific use case; `sonarcloud` is undiscoverable without knowing what SonarCloud is.
4. **No citation-standards rule**: Research quality suffers without a citation enforcement skill.

### Affected Files

| File | Action |
|------|--------|
| `.claude/skills/parallel-ai/SKILL.md` | Split into 4 new skills |
| `.claude/skills/parallel-ai/api-reference.md` | Split by API into skill references |
| `.claude/skills/parallel-ai/quick-reference.md` | Distribute to relevant skills |
| `.claude/skills/parallel-ai/research-workflows.md` | Move to parallel-deep-research |
| `.claude/skills/sonarcloud/SKILL.md` | Migrate to `skills/sonarcloud-analysis/` |
| `.claude/skills/sonarcloud/reference.md` | Migrate to `skills/sonarcloud-analysis/references/` |
| `lib/plugin-catalog.js` | Update install commands (2 entries) |
| `.claude/commands/research.md` | Update skill references |

---

## Critical Finding: Official Parallel Skills Repo Already Exists

**Source**: [github.com/parallel-web/parallel-agent-skills](https://github.com/parallel-web/parallel-agent-skills) | [github.com/parallel-web/parallel-cursor-plugin](https://github.com/parallel-web/parallel-cursor-plugin)

Parallel AI already publishes the exact 4 skills we planned to write ourselves:

| Skill | Official Name | Install |
|-------|--------------|---------|
| Web search | `parallel-web-search` | `npx skills add parallel-web/parallel-agent-skills --skill parallel-web-search` |
| URL extraction | `parallel-web-extract` | `npx skills add parallel-web/parallel-agent-skills --skill parallel-web-extract` |
| Deep research | `parallel-deep-research` | `npx skills add parallel-web/parallel-agent-skills --skill parallel-deep-research` |
| Data enrichment | `parallel-data-enrichment` | `npx skills add parallel-web/parallel-agent-skills --skill parallel-data-enrichment` |

**Key difference from our current skill**: The official skills use **`parallel-cli`** (a CLI tool), NOT direct REST API calls. The CLI is installed via:
```bash
curl -fsSL https://parallel.ai/install.sh | bash
# or: pipx install "parallel-web-tools[cli]"
parallel-cli login   # or: export PARALLEL_API_KEY="..."
```

Official SKILL.md frontmatter (confirmed from source):
```yaml
---
name: parallel-web-search
description: "DEFAULT for all research... Fast and cost-effective..."
context: fork
compatibility: Requires parallel-cli and internet access.
allowed-tools: Bash(parallel-cli:*)
metadata:
  author: parallel
---
```

Official skills use commands like:
```bash
parallel-cli search "$ARGUMENTS" -q "<keyword>" --json --max-results 10 -o "$FILENAME.json"
parallel-cli extract "$ARGUMENTS" --json
parallel-cli enrich run --data '[...]' --intent "..." --target "output.csv" --no-wait
```

**The `parallel-cursor-plugin` also has `citation-standards.mdc`** (a Cursor rule) with identical citation format guidance.

### Revised Scope: What PR5.5 Actually Does

**Old plan**: Write 4 custom parallel skills (REST API approach) + host in forge repo
**New plan**: Delete our REST API skill, point catalog to official `parallel-web/parallel-agent-skills`, host only forge-specific skills

**Why this is better**:
1. Users get the canonical, maintained version — parallel-cli is actively developed
2. We don't maintain a stale REST API skill while the official CLI evolves
3. Our `parallel-ai` skill has a fundamental mismatch — it documents the REST API but the official tool is `parallel-cli`
4. Less code, less maintenance, same outcome

---

## Web Research Findings

### skills.sh Format (2025/2026)

**Source**: [GitHub vercel-labs/skills](https://github.com/vercel-labs/skills) | [Mintlify blog](https://www.mintlify.com/blog/skill-md) | [skills.sh FAQ](https://skills.sh/docs/faq)

**Required frontmatter** (YAML):
```yaml
---
name: skill-name          # lowercase, hyphens, unique
description: "One sentence — what it does and when to use it"
---
```

**Optional frontmatter**:
```yaml
---
name: skill-name
description: "..."
metadata:
  internal: true          # Hide from public discovery
---
```

**Discovery locations** (CLI searches these in order):
1. `skills/<name>/SKILL.md` — **Primary** (standard)
2. `.claude/skills/<name>/SKILL.md` — Claude Code–specific (also discovered!)
3. Root-level `SKILL.md`

**Key insight**: `.claude/skills/` IS discovered by skills.sh CLI. We can keep backward compat by moving to `skills/` and adding redirecting or symlinks — or simply by migrating cleanly since Claude Code also discovers `skills/`.

**Install commands**:
```bash
npx skills add harshanandak/forge --skill parallel-web-search
npx skills add harshanandak/forge --skill parallel-deep-research
# etc.
```

**Multi-skill repos**: One GitHub repo can host multiple skills under `skills/` — each in its own subdirectory. This is ideal for forge: all skills ship in one repo, one `npx skills add harshanandak/forge` can install any/all.

---

## Architecture: Target State

### New `skills/` Directory Structure

```
skills/
  parallel-web-search/
    SKILL.md                    # Search API only
    references/
      api-reference.md          # Search + Extract endpoints
  parallel-web-extract/
    SKILL.md                    # Extract API only
  parallel-deep-research/
    SKILL.md                    # Task API (pro/ultra) + polling
    references/
      research-workflows.md     # Moved from parallel-ai/
  parallel-data-enrichment/
    SKILL.md                    # Task API (core/base) + schemas
  sonarcloud-analysis/
    SKILL.md                    # Migrated from .claude/skills/sonarcloud/
    references/
      api-reference.md          # Migrated from sonarcloud/reference.md
  citation-standards/
    SKILL.md                    # NEW: citation quality enforcement
```

### Skill Responsibility Map

| Skill | API | Use Case | Processor |
|-------|-----|----------|-----------|
| `parallel-web-search` | Search | Quick lookups, facts, news | N/A |
| `parallel-web-extract` | Extract | Scrape URLs, get pricing | N/A |
| `parallel-deep-research` | Task | Market analysis, reports | pro/ultra |
| `parallel-data-enrichment` | Task | Company data, structured output | core/base |
| `sonarcloud-analysis` | SonarCloud API | Code quality, security | N/A |
| `citation-standards` | — | Research citation quality | N/A (rule) |

### Plugin Catalog Updates

Two entries in `lib/plugin-catalog.js` need updating:

```js
// Before
'parallel-ai': {
  install: { method: 'skills', cmd: 'bunx skills add parallel-ai' },
}

// After — point to the primary/most-used skill
'parallel-web-search': {
  name: 'Parallel Web Search',
  install: { method: 'skills', cmd: 'bunx skills add harshanandak/forge --skill parallel-web-search' },
}
```

```js
// Before
sonarcloud: {
  install: { method: 'skills', cmd: 'bunx skills add sonarcloud' },
}

// After
'sonarcloud-analysis': {
  name: 'SonarCloud Analysis',
  install: { method: 'skills', cmd: 'bunx skills add harshanandak/forge --skill sonarcloud-analysis' },
}
```

---

## Key Decisions

### D1: Move to `skills/` at repo root (not stay in `.claude/skills/`)

**Decision**: Migrate to `skills/<name>/SKILL.md` at repo root, remove `.claude/skills/` entries.
**Reasoning**: `skills/` is the standard discovery location for skills.sh CLI and works across all 20+ agents. `.claude/skills/` only works for Claude Code. Both are discovered by the skills.sh CLI, but `skills/` signals intentional multi-agent publishing.
**Evidence**: vercel-labs/skills README shows `skills/<name>/SKILL.md` as canonical path. Mintlify blog confirms `skills/` as the primary location.
**Alternative considered**: Keep `.claude/skills/` and add `skills/` as symlinks → rejected (confusing, maintenance burden).

### D2: Split parallel-ai into 4 skills (not 2 or 3)

**Decision**: 4 separate skills matching the 4 Parallel AI API use cases.
**Reasoning**: Each API is genuinely different in speed, cost, use case. Agents should load only the relevant API knowledge. A "parallel-ai-search" + "parallel-ai-research" split (2) would still force irrelevant context on agents.
**Evidence**: PR6 research D6 specified 4 skills. Current `parallel-ai/SKILL.md` lines 1-94 confirm the 4 distinct APIs.
**Alternative considered**: Keep monolithic, just move location → rejected (agents over-load context from 4 APIs when they only need 1).

### D3: `parallel-data-enrichment` (not `parallel-task`)

**Decision**: Name the Task API skill `parallel-data-enrichment`, not `parallel-task`.
**Reasoning**: "Task" is an internal API concept. Users think in terms of use cases: "I need to enrich company data." The name surfaces the primary use case.
**Alternative considered**: `parallel-task` → rejected (internal jargon, unclear to agents deciding which skill to load).

### D4: `citation-standards` as a rule skill, not an API wrapper

**Decision**: New `citation-standards/SKILL.md` is a guidance skill (rules/standards), not an API wrapper.
**Reasoning**: Research quality suffers without explicit citation standards. This is a behavioral rule ("always cite sources in this format") not a tool wrapper. Skills can encode workflow rules, not just API docs.
**Evidence**: PR6 research D6 explicitly calls out citation-standards as a needed rule. Mintlify's skill.md blog confirms skills are for "best practices, capabilities, limitations" not just API docs.

### D5: Update catalog install commands to use full `harshanandak/forge` path

**Decision**: Catalog install commands use `bunx skills add harshanandak/forge --skill <name>` instead of `bunx skills add <name>`.
**Reasoning**: Skills are hosted in this repo, not published to a global registry. The `harshanandak/forge` qualifier points to the GitHub repo where skills.sh finds them.
**Evidence**: skills.sh CLI supports `npx skills add owner/repo --skill skill-name` syntax per GitHub README.
**Alternative considered**: Publish each skill as its own repo → rejected (unnecessary proliferation, all skills live naturally in the forge repo).

### D6: Keep `.claude/commands/` skill references consistent

**Decision**: Update `.claude/commands/research.md` to reference new skill names.
**Reasoning**: The research command invokes `parallel-ai` skill. After restructure, it should invoke `parallel-web-search` and `parallel-deep-research` by context.

---

## TDD Test Scenarios

### Test File: `test/skills-catalog.test.js`

```
1. skills/ directory exists at repo root
2. Each required skill directory exists (6 skills)
3. Each skill has a SKILL.md file
4. Each SKILL.md has valid frontmatter (name + description)
5. Skill names match directory names (kebab-case)
6. Descriptions are non-empty strings
7. parallel-web-search references Search API
8. parallel-web-extract references Extract API
9. parallel-deep-research references Task API with pro/ultra
10. parallel-data-enrichment references Task API with core/base
11. sonarcloud-analysis references SonarCloud API
12. citation-standards has citation format examples
13. Old .claude/skills/parallel-ai/ no longer exists (or redirects)
14. Old .claude/skills/sonarcloud/ no longer exists (or redirects)
15. Reference files exist where linked from SKILL.md
```

### Test File: `test/plugin-catalog.test.js` (updates)

```
16. parallel-ai entry replaced by parallel-web-search
17. sonarcloud entry updated to sonarcloud-analysis
18. Install commands use harshanandak/forge format
19. Catalog still has 30 tools (rename, not removal)
```

---

## Security Analysis (OWASP Top 10)

| Category | Risk | Status |
|----------|------|--------|
| A01 Broken Access Control | No auth/access changes | N/A |
| A02 Cryptographic Failures | No secrets in SKILL.md files | ✓ PASS — review each file for accidental key exposure |
| A03 Injection | No user input in skill files | N/A |
| A04 Insecure Design | N/A (doc restructure) | N/A |
| A05 Security Misconfiguration | PARALLEL_API_KEY guidance stays in skill docs | ✓ PASS |
| A06 Vulnerable Components | No dependency changes | N/A |
| A07 Auth Failures | N/A | N/A |
| A08 Integrity Failures | SKILL.md files in npm `files` — reviewed content | ✓ PASS |
| A09 Logging Failures | N/A | N/A |
| A10 SSRF | Parallel AI URLs hardcoded in examples — not user-controlled | ✓ PASS |

Key security review: Confirm no API keys or credentials leak into any SKILL.md or reference file (check existing files — none found during research).

---

## Scope Assessment

- Type: Tactical (file restructure + docs), no new runtime logic
- Complexity: Small (1-2 days)
- Parallelizable: No — sequential content split, single author
- Test count estimate: ~19 new tests
- Risk: Low — pure documentation/structure change, no behavior change
- Blocking: PR7 (needs skills published before extraction)

### What's NOT in PR5.5

| Feature | Why Deferred | When |
|---------|-------------|------|
| `npx skills add harshanandak/forge` validation | Requires actual publishing step (GitHub Actions or manual) | PR7 |
| Removing skills from npm `files` | Can't remove until skills.sh install path is proven | PR7 |
| AI-powered skill creation | Requires PR8 | PR8 |
| New skills beyond the 6 listed | Scope creep | PR8 |

---

## Implementation Checklist

### Step 1: Create `skills/` directory with 6 new SKILL.md files
- `skills/parallel-web-search/SKILL.md` — extract Search API content
- `skills/parallel-web-extract/SKILL.md` — extract Extract API content
- `skills/parallel-deep-research/SKILL.md` — extract Task (pro/ultra) content + polling
- `skills/parallel-data-enrichment/SKILL.md` — extract Task (core/base) + schema content
- `skills/sonarcloud-analysis/SKILL.md` — migrate from `.claude/skills/sonarcloud/SKILL.md`
- `skills/citation-standards/SKILL.md` — NEW

### Step 2: Move reference files
- `skills/parallel-web-search/references/api-reference.md`
- `skills/parallel-deep-research/references/research-workflows.md`
- `skills/sonarcloud-analysis/references/api-reference.md` (from sonarcloud/reference.md)

### Step 3: Remove old skill directories
- Delete `.claude/skills/parallel-ai/`
- Delete `.claude/skills/sonarcloud/`

### Step 4: Update catalog
- `lib/plugin-catalog.js`: rename `parallel-ai` → `parallel-web-search`, update cmd
- `lib/plugin-catalog.js`: update `sonarcloud` cmd to `harshanandak/forge --skill sonarcloud-analysis`

### Step 5: Update references
- `.claude/commands/research.md`: update skill name references
- `CLAUDE.md` or `AGENTS.md` if they reference skills by path

---

## Sources

- [GitHub vercel-labs/skills](https://github.com/vercel-labs/skills) — Official skills.sh CLI and format spec
- [Mintlify blog: skill.md open standard](https://www.mintlify.com/blog/skill-md) — SKILL.md as open standard
- [skills.sh FAQ](https://skills.sh/docs/faq) — Agent skills directory
- [npm: skills package](https://www.npmjs.com/package/skills) — CLI installation
- [add-skill.org](https://add-skill.org/) — Alternative skill installer reference
