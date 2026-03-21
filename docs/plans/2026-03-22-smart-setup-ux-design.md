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

### 1. Agent Auto-Detection (D+ strategy)

**Three-tier detection with confidence levels:**

| Tier | Signal | Confidence | Examples |
|------|--------|------------|---------|
| 1. Env vars | High | `CLAUDE_CODE=1`, `CURSOR_SESSION_ID`, `TERM_PROGRAM=vscode` |
| 2. Config files | Medium | `.cursorrules`, `.claude/settings.json`, `.windsurfrules`, `codex.md` |
| 3. Directory presence | Low | `.claude/`, `.cursor/`, `.codex/`, `.cline/` |

**Behavior:**
- Tier 1 match: "Detected: Claude Code (env)" — pre-select, user confirms
- Tier 2 match: "Likely: Cursor (found .cursorrules)" — suggest, user confirms
- Tier 3 match: "Previously configured: Claude, Cursor" — list found, user picks
- No match: Standard selection prompt (current behavior)

**Phase 2 research goal:** Find additional env vars/signals for Windsurf, Cline, Roo, Kilocode, OpenCode. Check if any agents expose version info or IPC sockets.

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
