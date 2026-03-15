# Design: Agent Command Parity — Cleanup & Completion

- **Slug**: agent-command-parity-v2
- **Date**: 2026-03-15
- **Status**: Active
- **Beads**: forge-2w3
- **Supersedes**: docs/plans/2026-03-04-agent-command-parity-design.md (original, partially completed across PRs #52-#58)

---

## Purpose

Close out forge-2w3 by cleaning up all dropped-agent debris and completing the two remaining deliverables (plugin catalog fix + `forge check-agents` CLI). PRs #54-#58 delivered the command sync infrastructure and generated all 77 command files, but left behind stale references to 4 dropped agents (Antigravity, Windsurf, Aider, Continue) and never updated the plugin catalog or built the CLI validator.

---

## Success Criteria

1. Zero references to dropped agents (Antigravity, Windsurf, Aider, Continue) in active code, config, or docs
2. Plugin catalog (`lib/agents/*.plugin.json`) has correct capability flags for all 8 supported agents
3. `forge check-agents` CLI command validates all agent configs are complete and consistent
4. `node scripts/sync-commands.js --check` still passes
5. All existing tests pass; new tests cover plugin catalog and check-agents
6. Design doc status updated, forge-2w3 closeable

---

## Out of Scope

- Adding new agents
- Changing the sync script or adapter transforms (working correctly)
- Hooks support for any agent
- Rewriting docs/EXAMPLES.md examples 1-3,5 (just fix `/research` → `/plan` references)

---

## Approach Selected

**Mechanical cleanup + two small features.** No architecture changes. Three work streams:

1. **Dropped-agent cleanup** — delete files, remove code paths, clean references
2. **Plugin catalog fix** — update capability flags and directories for 6 plugins
3. **`forge check-agents` CLI** — new command that reads plugin catalog + checks files exist

---

## Constraints

- Must not break `forge setup` for any of the 8 supported agents
- Research docs that are fundamentally about dropped agents → delete entire file
- Research docs with minor dropped-agent mentions → fix the references, keep the doc
- Examples fundamentally built on OpenSpec → delete the example
- Examples with minor `/research` stage references → fix to `/plan`
- Gitignore entries for dropped agents → remove (cleaner repo)

---

## Edge Cases

1. **`.agents/skills/` has skill files** — orphaned, gitignored, no plugin references it. Safe to delete from disk (not tracked in git).
2. **`.agent/` directory empty but exists** — gitignored, safe to delete from disk.
3. **`.aider.conf.yml` is git-tracked** — must `git rm`, not just delete.
4. **`lib/agents/continue.plugin.json` is git-tracked** — must `git rm`.
5. **`bin/forge.js` has Continue setup function** — ~40 lines of dead code (generateContinueConfig, continueFormat logic). Remove entirely.
6. **`packages/skills/src/lib/agents.js`** — lists all 4 dropped agents as enabled. Remove entries + update tests.
7. **`openspec/` directory** — removed from forge.js in PR #54 but directory still exists. Check if git-tracked.
8. **`package.json` description** — says "9-stage" and lists all dropped agents. Fix to "7-stage" with only 8 supported agents.

---

## Ambiguity Policy

Make a conservative choice and document it in the decisions log. Only pause for user input if the change could break `forge setup` or delete something that might be intentionally kept.

---

## Technical Research

### Blast-Radius Search Results (Dropped Agents)

Complete inventory of every file referencing dropped agents:

#### Files to DELETE entirely:
| File | Reason |
|------|--------|
| `.aider.conf.yml` | Aider config, git-tracked |
| `lib/agents/continue.plugin.json` | Continue plugin, git-tracked |
| `docs/research/agent-instructions-sync.md` | Entirely about syncing GEMINI.md/.windsurfrules — obsolete approach |
| `docs/README-v1.3.md` | Frozen v1.3 snapshot, Antigravity/Windsurf/Continue throughout, misleading |

#### Files to EDIT (remove dropped references):
| File | What to fix |
|------|-------------|
| `package.json` | description: "7-stage", remove windsurf/aider/continue/antigravity from keywords |
| `packages/skills/src/lib/agents.js` | Remove aider, antigravity, continue, windsurf entries |
| `packages/skills/src/commands/sync.js` | Remove Aider config update logic, fix help text |
| `packages/skills/test/agents.test.js` | Remove Aider/Continue detection tests |
| `packages/skills/test/sync.test.js` | Remove Aider sync test |
| `bin/forge.js` | Remove Continue setup (~lines 1679, 1921, 1998-2020, 2067), continueFormat logic |
| `bin/forge-cmd.js` | Remove "OpenSpec" from plan description |
| `lib/project-discovery.js` | Remove Aider detection |
| `lib/agents/README.md` | Remove Windsurf, Antigravity, Aider rows |
| `docs/TOOLCHAIN.md` | Remove Windsurf mention, Continue MCP setup |
| `docs/EXAMPLES.md` | Delete Example 4 (OpenSpec-based), fix `/research` → `/plan` in examples 1,2,3,5 |
| `docs/AGENT_INSTALL_PROMPT.md` | Remove Continue detection |
| `docs/research/agent-permissions.md` | Remove Antigravity/Aider rows from tables |
| `docs/research/dependency-chain.md` | Fix 1 Continue reference |
| `docs/research/test-environment.md` | Fix 1 Continue reference |
| `CLAUDE.md` | Remove Continue MCP reference |
| `QUICKSTART.md` | Remove Windsurf from examples |
| `.forge/pr-body.md` | Remove Aider, Antigravity references |
| `.gitignore` | Remove `.agents/`, `.agent/`, `.aider/skills/`, `.continue/skills/`, `.windsurf/skills/` entries |
| `test-env/validation/agent-validator.test.js` | Remove aider from list |

#### Untracked dirs to delete from disk:
| Directory | Reason |
|-----------|--------|
| `.agent/` | Antigravity, empty, gitignored |
| `.agents/` | Antigravity shared skills, orphaned, gitignored |

#### Plugin catalog fixes (kept agents, wrong flags):
| Plugin | Changes |
|--------|---------|
| `cursor.plugin.json` | `commands: true`, add `"commands": ".cursor/commands"` to directories |
| `cline.plugin.json` | `commands: true`, add `"workflows": ".clinerules/workflows"` to directories |
| `copilot.plugin.json` | `commands: true` |
| `kilocode.plugin.json` | `commands: true` |
| `codex.plugin.json` | `commands: true`, add `"skills": ".codex/skills"` to directories |
| `claude.plugin.json` | `hooks: true` (has `.claude/settings.json` hooks) |

### OWASP Top 10 Analysis

This feature deletes files and updates config/metadata. No user input processing, no auth, no network calls.

- **A01-A10**: Not applicable — purely static file cleanup and metadata correction.

### TDD Test Scenarios

1. **Plugin catalog**: Each supported agent's plugin.json has `commands: true` and correct directory path
2. **No dropped agents in plugin catalog**: `continue.plugin.json` should not exist; no plugin has id matching dropped agents
3. **`forge check-agents` happy path**: All 8 agent dirs populated → exits 0
4. **`forge check-agents` missing file**: Remove one command file → exits non-zero, reports which file/agent
5. **`forge check-agents` uses sync --check**: Delegates to existing sync infrastructure rather than reimplementing
6. **Dropped-agent code removal**: `packages/skills/src/lib/agents.js` should not contain aider/antigravity/continue/windsurf
7. **package.json accuracy**: Description says "7-stage", keywords don't include dropped agents
