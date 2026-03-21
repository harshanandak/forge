# Smart Setup UX — Design Doc

- **Feature**: smart-setup-ux
- **Epic**: forge-iv8b
- **Date**: 2026-03-22
- **Status**: Draft
- **Classification**: Standard (6-stage workflow)

---

## Purpose

Forge setup currently creates all files for all agents upfront, produces verbose file-by-file output, can't detect which agent is running, overwrites existing config on re-run, and ships a duplicate `docs/WORKFLOW.md`. This epic makes setup intelligent: minimal noise, agent-aware, incremental, and lazy.

## Success Criteria

1. `bunx forge setup` detects the current AI agent automatically (env vars > config files > directory presence)
2. Running setup a second time to add a new agent does NOT overwrite existing agent config
3. `docs/plans/` and `docs/research/` are created on first use (by `/plan`), not at setup time
4. Setup summary is one clear message by default; `--verbose` shows file-by-file detail
5. `docs/WORKFLOW.md` is removed; all 50+ references point to `AGENTS.md`
6. Existing worktree is detected before `/plan` tries to create a new one

## Out of Scope

- Multi-agent simultaneous setup in one command (setup one agent at a time)
- Agent-specific command translation (e.g., Claude `/plan` vs Cursor equivalent)
- Removing or refactoring `bin/forge.js` into `lib/` modules (tracked separately: forge-0ht2)
- Changes to the `/plan` command file itself (worktree detection is in setup/runtime code)
- Composite `check()/run()` step structure refactor (deferred: forge-9m47 under forge-0ht2)
- `--pretend` dry-run flag (depends on composite step structure, deferred with forge-9m47)

## Additional Scope (from Phase 2 research)

- Content-hash comparison for file skip logic (users re-run setup frequently across agents)
- `--force` CLI flag (overwrite all without prompts, needed for CI)
- Centralized action log array (required for Option C progressive output)
- Fix `detectProjectStatus()` feature gate (mandatory when WORKFLOW.md is removed)

## Approach Selected

**All 5 child issues in one PR** — they share the same code surface (`bin/forge.js` setup flow). Splitting would mean refactoring the same functions multiple times.

**Implementation order** (foundation first, polish last):
1. Remove `docs/WORKFLOW.md` + clean all references (reduces code surface)
2. Lazy directory creation (remove eager `mkdirSync` calls)
3. Auto-detect agent (add detection logic before agent selection prompt)
4. Incremental agent setup with smart tiered strategy
5. Clean summary output (progressive: minimal default, `--verbose` for detail)

## Constraints

- `bin/forge.js` is ~3000 lines — changes must be surgical, not a rewrite
- `sync-commands.js` must be run after any command file edits
- All 7 agent directories must stay in sync (Claude, Cursor, Cline, Codex, OpenCode, Roo, Kilocode)
- Lefthook pre-push hooks enforce ESLint `--max-warnings 0` and full test pass
- No breaking changes to existing `bunx forge setup` behavior for first-time users

## Design Decisions

### 1. Agent Auto-Detection (4-layer strategy)

**Prior art:** `@vercel/detect-agent` v1.2.1 (5M+ npm downloads, Apache-2.0). Covers 12 agents via env vars. We extend with config file + VSCode path parsing layers.

**Full research:** [2026-03-22-agent-detection-research.md](2026-03-22-agent-detection-research.md)

**Four detection layers (fast to slow):**

