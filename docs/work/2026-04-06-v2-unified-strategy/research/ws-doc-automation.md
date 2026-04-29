# Research: Doc Automation for Ship Agent

**Date**: 2026-04-06
**Researcher**: Claude AI

## Objective

Design a system where scripts detect WHAT docs need updating after a feature is implemented, and the agent intelligently performs the updates. Currently, doc updates during `/premerge` are manual and often forgotten.

## 1. How Existing Tools Detect Stale Docs

### Changelog Generation Tools

| Tool | Approach | Stars | Forge Fit |
|------|----------|-------|-----------|
| **semantic-release** (23.5k) | Fully automated: parses conventional commits on CI, generates changelog, bumps version, publishes. No human in the loop. | High automation but opinionated -- owns the entire release pipeline. |
| **release-please** (6.7k) | Google's approach: creates a "Release PR" with changelog + version bump based on conventional commits. Human merges to release. | Good model -- PR-based review before release. |
| **changesets** (11.6k) | Intent-based: developers write changeset files (`npx changeset`) describing what changed. Consumed at release time. Monorepo-focused. | Interesting intent model but adds developer ceremony. |
| **conventional-changelog** (8.4k) | Library that parses conventional commits into changelog entries. Powers semantic-release and release-please under the hood. | Direct dependency candidate for `forge docs detect`. |

**Key insight**: All tools parse `feat:`, `fix:`, `docs:` prefixes from conventional commits. Forge already enforces conventional commits via `@commitlint/config-conventional`. This is the foundation.

### Doc Staleness Detection

| Tool | How It Detects |
|------|---------------|
| **Mintlify** | Broken link detection, redirect management, CI checks for dead links. Does NOT detect semantic staleness (doc describes old behavior). |
| **ReadMe.io** | API spec diffing -- compares OpenAPI spec versions. Flags endpoints that changed but docs didn't. Code-to-doc, not general purpose. |
| **TypeDoc / JSDoc** | Generates API docs from code comments. Staleness = code changed but JSDoc didn't. Only covers API surface. |

**Key insight**: No tool detects "README section X references function Y that was renamed." This is where agent intelligence fills the gap.

### Keep a Changelog Principles (already adopted by Forge)

Forge's `CHANGELOG.md` already follows Keep a Changelog 1.1.0:
- Categories: Added, Changed, Fixed, Removed, Deprecated, Security
- `[Unreleased]` section for pending changes
- Human-readable, not git-log dumps

## 2. Scripts and Tools That Can Assist

### What Scripts Can Do (cheap, deterministic)

1. **Parse git diff for affected files** -- `git diff base..HEAD --name-only`
2. **Map file changes to doc categories**:
   - `src/` or `lib/` changed + `feat:` commits --> CHANGELOG, README likely stale
   - `bin/forge.js` changed --> CLI help text, README usage section
   - `.claude/commands/*.md` changed --> AGENTS.md command table
   - `package.json` version changed --> README badges, install instructions
   - `docs/plans/*-design.md` created --> design doc index
   - `lefthook.yml` or `.github/workflows/` changed --> TOOLCHAIN.md, SETUP.md
3. **Check for broken internal references**:
   - Grep docs for function/file names that no longer exist in source
   - Grep for old version strings after `package.json` bump
4. **Validate doc completeness**:
   - CHANGELOG has `[Unreleased]` entry for every `feat:` / `fix:` commit
   - README features list matches actual CLI commands
   - AGENTS.md command table matches `.claude/commands/*.md` files

### What the Agent Should Do (contextual, creative)

1. **Write changelog entries** with meaningful descriptions (not just commit subjects)
2. **Update README sections** with correct examples, new flags, changed behavior
3. **Update CLAUDE.md USER section** with discovered patterns
4. **Cross-reference design docs** to implementation reality

## 3. Proposed System Design

### Architecture: Script Detects, Agent Updates, Script Verifies

```
forge docs detect  -->  JSON report  -->  Agent reads report  -->  Agent updates docs
                                                                        |
                                                                        v
                                                              forge docs verify
```

### `forge docs detect` (Script)

**Input**: git diff between feature branch and base branch
**Output**: JSON report to stdout

