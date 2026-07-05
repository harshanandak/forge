# Setup Fixes — Design Document

| Field   | Value                  |
|---------|------------------------|
| Feature | setup-fixes            |
| Date    | 2026-03-26             |
| Status  | planning               |
| Issues  | forge-fizb, forge-npza |

## Purpose

Fix two gaps in the Forge setup experience:

1. **Missing docs** (forge-fizb): `forge setup` does not copy the full docs/ tree — users miss TOOLCHAIN.md, VALIDATION.md, and other guides that exist in the package but never reach the consumer project.
2. **No cleanup/reset capability** (forge-npza): There is no way to uninstall, reset, or reinstall Forge in a consumer project. Users who need a clean slate must manually delete files.

## Success Criteria

1. `forge setup` copies TOOLCHAIN.md and VALIDATION.md to the consumer project's `docs/forge/` directory.
2. `forge docs <topic>` prints doc content from the installed package (no copy required).
3. `forge docs` (no topic) lists all available topics.
4. `forge reset --soft --force` removes `.forge/` config directory only, preserving all other files.
5. `forge reset --hard --force` removes all Forge-created files (config, commands, rules, scripts, agent dirs, workflows).
6. `forge reinstall --force` performs a hard reset followed by a fresh setup.
7. All destructive commands require `--force` for non-interactive use or prompt for confirmation interactively.

## Out of Scope

- Automatic docs update on package upgrade (future enhancement).
- Selective agent directory removal (e.g., remove .cursor/ but keep .cline/).
- Beads data cleanup (beads manages its own state via git).

## Approach

### Docs: Hybrid (Copy Essential + CLI On-Demand)

- **At setup time**: Copy TOOLCHAIN.md and VALIDATION.md into `docs/forge/` so they are immediately available and version-controlled in the consumer repo.
- **On demand**: `forge docs <topic>` reads any doc from the package's `docs/` directory by topic name. This gives access to all docs without copying everything.
- **Topic allowlist**: toolchain, validation, setup, examples, roadmap. Invalid topics show an error with the list of valid topics.

### Lifecycle: Tiered Reset + Reinstall

- **`forge reset --soft`**: Removes only `.forge/` (setup state/config). Lightweight — user can re-run setup to reconfigure without losing customizations.
- **`forge reset --hard`**: Removes ALL Forge-created files. Uses a file inventory function to categorize and delete. Warns about user-modified files in `.claude/rules/`.
- **`forge reinstall`**: Chains `reset --hard` + `setup`. Atomic convenience command.
- **Confirmation**: `--force` bypasses prompts. Without it, `--soft` asks yes/no, `--hard` and `reinstall` require typing "RESET" to confirm.

## Constraints

- Must not delete user-created files in `.claude/rules/` or custom commands that are not Forge templates.
- Must work on both Windows and Unix (use `path.join`, `fs.rmSync` with `{ recursive: true }`).
- File detection must distinguish Forge-created files from user-created files (compare against known template list).

## Edge Cases

1. **User has custom files in `.claude/`** — Soft reset preserves everything outside `.forge/`. Hard reset warns about user-created files in `.claude/rules/` but proceeds (only removes Forge-template-matched files).
2. **`docs/forge/` directory already exists** — Setup skips files that already exist (idempotent). Does not overwrite user modifications.
3. **`forge docs` called with invalid topic** — Shows error message with list of available topics.
4. **`forge reset` called when Forge not installed** — Graceful error: "Forge is not installed in this directory (no .forge/ found)."
5. **Partial installation state** — `getForgeFiles()` checks each path individually; missing files are simply skipped.

## Ambiguity Policy

7-dimension rubric scoring applies. Confidence >= 80%: proceed and document the decision. Confidence < 80%: stop and ask the user. See project memory for full rubric details.

---

## Technical Research

### OWASP Top 10 Analysis

| Category | Risk | Assessment |
|----------|------|------------|
| A01 Broken Access Control | N/A | Local CLI tool — no network auth, no user roles |
| A02 Cryptographic Failures | N/A | No secrets, tokens, or encryption involved |
| A03 Injection | **LOW** | File paths derived from user input in `forge docs <topic>`. Mitigated by topic allowlist — user input is matched against a fixed set of strings, never interpolated into paths directly. |
| A04 Insecure Design | N/A | Local file operations only |
| A05 Security Misconfiguration | N/A | No server or service configuration |
| A06 Vulnerable Components | N/A | Uses only Node.js fs/path built-ins |
| A07 Auth Failures | N/A | No authentication |
| A08 Data Integrity Failures | N/A | No serialization or CI/CD pipeline manipulation |
| A09 Logging Failures | N/A | Local CLI — no audit logging needed |
| A10 SSRF | N/A | No outbound HTTP requests |

**Primary risk**: Path traversal in `forge docs` if the topic argument is used to construct file paths without validation.

**Mitigation**: Strict allowlist of known doc topics. The topic string is matched against a hardcoded map of `{ topic: filename }` pairs. If not in the map, the command rejects with an error. No string concatenation of user input into file paths.

---

## TDD Test Scenarios

### Happy Path

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | `forge setup` copies essential docs | TOOLCHAIN.md exists at `docs/forge/TOOLCHAIN.md` in consumer project |
| 2 | `forge setup` copies VALIDATION.md | VALIDATION.md exists at `docs/forge/VALIDATION.md` in consumer project |
| 3 | `forge docs toolchain` | Prints content of TOOLCHAIN.md to stdout |
| 4 | `forge docs` (no topic) | Lists all available topics: toolchain, validation, setup, examples, roadmap |
| 5 | `forge reset --soft --force` | Removes `.forge/` directory; `.claude/` and all other files preserved |
| 6 | `forge reset --hard --force` | Removes all Forge-created files (`.forge/`, `.claude/commands/`, `.claude/rules/workflow.md`, `.claude/scripts/`, agent dirs, workflows) |
| 7 | `forge reinstall --force` | All Forge files removed then recreated via setup; end state matches fresh setup |

### Error Cases

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 8 | `forge docs nonexistent` | Error message listing available topics |
| 9 | `forge reset` (no `--force`, non-interactive) | Prompts for confirmation before proceeding |
| 10 | `forge reset --hard` (no `--force`, non-interactive) | Requires typing "RESET" to confirm |

### Edge Cases

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 11 | `forge reset --hard` when custom files exist in `.claude/rules/` | Warns about custom files; removes only Forge-template files |
| 12 | `forge reset` when Forge not installed | Graceful error: "Forge is not installed in this directory" |
| 13 | `forge setup` when `docs/forge/` already has TOOLCHAIN.md | Skips copy (idempotent), does not overwrite |
| 14 | `forge reinstall --force` from partially installed state | Cleans up whatever exists, then runs full setup |