| Layer | Signal | Confidence | What it tells you |
|-------|--------|------------|-------------------|
| 1. `AI_AGENT` env var | High | Universal standard (proposed by Vercel) — any agent can self-identify |
| 2. Agent-specific env vars | High | `CLAUDECODE`/`CLAUDE_CODE`, `CURSOR_TRACE_ID`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE_CLIENT`, `AUGMENT_AGENT`, `COPILOT_MODEL` |
| 3. VSCode path parsing | Medium | `VSCODE_CODE_CACHE_PATH` contains editor name (Cursor, Windsurf, Code) — distinguishes VSCode forks |
| 4. Config file signatures | Medium-Low | `.cursorrules`, `.claude/settings.json`, `.windsurfrules`, `.clinerules`, `.roo/rules/` — detects *configured* agents, not necessarily *running* |

**Agents with NO env vars (config-file-only):** Cline, Roo Code, Kilocode, Windsurf (when not detectable via VSCODE_CODE_CACHE_PATH)

**Behavior:**
- Layer 1-2 match: "Detected: Claude Code (env)" — pre-select, user confirms
- Layer 3 match: "Detected editor: Cursor (vscode path)" — suggest, user confirms
- Layer 4 match: "Previously configured: Claude, Cursor" — list found, user picks
- No match: Standard selection prompt (current behavior)

**Implementation choice:** Reimplement the `@vercel/detect-agent` pattern inline (zero new dependencies) rather than adding a dep. The detection map is ~50 lines and we need the config file layer anyway.

### 2. Incremental Setup (Smart Tiered Strategy — Option D)

| File type | Strategy |
|-----------|----------|
| New files (don't exist) | Create silently |
| Agent-specific files (`.cursorrules`, `.claude/settings.json`) | Skip if exists, warn user |
| Shared files with markers (`AGENTS.md`) | Replace between `<!-- forge:<agent>-start -->` / `<!-- forge:<agent>-end -->` markers (idempotent) |
| Shared files without markers (user-customized) | Show diff, ask for approval |
| JSON/config files (`.mcp.json`) | Key-based merge — add missing keys, preserve existing |

**Marker pattern example in AGENTS.md:**
```markdown
<!-- forge:cursor-start -->
## Cursor-specific instructions
...
<!-- forge:cursor-end -->
```

Re-running setup replaces content between markers. Content outside markers is never touched.

### 3. Clean Summary Output (Progressive — Option C)

**Default output:**
```
Forge setup complete — 2 agents configured (Claude Code, Cursor)
  Run forge setup --verbose to see all files
  Run forge setup --diff to review conflicts
```

**With `--verbose`:**
```
Claude Code: .claude/settings.json, .claude/commands/ (3 files)
Cursor: .cursorrules, .cursor/rules/ (2 files)
Skipped: CLAUDE.md (unchanged)
Merged: .mcp.json (added 1 key)
```

### 4. Lazy Directory Creation

| Directory | When created | Message (first use only) |
|-----------|-------------|--------------------------|
| `docs/plans/` | `/plan` Phase 1 (design doc save) | "Created docs/plans/ for design documents" |
| `docs/research/` | `/plan` Phase 2 (research save) | "Created docs/research/ for research notes" |

No permission prompt. Silent creation + purpose note. Matches industry standard (Next.js, Vite, Cargo all create silently).

### 5. Worktree Detection

Before creating a worktree in `/plan` entry gate, check:
```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

If non-empty, we're already inside a worktree — skip creation, announce which worktree/branch we're in.

### 6. WORKFLOW.md Removal

- Delete `docs/WORKFLOW.md`
- Update all 50+ references across codebase to point to `AGENTS.md`
- Remove file copy logic from `bin/forge.js` and `install.sh`
- Update test assertions in `test/stage-naming.test.js`

## Edge Cases

| Scenario | Handling |
|----------|---------|
| User runs setup with no agent detectable | Fall through to manual selection prompt (current behavior) |
| User runs setup twice for same agent | Skip all files (idempotent), show "already configured" |
| `.mcp.json` has user-added custom servers | Key-merge preserves them, only adds forge defaults |
| `AGENTS.md` has user edits outside markers | Preserved — only content between markers is replaced |
| User deletes marker comments manually | Falls back to diff-and-prompt for that file |
| Worktree exists but branch was deleted | Detect via `git worktree list`, warn user to clean up |
| `docs/WORKFLOW.md` referenced in user's custom docs | Grep won't catch files outside repo — user's responsibility |

## Ambiguity Policy

**>= 80% confidence:** Agent makes conservative choice, documents in decisions log.
**< 80% confidence:** Stop and ask user.

Specific to this epic: if an env var detection is ambiguous (e.g., `TERM_PROGRAM=vscode` could mean Cursor or plain VSCode), default to the less specific match and let the user confirm.

---

## Technical Research