```json
{
  "branch": "feat/auth-refresh",
  "base": "master",
  "commits": [
    { "type": "feat", "scope": "auth", "subject": "add refresh token rotation", "sha": "abc123" },
    { "type": "fix", "scope": "auth", "subject": "handle expired token edge case", "sha": "def456" }
  ],
  "docs": {
    "CHANGELOG.md": {
      "status": "needs-update",
      "reason": "2 feat/fix commits with no [Unreleased] entry",
      "suggested_categories": ["Added", "Fixed"]
    },
    "README.md": {
      "status": "needs-review",
      "reason": "src/auth/ changed, README has 'Authentication' section",
      "sections": ["## Authentication", "## Configuration"]
    },
    "AGENTS.md": {
      "status": "ok",
      "reason": "no command/workflow changes detected"
    },
    "docs/TOOLCHAIN.md": {
      "status": "ok",
      "reason": "no tooling changes"
    },
    "CLAUDE.md": {
      "status": "needs-review",
      "reason": "new pattern discovered: token rotation retry logic"
    }
  },
  "stale_references": [
    { "file": "docs/SETUP.md", "line": 42, "reference": "handleAuth()", "actual": "handleAuthRefresh()" }
  ],
  "version": {
    "current": "0.0.8",
    "suggested": "0.0.9",
    "reason": "feat commits present, minor bump"
  }
}
```

**Implementation approach**:
- Parse `git log --format` for conventional commit data
- Run `git diff --name-only` to get changed files
- Build a mapping of source dirs to doc files (configurable in `.forge/docs-map.json`)
- Grep doc files for references to changed function/file names
- Check CHANGELOG for missing entries

### `forge docs verify` (Script)

**Input**: none (reads current state)
**Output**: pass/fail checklist

```
forge docs verify
  [PASS] CHANGELOG.md has [Unreleased] entries for all feat/fix commits
  [PASS] README.md features list matches CLI commands
  [FAIL] AGENTS.md command table missing: forge issue
  [PASS] No broken internal doc references
  [PASS] package.json version consistent with docs
  [WARN] docs/plans/2026-04-03-*.md references handleAuth() -- renamed to handleAuthRefresh()
```

**This becomes a gate in `/premerge`** -- the agent cannot proceed until `forge docs verify` passes.

### `.forge/docs-map.json` (Configuration)

Maps source directories to documentation files:

```json
{
  "mappings": [
    { "source": "bin/forge.js", "docs": ["README.md#usage", "docs/SETUP.md"] },
    { "source": "lib/", "docs": ["README.md", "CHANGELOG.md"] },
    { "source": ".claude/commands/", "docs": ["AGENTS.md#workflow-commands"] },
    { "source": "lefthook.yml", "docs": ["docs/TOOLCHAIN.md", "CLAUDE.md"] },
    { "source": "scripts/", "docs": ["docs/TOOLCHAIN.md"] },
    { "source": ".github/workflows/", "docs": ["docs/TOOLCHAIN.md", "CLAUDE.md"] },
    { "source": "package.json", "docs": ["README.md#installation"] }
  ],
  "required_sections": {
    "CHANGELOG.md": ["[Unreleased]"],
    "README.md": ["## Installation", "## Usage", "## Features"],
    "AGENTS.md": ["## Workflow Commands"]
  }
}
```

### Integration into `/premerge` Workflow

Current `/premerge` Step 3 is a manual checklist. Replace with:

```
Step 3a: forge docs detect  -->  agent reads JSON report
Step 3b: agent updates each flagged doc
Step 3c: forge docs verify  -->  must pass before continuing
```

## 4. Document Naming and Organization

### Current State

| Directory | Naming Pattern | Issue |
|-----------|---------------|-------|
| `docs/plans/` | `YYYY-MM-DD-<slug>-{design,tasks,decisions}.md` | 90+ files, hard to find by topic. No origin/type indicator. |
| `docs/research/` | `<topic>.md` | No date prefix, no connection to plans that consumed the research. |

### Proposed Improvements

#### A. Add origin prefix to plan filenames

Current: `2026-03-22-multi-dev-awareness-design.md`
Proposed: `2026-03-22-feat-multi-dev-awareness-design.md`

Prefix matches commit type: `feat-`, `fix-`, `refactor-`, `chore-`.

#### B. Link research docs to plans

Add frontmatter to research docs:

```yaml
---
date: 2026-04-06
origin: ws-doc-automation
consumed_by: docs/plans/2026-04-07-feat-doc-automation-design.md
status: complete | active | superseded
---
```

#### C. Add a plan index (auto-generated)

`forge docs index` generates `docs/plans/INDEX.md`:

```markdown
| Date | Type | Slug | Status | Design | Tasks | Decisions |
|------|------|------|--------|--------|-------|-----------|
| 2026-04-03 | feat | setup-hardening | shipped | [link] | [link] | - |
| 2026-03-28 | feat | dx-improvements | shipped | [link] | [link] | [link] |
```

Status derived from: tasks file exists + all tasks checked = shipped.

#### D. How other projects organize docs

| Project | Pattern | Notes |
|---------|---------|-------|
| **Rust RFCs** | `text/0001-feature-name.md` | Sequential numbering, permanent. |
| **React RFCs** | `text/0000-template.md` | PR-based, discussed before merge. |
| **Kubernetes KEPs** | `keps/sig-*/1234-feature/` | Directory per proposal, includes PRR (production readiness). |
| **ADRs (adr-tools)** | `docs/adr/0001-record-decisions.md` | Sequential, status in frontmatter (proposed/accepted/deprecated). |

