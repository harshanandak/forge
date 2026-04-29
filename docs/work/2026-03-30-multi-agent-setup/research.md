# Multi-Agent CLI Setup Patterns — Research Summary

**Date**: 2026-03-30
**Scope**: Research only — no code changes

---

## 1. Agent Config File Locations (Canonical Map)

Each AI coding agent reads instructions from a different location:

| Agent | File(s) | Location |
|-------|---------|----------|
| **Claude Code** | `CLAUDE.md` | Project root, `.claude/rules/*.md` |
| **GitHub Copilot** | `copilot-instructions.md` | `.github/copilot-instructions.md` |
| **Copilot (path-specific)** | `NAME.instructions.md` | `.github/instructions/NAME.instructions.md` (uses `applyTo` frontmatter glob) |
| **Copilot (agent)** | `AGENTS.md` | Anywhere in repo (nearest in tree wins) |
| **Cursor** | `.cursorrules` (legacy) or `.cursor/rules/*.mdc` | Project root / `.cursor/rules/` |
| **Cline** | `.clinerules/` | Directory of rule files at project root |
| **Codex (OpenAI)** | `.codex/` | Project root |
| **Gemini** | `GEMINI.md` | Project root |

**Key insight**: Copilot now also reads `AGENTS.md` and `CLAUDE.md` — convergence is happening, but no single file works for all agents.

---

## 2. Common Patterns for Multi-Target Config Generation

### Pattern A: Canonical Source + Templated Outputs (Recommended)
A single source-of-truth file (e.g., `forge.instructions.md`) that a build/setup step transforms into agent-specific files. Similar to how:
- **Hygen** uses EJS templates with YAML frontmatter (`to:`, `inject:`, `skip_if:`) to generate/inject into target files
- **Yeoman** uses `copyTpl()` with EJS to render templates into destination paths
- **ESLint flat config** cascades and merges configuration objects

### Pattern B: Shared Sections + Agent Wrappers
Each agent file imports/includes a shared core, with agent-specific preamble/postamble. Like ESLint's `extends` pattern or Copilot's path-specific instructions layering on top of repo-wide instructions.

### Pattern C: Symlink/Copy with Markers
Generate once, mark files with `<!-- forge-managed -->` headers. On re-run, only overwrite if marker is present (user hasn't claimed ownership).

---

## 3. Idempotent Setup Best Practices

From Husky, Yeoman, and Hygen patterns:

| Technique | How it works | Used by |
|-----------|-------------|---------|
| **Marker comments** | `<!-- forge-managed: do not edit -->` at file top. Re-run overwrites only if marker present. | Common in codegen |
| **Content hash** | Store SHA-256 of generated content in a manifest (e.g., `.forge/manifest.json`). Compare on re-run — skip if hash matches, warn if file changed but hash differs. | Package-lock patterns |
| **Conflict resolution prompt** | Ask user: overwrite / skip / diff. | Yeoman (interactive) |
| **Inject, don't replace** | Use Hygen-style `inject: true` + `skip_if` to add lines to existing files without full overwrite. | Hygen |
| **Backup before overwrite** | Copy existing to `.bak` before writing. | Conservative CLIs |

**Recommended for Forge**: Marker comment + content hash hybrid. The marker signals "this file is managed by forge." The hash detects if the user edited the managed file. If hash mismatch → warn and skip (or prompt).

---

## 4. "Modified by User" Detection Approaches

1. **Hash in manifest file** — `.forge/setup-manifest.json` stores `{ "path": "sha256-of-last-generated-content" }`. On re-run, read file, hash it, compare. If different from manifest → user modified it.
2. **Hash in file header** — `<!-- forge-managed: sha256:abc123 -->`. Self-contained but slightly ugly.
3. **Timestamp comparison** — Fragile; avoid. Git operations change mtimes.
4. **Git status check** — `git diff --name-only` against the commit where setup ran. Works but couples to git state.

**Best practice**: Manifest file approach (option 1). It separates concerns, `.forge/` can be gitignored or committed per preference.

---

## 5. Useful Libraries

| Library | Purpose | Stars |
|---------|---------|-------|
| **gray-matter** | Parse/stringify YAML frontmatter in markdown files. `matter(str)` → `{ data, content }`, `matter.stringify(content, data)` → frontmatter + body. | 4.4k |
| **EJS** | Template engine used by Hygen and Yeoman. `<%= var %>` interpolation. | — |
| **Inquirer.js** | Interactive CLI prompts (confirm overwrite, select agents). Modern ESM, composable prompts. | 21.5k |
| **mem-fs-editor** | In-memory file system with conflict detection. `copyTpl`, `append`, `extendJSON`. Used by Yeoman. | 424 |
| **Hygen** | Frontmatter-driven code generator. Supports `inject: true`, `skip_if`, `before/after`. Could be used directly. | 6k |
| **cosmiconfig** | Config file discovery (searches package.json, rc files, etc.). Not needed for generation but useful for reading forge config. | — |

---

## 6. Pitfalls to Avoid

1. **Overwriting user customizations silently** — The #1 complaint with setup commands. Always detect modifications before overwriting.
2. **Hardcoding agent-specific syntax into the canonical source** — Keep the source format agent-neutral; let the transformer handle syntax differences.
3. **Making setup non-idempotent** — `forge setup` must be safe to run N times. Use create-if-missing + update-if-managed-and-unchanged.
4. **Ignoring the `.github/instructions/` Copilot pattern** — This is the most powerful pattern (glob-scoped instructions). Forge should generate these, not just `copilot-instructions.md`.
5. **Assuming all agents read the same markdown** — Cursor `.mdc` files have special frontmatter (`description`, `globs`, `alwaysApply`). Copilot instructions use `applyTo`. Claude uses no frontmatter. Transformers must handle these differences.
6. **Not providing a `--force` escape hatch** — Users need a way to regenerate all files even if modified.
7. **Generating files that aren't gitignored but should be** — Agent config files should generally be committed (team consistency), but `.forge/manifest.json` could go either way.

---

## 7. Recommended Architecture for Forge

```
forge.config.md (canonical source — frontmatter + markdown)
       │
       ├─→ CLAUDE.md (root)
       ├─→ .claude/rules/*.md
       ├─→ AGENTS.md (Copilot agent mode)
       ├─→ .github/copilot-instructions.md
       ├─→ .github/instructions/*.instructions.md (with applyTo frontmatter)
       ├─→ .cursor/rules/*.mdc (with Cursor-specific frontmatter)
       ├─→ .clinerules/* (Cline format)
       └─→ GEMINI.md
```

**Pipeline**: `read canonical` → `gray-matter parse` → `per-agent transformer` → `EJS render` → `hash check` → `write if safe`

**Manifest**: `.forge/setup-manifest.json` tracks generated files + their content hashes.

**CLI flow**:
```
forge setup [--agents claude,copilot,cursor] [--force] [--dry-run]
```

---

## Sources Indexed

- ESLint flat config cascade patterns
- Prettier config management
- Husky init idempotent setup
- GitHub Copilot repo instructions (path-specific, AGENTS.md)
- VS Code Copilot customization (parent repo discovery)
- awesome-cursorrules (38.8k stars, community patterns)
- Cline .clinerules structure
- Yeoman file system (conflict resolution, in-memory FS)
- mem-fs-editor (copyTpl, conflict detection)
- Hygen (frontmatter-driven codegen, inject mode)
- gray-matter (frontmatter parse/stringify)
- Inquirer.js (interactive CLI prompts)