### Codebase Findings

**Key code locations in `bin/forge.js`:**
- `copyFile` helper: line 514 (reuse for all file operations)
- `ensureDir('docs/planning')`: line 1784 (NOTE: actual dir is `docs/planning/`, not `docs/plans/`)
- `ensureDir('docs/research')`: line 1785
- WORKFLOW.md copy: line 1789 (`copyFile(workflowSrc, 'docs/WORKFLOW.md')`)
- `hasDocsWorkflow` check: line 781 (`fs.existsSync(...)`)
- Status output refs: lines 2053, 3475 (`if (projectStatus.hasDocsWorkflow) console.log(...)`)
- Agent selection: interactive prompt in setup flow (no auto-detection today)

**Existing patterns to reuse:**
- `lib/context-merge.js` uses `USER:START` / `USER:END` markers for preserving user sections — same pattern applies for agent-specific markers
- `copyFile` already handles `ensureDir` for parent directories
- No existing agent detection logic in `bin/forge.js` — greenfield

**Blast radius for WORKFLOW.md removal (50+ references):**
- `bin/forge.js`: 8 refs (copy, status check, output messages)
- `lib/agents-config.js`: 3 refs (agent config templates)
- `install.sh`: 3 refs (curl download, file list, output)
- Agent command files (rollback, premerge) x 7 agents: ~28 refs
- `README.md`, `QUICKSTART.md`, `DEVELOPMENT.md`: 6 refs
- `docs/SETUP.md`, `docs/EXAMPLES.md`, etc.: 5 refs
- `AGENTS.md`: 1 ref (doc index)
- `.cursorrules`: 2 refs (dir tree, reference)
- `test/stage-naming.test.js`: 1 ref (test assertion)

### DRY Check

- No existing agent detection logic — new code needed
- Marker pattern exists in `context-merge.js` but for USER sections — agent markers are a new use case, same pattern
- No existing merge/skip logic for setup re-runs — all new

### OWASP Top 10 Analysis

| # | Risk | Applies? | Mitigation |
|---|------|----------|------------|
| A01 | Broken Access Control | No | Local CLI, no auth |
| A02 | Cryptographic Failures | No | No secrets in setup |
| A03 | Injection | Low | Sanitize marker content, never eval user strings or env var values |
| A04 | Insecure Design | Low | Smart tiered strategy prevents silent overwrites |
| A05 | Security Misconfiguration | Low | Review generated configs for safe defaults |
| A06 | Vulnerable Components | No | No new dependencies |
| A07 | Auth Failures | No | No authentication |
| A08 | Software/Data Integrity | Low | Env vars read-only, never executed |
| A09 | Logging/Monitoring | No | CLI tool |
| A10 | SSRF | No | No network requests |

### TDD Test Scenarios

1. **Happy path — first-time setup**: No existing files -> all created, clean summary
2. **Agent auto-detection (env var)**: `CLAUDE_CODE=1` -> detected high confidence
3. **Agent auto-detection (config file)**: `.cursorrules` exists -> detected medium confidence
4. **Agent auto-detection (directory)**: `.claude/` exists -> detected low confidence
5. **Agent auto-detection (ambiguous)**: `TERM_PROGRAM=vscode` without cursor-specific vars -> not auto-selected
6. **Incremental re-run same agent**: Second setup skips existing, shows "already configured"
7. **Add second agent**: Claude then Cursor -> Claude untouched, Cursor added, shared files merged
8. **Marker idempotency**: Setup 3x -> marker sections not duplicated
9. **Missing markers (user-edited)**: Markers removed -> falls back to diff-and-prompt
10. **Lazy dir creation**: Fresh project, `/plan` -> `docs/planning/` created with purpose note
11. **Worktree detection**: Inside existing worktree -> detected, no nested creation
12. **WORKFLOW.md removal**: After setup, file gone, all refs point to AGENTS.md
13. **JSON config merge**: `.mcp.json` with user servers -> forge keys added, user keys kept
14. **Corrupted config**: Invalid JSON in `.mcp.json` -> warn, skip merge, don't crash
15. **Progressive output**: Default shows summary; `--verbose` shows file list