**Recommendation for Forge**: Keep date-prefix (avoids renumbering conflicts in parallel PRs). Add type prefix. Add frontmatter with status.

## 5. Learning From Git History

### Can the agent learn doc update patterns from history?

Yes, with a script:

```bash
# Find commits that touched both source and docs
git log --all --oneline --diff-filter=M -- '*.md' |
  while read sha msg; do
    git diff-tree --no-commit-id --name-only -r $sha |
      grep -q 'src/\|lib/\|bin/' && echo "$sha $msg"
  done
```

This reveals which doc files were updated alongside which source changes, building an empirical docs-map.

### Should there be a docs skill?

Yes. A `/docs` skill that:
1. Runs `forge docs detect` to get the JSON report
2. Iterates flagged docs with contextual awareness
3. Runs `forge docs verify` as exit gate
4. Knows project conventions: Keep a Changelog format, CLAUDE.md USER markers, AGENTS.md table format

This skill would be invoked by `/premerge` Step 3, replacing the current manual checklist.

## 6. Implementation Recommendations

### Phase 1: Detection Script (low effort, high value)

Build `scripts/docs-detect.js`:
- Parse conventional commits from git log
- Map changed files to doc targets via `.forge/docs-map.json`
- Check CHANGELOG for missing entries
- Output JSON report

**Effort**: ~200 lines of JS, 1-2 tasks.

### Phase 2: Verification Script (low effort, high value)

Build `scripts/docs-verify.js`:
- Validate required sections exist
- Check for broken internal references (grep for renamed functions)
- Verify CHANGELOG completeness
- Exit code 0/1 for gate use

**Effort**: ~150 lines of JS, 1-2 tasks.

### Phase 3: Premerge Integration (medium effort)

- Wire `forge docs detect` into `/premerge` command
- Create `/docs` skill that reads detection output
- Add `forge docs verify` as hard gate before Step 4 (sync beads)

### Phase 4: Doc Organization (low effort)

- Add frontmatter to research template
- Update `/plan` to use type-prefixed filenames
- Create `forge docs index` command (auto-generates INDEX.md)

### Tools NOT Recommended for Forge

| Tool | Why Not |
|------|---------|
| **semantic-release** | Owns the entire release pipeline. Forge has manual version bumps (`chore: bump to vX.Y.Z`). Conflict. |
| **changesets** | Adds ceremony (write changeset file per PR). Forge agents already write conventional commits. Redundant. |
| **TypeDoc/JSDoc** | Forge is JS not TS, and API docs are not the primary doc concern. |
| **Mintlify/ReadMe.io** | SaaS platforms for external docs. Forge docs are in-repo markdown. |

### Tools Worth Adopting

| Tool | Why |
|------|-----|
| **conventional-changelog-parser** | NPM package to parse commit messages. Use inside `docs-detect.js`. |
| **release-please model** | Not the tool itself, but the pattern: PR-based changelog review before release. Forge's `/premerge` already does this. |
| **Keep a Changelog format** | Already adopted. Formalize with verification script. |

## Key Decisions

### Decision 1: Scripts for Detection, Agent for Writing
- **Decision**: Build `forge docs detect` + `forge docs verify` as deterministic scripts. Agent consumes their output.
- **Reasoning**: Scripts are fast and token-free. Agent adds contextual intelligence only where needed.
- **Trade-off**: Requires maintaining a docs-map config file.

### Decision 2: No External Changelog Tool
- **Decision**: Custom `docs-detect.js` using `conventional-changelog-parser` for commit parsing.
- **Reasoning**: semantic-release and changesets are opinionated about the release pipeline. Forge needs detection only.
- **Trade-off**: More custom code, but fits Forge's workflow exactly.

### Decision 3: Keep Date-Prefix Naming
- **Decision**: Keep `YYYY-MM-DD-` prefix, add type prefix after date.
- **Reasoning**: Date prefix avoids numbering conflicts in parallel worktrees. Type prefix aids filtering.
- **Alternative rejected**: Sequential numbering (ADR-style) -- conflicts in parallel branches.

### Decision 4: Docs Skill in /premerge
- **Decision**: Create a `/docs` skill invoked by `/premerge` Step 3.
- **Reasoning**: Encapsulates doc conventions, reusable across different features.

## Risk Assessment

- **Low risk**: Detection script is read-only, cannot break anything
- **Medium risk**: Agent doc updates could introduce errors -- mitigated by `forge docs verify` gate
- **Low risk**: Doc-map config maintenance -- starts simple, grows with project

## Next Steps

1. Create Beads issue for doc automation implementation
2. Proceed to `/plan` with Phase 1-2 as initial scope
3. Defer Phase 3-4 until scripts are proven
