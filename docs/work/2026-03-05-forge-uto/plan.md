# Design Doc: forge-uto — Agent Config Cleanup + Codex CLI

- **Feature**: forge-uto
- **Date**: 2026-03-05
- **Status**: approved
- **Beads**: forge-uto

---

## Purpose

Reduce maintenance surface and improve correctness of the forge setup CLI:

1. `CLAUDE.md` currently duplicates `AGENTS.md` content — make it a symlink so Claude Code reads the single source of truth
2. Google Antigravity is no longer a supported agent — remove all traces to avoid misleading users
3. Aider requires complex, non-universal setup — drop plugin and setup logic
4. OpenSpec is no longer part of the forge workflow — remove from setup CLI entirely
5. Codex CLI is a supported agent that lacks a plugin — add it
6. OpenCode plugin exists but has issues — fix it
7. Stage listing in `bin/forge.js` says 9-stage (with `/research`) — update to current 7-stage

---

## Success Criteria

- `CLAUDE.md` is a symlink pointing to `AGENTS.md` at repo root
- `GEMINI.md` is deleted; no Antigravity references remain in `.clinerules`, `.windsurfrules`, `docs/SETUP.md`, `lib/agents/`
- `lib/agents/aider.plugin.json` is deleted; `setupAiderAgent()` and `customSetup === 'aider'` branch are removed from `bin/forge.js`
- `promptOpenSpecSetup()`, `checkForOpenSpec()`, `initializeOpenSpec()`, `isOpenSpecInitialized()` are removed from `bin/forge.js`; all call sites removed
- `openspecInstallType` field removed from project status object
- Stage listing in `bin/forge.js` updated from 9-stage to 7-stage (remove `/research` row and references)
- `lib/agents/codex.plugin.json` exists with correct directories for AGENTS.md + `.codex/config.toml`
- OpenCode plugin is verified correct and any issues fixed
- `bun test` passes (0 failures)

---

## Out of Scope

- Adding any new agents beyond Codex
- Changing the content of `AGENTS.md`
- Modifying the workflow stage commands themselves
- Migrating existing user projects that have Antigravity or Aider set up

---

## Approach Selected

**Direct surgical edits** to `bin/forge.js` + plugin files. No abstraction changes.

- CLAUDE.md symlink: created by `bin/forge.js` setup (not pre-committed to repo, since it's generated per-project). The existing setup already handles CLAUDE.md creation — change the logic to create a symlink to AGENTS.md instead of copying content.
- Removals: delete plugin JSONs, remove function definitions and all call sites
- Codex plugin: new `lib/agents/codex.plugin.json` following existing plugin schema

---

## Constraints

- `bin/forge.js` has strict ESLint with `--max-warnings 0` — no unused vars after removal
- Unused parameters must be prefixed with `_`
- Pre-push hooks run full test suite — all tests must pass before push

---

## Edge Cases

- **Symlink on Windows**: `fs.symlinkSync` requires Developer Mode or admin on Windows. The setup CLI should catch `EPERM` and fall back to a redirect stub with a clear warning message.
- **Existing CLAUDE.md**: If a project already has a CLAUDE.md with custom content, the setup should detect it and ask before overwriting with a symlink (current merge/keep logic already handles this).
- **OpenSpec references in status display**: Lines 2486–2491 in `bin/forge.js` display OpenSpec status at setup end — these must also be removed.
- **`openspecInstallType` in project status object**: Field at line 811 references `checkForOpenSpec()` — must be removed alongside the function.
- **Line 3525**: Additional `openspecStatus` reference — must be removed.

---

## Ambiguity Policy

Use the 7-dimension decision gate rubric. If a decision scores ambiguous mid-dev, pause and ask.

---

## Technical Research

### DRY Check

- Symlink creation: `fs.symlinkSync` already used at `bin/forge.js:589` — extend that pattern
- Plugin JSON schema: established pattern in `lib/agents/` — codex plugin follows same structure
- OpenSpec removal: 4 functions (`checkForOpenSpec`, `initializeOpenSpec`, `isOpenSpecInitialized`, `promptOpenSpecSetup`) + call sites at lines 808, 811, 2486–2491, 3438, 3525

### OpenCode Issues Found

The current `opencode.plugin.json` homepage is `https://github.com/opencode` — incorrect URL. The real project is at `https://opencode.ai`. This is a cosmetic issue but should be fixed. No structural issues found with directories or setup logic.

### Codex CLI Config

- Instructions: `AGENTS.md` at repo root (already exists in forge projects)
- Tool config: `.codex/config.toml` (per-project) or `~/.codex/config.toml` (user-level)
- Plugin needs: `rootConfig` pointing to AGENTS.md (already installed by forge setup), optional `.codex/` directory setup

### OWASP Top 10 Analysis

| Risk | Applies? | Mitigation |
|------|----------|------------|
| A01 Broken Access Control | No | No auth changes |
| A02 Cryptographic Failures | No | No crypto |
| A03 Injection | Low | `bin/forge.js` uses `secureExecFileSync` — existing pattern maintained; no new exec calls added |
| A04 Insecure Design | No | Removing complexity, not adding |
| A05 Security Misconfiguration | Low | Symlink creation — handle EPERM gracefully, don't silently fail |
| A06–A10 | No | Not applicable to CLI config file changes |

### TDD Test Scenarios

1. **Happy path — Codex plugin loads**: `forge setup` with Codex selected → `lib/agents/codex.plugin.json` is read by plugin loader → Codex directories are created
2. **OpenSpec removed — setup completes without prompt**: Running setup flow does not call `promptOpenSpecSetup` or display OpenSpec install prompt
3. **Antigravity absent — plugin loader ignores deleted file**: No `antigravity.plugin.json` → plugin loader does not attempt Antigravity setup
4. **Aider absent — no `.aider.conf.yml` created**: No `aider.plugin.json`, no `customSetup === 'aider'` branch → Aider setup never runs
5. **CLAUDE.md symlink**: On supported filesystem, `forge setup` creates `CLAUDE.md` as symlink → `fs.lstatSync('CLAUDE.md').isSymbolicLink() === true`
