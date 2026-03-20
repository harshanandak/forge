# Task List: GitHub <-> Beads Bidirectional Issue Sync

- **Design**: [2026-03-21-github-beads-sync-design.md](2026-03-21-github-beads-sync-design.md)
- **Epic**: forge-d2cl
- **Branch**: feat/github-beads-sync

---

## Wave 1: Core Modules (no dependencies, parallelizable)

### Task 1: Config loader (`scripts/github-beads-sync/config.mjs`)

**Beads**: forge-jpqe (Define canonical link format and mapping strategy)
**File(s)**: `scripts/github-beads-sync/config.mjs`, `scripts/github-beads-sync.config.json`
**What to implement**: Module that loads and validates the sync configuration file. Exports `loadConfig(configPath?)` which returns the merged config (defaults + user overrides). Default config includes label-to-type mapping, label-to-priority mapping, defaultType, defaultPriority, mapAssignee flag, and publicRepoGate setting.

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/config.test.js` — assert `loadConfig()` returns default config when no file exists
2. Run test: confirm RED (module doesn't exist)
3. Implement: `config.mjs` with `loadConfig()`, `DEFAULT_CONFIG` export
4. Run test: confirm GREEN
5. Write test: assert `loadConfig(customPath)` merges user overrides with defaults
6. Run test: RED, implement merge logic, GREEN
7. Write test: assert missing config file returns defaults (not throws)
8. Commit: `feat: add config loader for GitHub-Beads sync`

**Expected output**: `loadConfig()` returns `{ labelToType, labelToPriority, defaultType, defaultPriority, mapAssignee, publicRepoGate }`.

---

### Task 2: Mapping file CRUD (`scripts/github-beads-sync/mapping.mjs`)

**Beads**: forge-jpqe (Define canonical link format and mapping strategy)
**File(s)**: `scripts/github-beads-sync/mapping.mjs`
**What to implement**: Module for reading/writing `.github/beads-mapping.json`. Exports `readMapping(mappingPath)`, `writeMapping(mappingPath, data)`, `getBeadsId(mappingPath, issueNumber)`, `setBeadsId(mappingPath, issueNumber, beadsId)`. Handles missing file (returns `{}`), atomic write (write to temp then rename), and concurrent access safety.

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/mapping.test.js` — assert `readMapping()` returns `{}` when file missing
2. Run test: RED, implement, GREEN
3. Write test: assert `setBeadsId()` then `getBeadsId()` round-trips correctly
4. Run test: RED, implement, GREEN
5. Write test: assert `getBeadsId()` returns `null` for missing key
6. Run test: RED, implement, GREEN
7. Write test: assert `setBeadsId()` preserves existing entries (doesn't overwrite file)
8. Run test: RED, implement, GREEN
9. Commit: `feat: add mapping file CRUD for GitHub-Beads sync`

**Expected output**: Correct JSON read/write with `{ "42": "forge-abc", "43": "forge-def" }` structure.

---

### Task 3: Bot comment parser/builder (`scripts/github-beads-sync/comment.mjs`)

**Beads**: forge-jpqe (Define canonical link format and mapping strategy)
**File(s)**: `scripts/github-beads-sync/comment.mjs`
**What to implement**: Module for building and parsing the bot comment. Exports `buildComment(beadsId, issueNumber, metadata)` and `parseComment(commentBody)`. Comment format uses `<!-- beads-sync:{issueNumber} -->` HTML tag for machine parsing, human-readable Beads ID, and collapsible `<details>` for metadata. `parseComment` extracts beadsId from any comment body (returns null if not a sync comment). Following Vercel pattern: edit-don't-create.

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/comment.test.js` — assert `buildComment("forge-abc", 42, { type: "feature" })` produces correct markdown
2. Run test: RED, implement, GREEN
3. Write test: assert `parseComment(buildComment(...))` round-trips (returns `{ beadsId, issueNumber }`)
4. Run test: RED, implement, GREEN
5. Write test: assert `parseComment("Regular comment")` returns `null`
6. Run test: RED, implement, GREEN
7. Write test: assert `parseComment` handles comment with extra whitespace/newlines
8. Commit: `feat: add bot comment parser/builder for GitHub-Beads sync`

**Expected output**: `buildComment` returns markdown string, `parseComment` returns `{ beadsId, issueNumber }` or `null`.

---

### Task 4: Input sanitizer (`scripts/github-beads-sync/sanitize.mjs`)

**File(s)**: `scripts/github-beads-sync/sanitize.mjs`
**What to implement**: Module for sanitizing GitHub issue data before passing to `bd` CLI. Exports `sanitizeTitle(title)`, `sanitizeBody(body)`, `sanitizeLabel(label)`. Reuses patterns from `bin/forge.js` `validateCommonSecurity()` but adapted for issue content — strips shell metacharacters, limits length (256 chars for title), replaces dangerous sequences. Does NOT reject — sanitizes and logs warnings.

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/sanitize.test.js` — assert `sanitizeTitle("Normal title")` returns unchanged
2. Run test: RED, implement, GREEN
3. Write test: assert `sanitizeTitle("Title; rm -rf / && echo PWNED")` strips dangerous chars
4. Run test: RED, implement, GREEN
5. Write test: assert `sanitizeTitle("A".repeat(300))` truncates to 256 chars
6. Run test: RED, implement, GREEN
7. Write test: assert `sanitizeTitle("Title with ${{ github.token }}")` strips interpolation patterns
8. Run test: RED, implement, GREEN
9. Commit: `feat: add input sanitizer for GitHub-Beads sync`

**Expected output**: Clean strings safe for `execFile` args.

---

### Task 5: bd CLI wrapper (`scripts/github-beads-sync/run-bd.mjs`)

**File(s)**: `scripts/github-beads-sync/run-bd.mjs`
**What to implement**: Module wrapping `bd` CLI calls via `execFileSync`. Exports `bdCreate({ title, type, priority, assignee, description, externalRef })`, `bdClose(beadsId, reason)`, `bdShow(beadsId)`, `bdSearch(query)`. All use `execFileSync('bd', [...args], { encoding: 'utf8' })` with array args (no shell). Parses bd output to extract beads ID from create, status from show. Follows `scripts/branch-protection.js` pattern for PATH resolution.

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/run-bd.test.js` — assert `buildCreateArgs({ title: "Test", type: "bug", priority: 1 })` returns correct args array (unit test on arg building, not CLI execution)
2. Run test: RED, implement, GREEN
3. Write test: assert `buildCreateArgs` includes `--external-ref gh-42` when externalRef provided
4. Run test: RED, implement, GREEN
5. Write test: assert `buildCloseArgs("forge-abc", "Closed via GH")` returns correct array
6. Run test: RED, implement, GREEN
7. Write test: assert `parseCreateOutput("Created issue: forge-abc\n...")` extracts `"forge-abc"`
8. Run test: RED, implement, GREEN
9. Write test: assert `parseShowOutput(...)` extracts status correctly
10. Commit: `feat: add bd CLI wrapper for GitHub-Beads sync`

**Expected output**: Correct arg arrays and parsed CLI output.

---

### Task 6: Label/priority mapper (`scripts/github-beads-sync/label-mapper.mjs`)

**File(s)**: `scripts/github-beads-sync/label-mapper.mjs`
**What to implement**: Module that maps GitHub labels to Beads type and priority using the config. Exports `mapLabels(labels, config)` which returns `{ type, priority }`. Scans labels in order: first match for type wins, first match for priority wins, falls back to config defaults.

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/label-mapper.test.js` — assert `mapLabels(["bug", "P1"], defaultConfig)` returns `{ type: "bug", priority: 1 }`
2. Run test: RED, implement, GREEN
3. Write test: assert `mapLabels(["enhancement"], defaultConfig)` returns `{ type: "feature", priority: 2 }` (default priority)
4. Run test: RED, implement, GREEN
5. Write test: assert `mapLabels([], defaultConfig)` returns `{ type: "task", priority: 2 }` (all defaults)
6. Run test: RED, implement, GREEN
7. Write test: assert `mapLabels(["P0", "critical"], defaultConfig)` returns `{ priority: 0 }` (first match wins)
8. Run test: RED, implement, GREEN
9. Commit: `feat: add label/priority mapper for GitHub-Beads sync`

**Expected output**: `{ type: string, priority: number }` from any label array.

---

## Wave 2: Entry point + orchestration (depends on Wave 1)

### Task 7: Main entry point (`scripts/github-beads-sync/index.mjs`)

**Beads**: forge-y3uh, forge-xjl7, forge-rtfz
**File(s)**: `scripts/github-beads-sync/index.mjs`
**What to implement**: Entry point called by GitHub Actions: `node scripts/github-beads-sync/index.mjs <action>` where action is `opened`, `closed`, or `beads-closed`. Reads `GITHUB_EVENT_PATH` for event payload (or accepts `--event-path` flag for testing). Orchestrates: config -> sanitize -> map labels -> bd create/close -> mapping file update -> output comment body for workflow to post. Exits with code 0 on success, 1 on error. Uses env vars for GitHub data (never `${{ }}` interpolation).

**TDD steps**:
1. Write test: `test/scripts/github-beads-sync/index.test.js` — assert `handleOpened(event, config)` calls the right sequence (mock bd, mapping, comment modules)
2. Run test: RED, implement, GREEN
3. Write test: assert `handleClosed(event, config)` reads mapping -> checks bd show -> calls bd close
4. Run test: RED, implement, GREEN
5. Write test: assert `handleOpened` skips when bot actor detected
6. Run test: RED, implement, GREEN
7. Write test: assert `handleOpened` skips when `skip-beads-sync` label present
8. Run test: RED, implement, GREEN
9. Write test: assert `handleOpened` is idempotent (existing sync comment -> skip)
10. Run test: RED, implement, GREEN
11. Write test: assert `handleClosed` with missing mapping falls back to comment parsing
12. Commit: `feat: add main entry point for GitHub-Beads sync`

**Expected output**: Process exits 0, outputs beads ID and comment body to stdout.

---

## Wave 3: GitHub Actions workflows (depends on Wave 2)

### Task 8: GitHub Actions workflow — issues.opened + issues.closed

**Beads**: forge-y3uh, forge-xjl7
**File(s)**: `.github/workflows/github-to-beads.yml`
**What to implement**: Single workflow file with two jobs (or one job with conditional steps). Triggers: `issues: [opened, closed]`. Security: all GitHub event data passed via `env:` (never `${{ }}` in `run:`). Concurrency group: `beads-sync` (queue, don't cancel). Permissions: `contents: write`, `issues: write`. Steps: checkout, setup-bun, install bd, run Node script, commit + push `.beads/` and mapping file, post/edit bot comment using GitHub API.

**TDD steps**:
1. Write workflow file with `opened` job
2. Write test: validate YAML structure (no `${{ github.event.issue.title }}` in `run:` blocks) — can be a simple grep-based test
3. Add `closed` job with mapping file lookup + bd close
4. Write test: validate concurrency group is set
5. Write test: validate permissions are minimal (`contents: write`, `issues: write`)
6. Manual test: create test issue on fork, verify bot comment + beads creation
7. Commit: `feat: add GitHub Actions workflow for issue sync`

**Expected output**: Workflow triggers on issue events, creates/closes beads issues, posts bot comments.

---

### Task 9: Default config file + mapping file template

**File(s)**: `scripts/github-beads-sync.config.json`, `.github/beads-mapping.json`
**What to implement**: Ship the default config file with standard label mappings and an empty mapping file `{}`. Config includes `publicRepoGate: "none"` (options: `"none"`, `"label"`, `"author_association"`), `gateLabelName: "beads-track"`, `gateAssociations: ["MEMBER", "COLLABORATOR", "OWNER"]`.

**TDD steps**:
1. Write test: assert default config file is valid JSON and has required keys
2. Run test: RED, create file, GREEN
3. Write test: assert empty mapping file is valid JSON (`{}`)
4. Commit: `feat: add default config and mapping file template`

---

## Wave 4: Forge setup integration (depends on Wave 3)

### Task 10: Forge setup integration — scaffold sync files

**Beads**: forge-4vm6 (Rollout gating)
**File(s)**: `bin/forge.js` or `lib/setup.js` (whichever handles optional features)
**What to implement**: During `bunx forge setup`, add prompt: "Enable GitHub <-> Beads issue sync? (y/n)". If yes: copy workflow file, config file, and mapping file template into user's project. Respect `--quick` flag (skip prompt, don't enable by default). Respect `--skip-external` flag (skip).

**TDD steps**:
1. Write test: `test/setup-github-sync.test.js` — assert scaffold function creates expected files
2. Run test: RED, implement, GREEN
3. Write test: assert `--quick` mode skips sync setup
4. Run test: RED, implement, GREEN
5. Write test: assert scaffold doesn't overwrite existing config (user customizations preserved)
6. Commit: `feat: integrate GitHub-Beads sync into forge setup`

---

## Wave 5: Phase 2 reverse sync (depends on Wave 3, optional)

### Task 11: Beads -> GitHub reverse sync workflow

**Beads**: forge-br3y (Phase 2)
**File(s)**: `.github/workflows/beads-to-github.yml`, `scripts/github-beads-sync/index.mjs` (add `beads-closed` handler)
**What to implement**: Workflow triggers on push to default branch with `paths: ['.beads/**']`. Node script diffs `issues.jsonl` for closed transitions, parses GitHub URL from description, calls `gh api` to close GitHub issue. Guard: skip if commit message starts with `chore(beads):` (prevents loops from Phase 1).

**TDD steps**:
1. Write test: assert `detectClosedIssues(oldJsonl, newJsonl)` finds status transitions
2. Run test: RED, implement, GREEN
3. Write test: assert `extractGitHubUrl(description)` parses URL correctly
4. Run test: RED, implement, GREEN
5. Write test: assert loop guard skips `chore(beads):` commits
6. Commit: `feat: add Beads-to-GitHub reverse sync workflow`

---

## Wave 6: Documentation (depends on all above)

### Task 12: Documentation — sync guide, PR template update, AGENTS.md pointer

**Beads**: forge-ggx8 (Contributor docs)
**File(s)**: `docs/BEADS_GITHUB_SYNC.md`, `.github/pull_request_template.md`, `AGENTS.md`
**What to implement**:
- `docs/BEADS_GITHUB_SYNC.md`: Architecture overview, setup guide, configuration reference, opt-out (label/body keyword), troubleshooting, fork behavior, GitHub Projects integration guide (user-configured, not automated).
- PR template update: Clarify that `Closes #N` closes GitHub issue on merge AND automation auto-closes linked Beads issue.
- AGENTS.md: One-line pointer for AI agents about the sync.

**TDD steps**:
1. Write docs
2. Verify all internal links resolve
3. Commit: `docs: add GitHub-Beads sync guide and update PR template`

---

## Dependency Graph

```
Wave 1 (parallel):  T1  T2  T3  T4  T5  T6
                      \   |   |   |   |   /
Wave 2:                  T7 (entry point)
                          |
Wave 3 (parallel):    T8     T9
                       \     /
Wave 4:                 T10
                         |
Wave 5 (optional):      T11
                         |
Wave 6:                 T12
```

## Summary

| Wave | Tasks | Parallelizable | Est. Complexity |
|------|-------|---------------|-----------------|
| 1 | T1-T6 | Yes (all 6) | Low — pure functions |
| 2 | T7 | No | Medium — orchestration |
| 3 | T8-T9 | Yes (both) | Medium — workflow YAML |
| 4 | T10 | No | Medium — forge.js integration |
| 5 | T11 | No | Low — similar to T7-T8 |
| 6 | T12 | No | Low — docs only |
