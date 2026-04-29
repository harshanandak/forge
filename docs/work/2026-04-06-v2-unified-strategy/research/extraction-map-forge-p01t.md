# Extraction Map: bin/forge.js Refactoring (forge-p01t)

**File**: `bin/forge.js` (4766 lines -> target ~300 lines)
**Date**: 2026-03-30
**Status**: RESEARCH ONLY

---

## 1. Module-Level Code (Lines 1-101)

### Requires (18 imports)
```
L38: const fs = require('node:fs');
L39: const path = require('node:path');
L40: const readline = require('node:readline');
L41: const { execSync, execFileSync, spawnSync } = require('node:child_process');
L45: const packageJson = require(path.join(packageDir, 'package.json'));
L49: const PluginManager = require('../lib/plugin-manager');
L50: const { scaffoldGithubBeadsSync } = require('../lib/setup');
L51: const { copyEssentialDocs } = require('../lib/docs-copy');
L52: const { listTopics, getTopicContent } = require('../lib/docs-command');
L53: const { resetSoft, resetHard, reinstall } = require('../lib/reset');
L54: const { loadCommands } = require('../lib/commands/_registry');
L57: const contextMerge = require(path.join(packageDir, 'lib', 'context-merge'));
L58: const projectDiscovery = require(path.join(packageDir, 'lib', 'project-discovery'));
L61: const { createSymlinkOrCopy: libCreateSymlinkOrCopy } = require(path.join(packageDir, 'lib', 'symlink-utils'));
L62: const beadsSetupLib = require(path.join(packageDir, 'lib', 'beads-setup'));
L63: const { beadsHealthCheck } = require(path.join(packageDir, 'lib', 'beads-health-check'));
L64: const { setupPAT } = require(path.join(packageDir, 'lib', 'pat-setup'));
L65: const { detectDefaultBranch, detectBeadsVersion, templateWorkflows, scaffoldBeadsSync } = require(path.join(packageDir, 'lib', 'beads-sync-scaffold'));
L68: const { detectEnvironment } = require('../lib/detect-agent');
L69: const { fileMatchesContent } = require('../lib/file-hash');
L70: const { SetupActionLog } = require('../lib/setup-action-log');
L71: const { ActionCollector, isNonInteractive } = require('../lib/setup-utils');
L72: const { renderSetupSummary } = require('../lib/setup-summary-renderer');
L73: const { smartMergeAgentsMd } = require('../lib/smart-merge');
L74: const { checkLefthookStatus } = require('../lib/lefthook-check');
L75: const { detectHusky, migrateHusky } = require('../lib/husky-migration');
```

### Mutable Globals (7 variables)
```
L81: let projectRoot = process.env.INIT_CWD || process.cwd();
L85: let FORCE_MODE = false;
L86: let VERBOSE_MODE = false;
L87: let NON_INTERACTIVE = false;
L88: let SYMLINK_ONLY = false;
L89: let SYNC_ENABLED = false;
L90: let actionLog = new SetupActionLog();
L93: let PKG_MANAGER = 'npm';
```

### Frozen Constants
```
L44: const packageDir = path.dirname(__dirname);  // __dirname used here
L46: const VERSION = packageJson.version;
L82: const args = process.argv.slice(2);
L155: const AGENTS = loadAgentsFromPlugins();  // Frozen object
L423-468: const SKILL_CONTENT (46 lines, template string)
L471-490: const CURSOR_RULE (20 lines, template string)
```

### Module Exports (L4765)
```
module.exports = { getWorkflowCommands, ensureDirWithNote };
```

### Entry Point (L4754-4762)
```
if (require.main === module) {
  (async () => { await main(); })()
}
```

---

## 2. Categorized Function Map (149 functions)

### KEEP in bin/forge.js (bootstrap/dispatch) — ~12 functions

These form the thin CLI shell: arg parsing, flag wiring, command dispatch.

| # | Function | Lines | Size | Notes |
|---|----------|-------|------|-------|
| 85 | parseFlags | 2520-2616 | 97L | Arg parsing, calls parse helpers |
| 86 | parsePathFlag | 2617-2641 | 25L | Flag sub-parser, has process.exit |
| 87 | parseAgentsFlag | 2642-2659 | 18L | Flag sub-parser |
| 88 | parseMergeFlag | 2660-2686 | 27L | Flag sub-parser, has process.exit |
| 89 | parseTypeFlag | 2687-2714 | 28L | Flag sub-parser, has process.exit |
| 91 | showHelp | 2729-2797 | 69L | Help display, uses __dirname |
| 132 | **main** | 4099-4353 | 255L | Central dispatcher, uses __dirname, all globals |

**Total KEEP**: ~519 lines. After extracting setup/rollback dispatch bodies into delegating calls, main() shrinks to ~80-100 lines. parseFlags + helpers = ~195 lines. showHelp = 69 lines. **Bootstrap target: ~300 lines.**

---

### SETUP — extract to `lib/commands/setup.js` (~120 functions, ~3400 lines)

This is the largest category. All setup-related logic.

#### SETUP: Core Setup Flow (orchestrators)

| # | Function | Lines | Size | Globals | Calls | process.exit |
|---|----------|-------|------|---------|-------|-------------|
| 63 | minimalInstall | 1825-1881 | 57L | projectRoot, packageDir, AGENTS | copyFile, detectProjectType, displayProjectType, updateAgentsMdWithProjectType, showBanner, setupCoreDocs | no |
| 84 | _interactiveSetup | 2410-2519 | 110L | AGENTS | checkPrerequisites, detectProjectStatus, configureExternalServices, showBanner, setupCoreDocs, setupAgent, displayInstallationStatus, promptForFileOverwrite, promptForAgentSelection, installAgentsMd, loadClaudeCommands, setupAgentsWithProgress, displaySetupSummary, setupProjectTools | YES |
| 114 | quickSetup | 3480-3530 | 51L | packageDir, actionLog, VERBOSE_MODE, SYNC_ENABLED, AGENTS | checkPrerequisites, copyFile, showBanner, setupCoreDocs, handleHuskyMigration, installGitHooks, autoInstallLefthook, autoSetupToolsInQuickMode, configureDefaultExternalServices, loadAndSetupClaudeCommands, setupSelectedAgents, handleSyncScaffold | no |
| 124 | interactiveSetupWithFlags | 3726-3814 | 89L | projectRoot, AGENTS | checkPrerequisites, detectProjectStatus, showBanner, setupCoreDocs, promptForAgentSelection, displaySetupSummary, setupAgentsMdFile, handleFlagsOverride, displayExistingInstallation, promptForOverwriteDecisions, loadAndSetupClaudeCommands, setupSelectedAgents, handleExternalServicesStep | YES |
| 128 | executeSetup | 3961-4016 | 56L | packageDir, projectRoot, actionLog, VERBOSE_MODE, SYNC_ENABLED, AGENTS | checkPrerequisites, copyFile, showBanner, setupCoreDocs, loadClaudeCommands, handleHuskyMigration, installGitHooks, loadAndSetupClaudeCommands, setupSelectedAgents, handleSyncScaffold, handleExternalServices | no |
| 130 | handleSetupCommand | 4056-4072 | 17L | projectRoot | executeSetup | no |
| 131 | handleExternalServices | 4073-4098 | 26L | — | configureExternalServices | YES |

#### SETUP: Prerequisites & Detection

| # | Function | Lines | Size | Globals | Calls | process.exit |
|---|----------|-------|------|---------|-------|-------------|
| 1 | secureExecFileSync | 102-130 | 29L | — | — | no |
| 2 | loadAgentsFromPlugins | 131-152 | 22L | — | — | no |
| 11 | safeExec | 307-318 | 12L | — | — | no |
| 12 | detectFromLockFile | 319-329 | 11L | projectRoot, PKG_MANAGER | safeExec | no |
| 13 | detectFromCommand | 330-340 | 11L | PKG_MANAGER | safeExec | no |
| 14 | detectPackageManager | 341-357 | 17L | — | detectFromLockFile, detectFromCommand | no |
| 15 | checkPrerequisites | 358-493 | 136L | PKG_MANAGER | safeExec, detectPackageManager | YES |
| 26 | detectProjectStatus | 766-831 | 66L | projectRoot | parseEnvFile, checkForBeads, isBeadsInitialized, checkForSkills, isSkillsInitialized | no |

#### SETUP: Project Type Detection (12 functions)

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 27 | detectTestFramework | 832-842 | 11L | — |
| 28 | detectLanguageFeatures | 843-880 | 38L | projectRoot |
| 29 | detectNextJs | 881-893 | 13L | — |
| 30 | detectNestJs | 894-906 | 13L | — |
| 31 | detectAngular | 907-919 | 13L | — |
| 32 | detectVue | 920-953 | 34L | — |
| 33 | detectReact | 954-977 | 24L | — |
| 34 | detectExpress | 978-990 | 13L | — |
| 35 | detectFastify | 991-1003 | 13L | — |
| 36 | detectSvelte | 1004-1026 | 23L | — |
| 37 | detectRemix | 1027-1039 | 13L | — |
| 38 | detectAstro | 1040-1052 | 13L | — |
| 39 | detectGenericNodeJs | 1053-1065 | 13L | — |
| 40 | detectGenericProject | 1066-1090 | 25L | — |
| 41 | readPackageJson | 1091-1103 | 13L | projectRoot |
| 42 | detectProjectType | 1104-1159 | 56L | — |
| 43 | displayProjectType | 1160-1194 | 35L | — |
| 44 | generateFrameworkTips | 1195-1257 | 63L | — |
| 45 | updateAgentsMdWithProjectType | 1258-1308 | 51L | projectRoot |

#### SETUP: Instruction File Handling

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 46 | estimateTokens | 1309-1313 | 5L | — |
| 47 | createInstructionFilesResult | 1314-1323 | 10L | — |
| 48 | handleBothFilesExist | 1324-1363 | 40L | — |
| 49 | handleOnlyClaudeMdExists | 1364-1387 | 24L | — |
| 50 | handleOnlyAgentsMdExists | 1388-1412 | 25L | — |
| 51 | handleNoFilesExist | 1413-1430 | 18L | — |
| 52 | _handleInstructionFiles | 1431-1454 | 24L | — |

#### SETUP: External Services / MCP Config

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 53 | promptForCodeReviewTool | 1455-1509 | 55L | — |
| 54 | promptForCodeQualityTool | 1510-1578 | 69L | — |
| 55 | promptForResearchTool | 1579-1610 | 32L | — |
| 56 | checkExistingServiceConfig | 1611-1640 | 30L | — |
| 57 | displayMcpStatus | 1641-1669 | 29L | — |
| 58 | displayEnvTokenResults | 1670-1690 | 21L | — |
| 59 | configureExternalServices | 1691-1773 | 83L | projectRoot, packageDir, NON_INTERACTIVE, PKG_MANAGER, SYNC_ENABLED |
| 113 | configureDefaultExternalServices | 3454-3479 | 26L | PKG_MANAGER |
| 123 | handleExternalServicesStep | 3712-3725 | 14L | — |

#### SETUP: Agent Installation

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 60 | showBanner | 1774-1794 | 21L | — |
| 61 | ensureDirWithNote | 1795-1806 | 12L | — |
| 62 | setupCoreDocs | 1807-1824 | 18L | projectRoot, packageDir, VERBOSE_MODE |
| 64 | setupClaudeAgent | 1882-1905 | 24L | packageDir |
| 65 | setupCursorAgent | 1906-1911 | 6L | CURSOR_RULE |
| 66 | convertCommandToAgentFormat | 1912-1928 | 17L | — |
| 67 | copyAgentCommands | 1929-1941 | 13L | — |
| 68 | copyAgentRules | 1942-1957 | 16L | projectRoot |
| 69 | createAgentSkill | 1958-1968 | 11L | SKILL_CONTENT |
| 70 | setupClaudeMcpConfig | 1969-1989 | 21L | projectRoot |
| 71 | createAgentLinkFile | 1990-1999 | 10L | AGENTS |
| 72 | setupAgent | 2000-2043 | 44L | AGENTS, SYMLINK_ONLY |
| 73 | displayInstallationStatus | 2044-2067 | 24L | AGENTS |
| 82 | setupAgentsWithProgress | 2325-2331 | 7L | — |
| 122 | setupSelectedAgents | 3691-3711 | 21L | AGENTS |

#### SETUP: AGENTS.md Handling

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 74 | promptForAgentsMdWithoutMarkers | 2068-2117 | 50L | — |
| 75 | promptForFileOverwrite | 2118-2155 | 38L | projectRoot |
| 79 | trySemanticMerge | 2239-2258 | 20L | — |
| 80 | installAgentsMd | 2259-2300 | 42L | projectRoot, packageDir |
| 81 | loadClaudeCommands | 2301-2324 | 24L | projectRoot |
| 115 | applyAgentsMdMergeStrategy | 3531-3554 | 24L | — |
| 116 | setupAgentsMdFile | 3555-3579 | 25L | packageDir, projectRoot |
| 121 | loadAndSetupClaudeCommands | 3664-3690 | 27L | projectRoot, AGENTS |

#### SETUP: Agent Selection Prompts

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 76 | displayAgentOptions | 2156-2175 | 20L | AGENTS |
| 77 | validateAgentSelection | 2176-2210 | 35L | — |
| 78 | promptForAgentSelection | 2211-2238 | 28L | — |
| 90 | validateAgents | 2715-2728 | 14L | AGENTS |
| 126 | determineSelectedAgents | 3850-3870 | 21L | AGENTS |

#### SETUP: Summary & Display

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 83 | displaySetupSummary | 2332-2409 | 78L | PKG_MANAGER, AGENTS |
| 117 | handleFlagsOverride | 3580-3597 | 18L | — |
| 118 | saveWorkflowTypeOverride | 3598-3616 | 19L | projectRoot |
| 119 | displayExistingInstallation | 3617-3637 | 21L | — |
| 120 | promptForOverwriteDecisions | 3638-3663 | 26L | — |
| 127 | dryRunSetup | 3871-3960 | 90L | projectRoot, AGENTS |

#### SETUP: Git Hooks / Husky / Lefthook

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 92 | handleHuskyMigration | 2798-2842 | 45L | projectRoot, NON_INTERACTIVE |
| 93 | installGitHooks | 2843-2923 | 81L | projectRoot, packageDir |
| 94 | checkForLefthook | 2924-2932 | 9L | projectRoot |
| 110 | autoInstallLefthook | 3378-3419 | 42L | projectRoot, PKG_MANAGER |

#### SETUP: Beads Tool Integration

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 95 | checkForBeads | 2933-2965 | 33L | projectRoot |
| 96 | isBeadsInitialized | 2966-2971 | 6L | projectRoot |
| 97 | initializeBeads | 2972-3047 | 76L | projectRoot |
| 101 | promptBeadsSetup | 3104-3156 | 53L | — |
| 102 | installViaBunx | 3157-3176 | 20L | — |
| 103 | installBeadsOnWindows | 3177-3185 | 9L | — |
| 104 | installBeadsWithMethod | 3186-3231 | 46L | projectRoot, PKG_MANAGER |
| 109 | autoSetupBeadsInQuickMode | 3343-3377 | 35L | PKG_MANAGER |

#### SETUP: Skills Tool Integration

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 98 | checkForSkills | 3048-3076 | 29L | projectRoot |
| 99 | isSkillsInitialized | 3077-3081 | 5L | projectRoot |
| 100 | initializeSkills | 3082-3103 | 22L | projectRoot |
| 105 | getSkillsInstallArgs | 3232-3241 | 10L | PKG_MANAGER |
| 106 | installSkillsWithMethod | 3242-3266 | 25L | projectRoot, PKG_MANAGER |
| 107 | promptSkillsSetup | 3267-3319 | 53L | — |

#### SETUP: Tool Installation Orchestrators

| # | Function | Lines | Size | Globals |
|---|----------|-------|------|---------|
| 108 | setupProjectTools | 3320-3342 | 23L | — |
| 111 | verifyToolInstall | 3420-3430 | 11L | — |
| 112 | autoSetupToolsInQuickMode | 3431-3453 | 23L | PKG_MANAGER |
| 125 | handlePathSetup | 3815-3849 | 35L | projectRoot |
| 129 | handleSyncScaffold | 4017-4055 | 39L | packageDir, projectRoot, NON_INTERACTIVE |

---

### ROLLBACK — extract to `lib/commands/rollback.js` (~17 functions, ~370 lines)

| # | Function | Lines | Size | Globals | Calls | process.exit |
|---|----------|-------|------|---------|-------|-------------|
| 133 | validateCommitHash | 4354-4361 | 8L | — | — | no |
| 134 | validatePartialRollbackPaths | 4362-4386 | 25L | projectRoot | — | no |
| 135 | validateBranchRange | 4387-4398 | 12L | — | — | no |
| 136 | validateRollbackInput | 4399-4422 | 24L | — | validateCommitHash, validatePartialRollbackPaths, validateBranchRange | no |
| 137 | extractUserMarkerSections | 4423-4437 | 15L | — | — | no |
| 138 | extractCustomCommands | 4438-4452 | 15L | — | — | no |
| 139 | extractUserSections | 4453-4468 | 16L | — | extractUserMarkerSections, extractCustomCommands | no |
| 140 | preserveUserSections | 4469-4507 | 39L | — | — | no |
| 141 | checkGitWorkingDirectory | 4508-4524 | 17L | — | — | no |
| 142 | updateBeadsIssue | 4525-4538 | 14L | — | — | no |
| 143 | handleCommitRollback | 4539-4550 | 12L | — | — | no |
| 144 | handlePrRollback | 4551-4566 | 16L | — | updateBeadsIssue | no |
| 145 | handlePartialRollback | 4567-4581 | 15L | — | — | no |
| 146 | handleBranchRollback | 4582-4594 | 13L | — | — | no |
| 147 | finalizeRollback | 4595-4611 | 17L | AGENTS | preserveUserSections | no |
| 148 | performRollback | 4612-4667 | 56L | projectRoot, AGENTS | validateRollbackInput, extractUserSections, checkGitWorkingDirectory, handleCommitRollback, handlePrRollback, handlePartialRollback, handleBranchRollback, finalizeRollback | no |
| 149 | showRollbackMenu | 4668-4766 | 99L | — | main, performRollback | no |

**Note**: Rollback functions are self-contained. Only `finalizeRollback` references AGENTS, and `performRollback` references projectRoot. These are easily passed as parameters.

---

### VALIDATION — extract to `lib/validation-utils.js` (~8 functions, ~125 lines)

| # | Function | Lines | Size | Globals | Notes |
|---|----------|-------|------|---------|-------|
| 3 | validateCommonSecurity | 169-186 | 18L | — | Pure function |
| 4 | validateUserInput | 188-206 | 19L | — | Dispatcher |
| 5 | validatePathInput | 209-215 | 7L | projectRoot | Needs projectRoot param |
| 6 | validateDirectoryPathInput | 218-241 | 24L | — | Pure function |
| 7 | validateAgentInput | 244-250 | 7L | — | Pure function |
| 8 | validateHashInput | 253-259 | 7L | — | Pure function |
| 9 | _checkWritePermission | 267-283 | 17L | — | Currently unused (prefixed _) |
| 10 | getWorkflowCommands | 289-303 | 15L | packageDir | Needs packageDir param |

**Note**: `validatePathInput` uses the `projectRoot` global. Must be refactored to accept it as parameter.

---

### FILE-IO — extract to `lib/file-utils.js` (~8 functions, ~180 lines)

| # | Function | Lines | Size | Globals | Notes |
|---|----------|-------|------|---------|-------|
| 16 | ensureDir | 494-508 | 15L | projectRoot | Path security check |
| 17 | writeFile | 510-531 | 22L | projectRoot | Path security check |
| 18 | readFile | 533-542 | 10L | — | Simple wrapper |
| 19 | copyFile | 544-582 | 39L | projectRoot, actionLog, FORCE_MODE | Content-hash dedup |
| 20 | createSymlinkOrCopy | 583-601 | 19L | projectRoot | Delegates to lib |
| 21 | stripFrontmatter | 602-607 | 6L | — | Pure function |
| 22 | readEnvFile | 608-622 | 15L | projectRoot | .env.local reader |
| 23 | parseEnvFile | 623-636 | 14L | — | Calls readEnvFile |
| 24 | writeEnvTokens | 637-739 | 103L | projectRoot | .env.local writer, .gitignore update |

**Note**: `copyFile` accesses `actionLog` and `FORCE_MODE` globals. These must be injected (via parameter or context object).

---

### DETECTION — extract to `lib/detection-utils.js` (already partially in `lib/project-discovery.js`)

The 12 framework detectors (detectNextJs through detectGenericProject) plus detectProjectType, detectTestFramework, detectLanguageFeatures. These are already categorized under SETUP above because they're only called during setup. They could alternatively go to a separate detection module.

**Decision**: Keep with SETUP (they're only used during setup). If reuse emerges later, extract then.

---

### SHELL — extract to `lib/shell-utils.js` (~2 functions, ~40 lines)

| # | Function | Lines | Size | Notes |
|---|----------|-------|------|-------|
| 1 | secureExecFileSync | 102-130 | 29L | Used by 15+ functions across setup/tools |
| 11 | safeExec | 307-318 | 12L | Used by prerequisites, detection |

**Note**: `secureExecFileSync` is the most cross-cutting utility. Extract first.

---

### UI — extract to `lib/ui-utils.js` (~2 functions, ~47 lines)

| # | Function | Lines | Size | Globals | Notes |
|---|----------|-------|------|---------|-------|
| 25 | askYesNo | 740-765 | 26L | NON_INTERACTIVE | Used by 5+ functions |
| 60 | showBanner | 1774-1794 | 21L | — | Pure display |

---

## 3. Global State Dependency Analysis

### Globals accessed by count (how many functions use each)

| Global | Read by | Written by | Type |
|--------|---------|------------|------|
| `projectRoot` | ~45 functions | main() only (L81, L4137) | `let` - mutable |
| `AGENTS` | ~30 functions | L155 (frozen) | `const` - immutable after init |
| `PKG_MANAGER` | ~12 functions | detectFromLockFile, detectFromCommand | `let` - set during checkPrerequisites |
| `actionLog` | ~3 functions (copyFile, quickSetup, executeSetup) | main() (L4109) | `let` - reset each run |
| `FORCE_MODE` | ~2 functions (copyFile, +1) | main() (L4104) | `let` - set from flags |
| `NON_INTERACTIVE` | ~5 functions | main() (L4106) | `let` - set from flags |
| `VERBOSE_MODE` | ~3 functions | main() (L4105) | `let` - set from flags |
| `SYMLINK_ONLY` | ~2 functions | main() (L4107) | `let` - set from flags |
| `SYNC_ENABLED` | ~3 functions | main() (L4108) | `let` - set from flags |
| `packageDir` | ~10 functions | never (const, L44) | `const` - derived from __dirname |
| `SKILL_CONTENT` | ~2 functions | never (const, L423) | `const` - template string |
| `CURSOR_RULE` | ~2 functions | never (const, L471) | `const` - template string |

### Strategy for global state
**Create a `SetupContext` object** passed to all extracted functions:
```js
const ctx = {
  projectRoot,
  packageDir,
  AGENTS,
  flags: { force, verbose, nonInteractive, symlinkOnly, syncEnabled },
  actionLog,
  PKG_MANAGER,  // set during checkPrerequisites
  SKILL_CONTENT,
  CURSOR_RULE,
};
```

---

## 4. Edge Cases Inventory

### `__dirname` / `__filename` usage
- **L44**: `const packageDir = path.dirname(__dirname);` — CRITICAL. This resolves to `bin/`'s parent. If code moves to `lib/`, `__dirname` changes. **Solution**: Pass `packageDir` as parameter from bin/forge.js.
- **L4141**: `path.join(__dirname, '..', 'lib', 'commands')` — In main(). Stays in bin/forge.js.
- **L2787**: `path.join(__dirname, '..', 'lib', 'commands')` — In showHelp(). Stays in bin/forge.js OR pass packageDir.

### Relative `require()` paths
- **L4508-4581**: `checkGitWorkingDirectory`, `updateBeadsIssue`, `handlePartialRollback` use inline `require('node:child_process')` — these are stdlib, safe to move.
- **L4595**: `finalizeRollback` uses inline `require('node:fs')` — same, safe.
- **L4218**: main() has inline `require('../lib/commands/recommend')` — relative path changes if moved. But this stays in main().
- **L4325**: main() has inline `require('../lib/commands/team.js')` — same, stays.

### `process.exit()` calls (8 functions)
Functions that call process.exit() directly:
1. `checkPrerequisites` (L407) — exits on missing tools
2. `_interactiveSetup` (L2519) — exits on error
3. `parsePathFlag` (L2637) — exits on invalid path
4. `parseMergeFlag` (L2681) — exits on invalid merge mode
5. `parseTypeFlag` (L2710) — exits on invalid type
6. `interactiveSetupWithFlags` (L3726) — exits on error
7. `handlePathSetup` (L3815) — exits on invalid path
8. `determineSelectedAgents` (L3850) — exits on invalid agents
9. `handleExternalServices` (L4073) — exits on error

**Refactoring strategy**: Extracted modules should throw errors instead of calling process.exit(). The bin/forge.js bootstrap catches and exits.

### Circular reference: showRollbackMenu -> main
- `showRollbackMenu` (L4668) calls `main()` — this is to "return to main menu". After extraction, rollback module would need a callback or the dispatch would handle re-entry.

---

## 5. Extraction Order (optimal sequence)

### Wave 1: Zero-dependency utilities (can extract independently)
1. **`lib/shell-utils.js`** — secureExecFileSync, safeExec (0 internal deps, used by 15+ functions)
2. **`lib/validation-utils.js`** — all validate* functions (0 internal deps, used by parseFlags + rollback)
3. **`lib/ui-utils.js`** — askYesNo, showBanner (0 internal deps, used by setup prompts)

### Wave 2: File I/O (depends on Wave 1 only for actionLog injection)
4. **`lib/file-utils.js`** — ensureDir, writeFile, readFile, copyFile, createSymlinkOrCopy, stripFrontmatter, readEnvFile, parseEnvFile, writeEnvTokens

### Wave 3: Self-contained command modules
5. **`lib/commands/rollback.js`** — All 17 rollback functions (self-contained, only needs projectRoot + AGENTS passed in)

### Wave 4: Setup command (largest, depends on Waves 1-2)
6. **`lib/commands/setup.js`** — All ~95 remaining setup functions. This is the bulk extraction. Depends on shell-utils, file-utils, ui-utils, validation-utils. Receives SetupContext object.

### Wave 5: Thin bootstrap
7. **Slim bin/forge.js** — Keep only: requires, main(), parseFlags + helpers, showHelp, module.exports. Wire up extracted modules.

### Why this order?
- Waves 1-2 have zero cross-dependencies, can be extracted and tested independently
- Wave 3 (rollback) is self-contained, no shared state with setup
- Wave 4 (setup) is the monolith but once waves 1-2 are out, its internal functions just call each other
- Wave 5 is the final cleanup

---

## 6. Extraction Dependency Graph

```
bin/forge.js (bootstrap)
  |
  +-- lib/shell-utils.js          [Wave 1, 0 deps]
  |     secureExecFileSync, safeExec
  |
  +-- lib/validation-utils.js     [Wave 1, 0 deps]
  |     validateUserInput, validateCommonSecurity, validatePathInput,
  |     validateDirectoryPathInput, validateAgentInput, validateHashInput,
  |     _checkWritePermission, getWorkflowCommands
  |
  +-- lib/ui-utils.js             [Wave 1, 0 deps]
  |     askYesNo, showBanner
  |
  +-- lib/file-utils.js           [Wave 2, no lib deps]
  |     ensureDir, writeFile, readFile, copyFile, createSymlinkOrCopy,
  |     stripFrontmatter, readEnvFile, parseEnvFile, writeEnvTokens
  |
  +-- lib/commands/rollback.js    [Wave 3, 0 cross-deps]
  |     showRollbackMenu, performRollback, validateRollbackInput,
  |     extractUserSections, preserveUserSections, checkGitWorkingDirectory,
  |     handleCommitRollback, handlePrRollback, handlePartialRollback,
  |     handleBranchRollback, finalizeRollback, updateBeadsIssue,
  |     validateCommitHash, validatePartialRollbackPaths, validateBranchRange,
  |     extractUserMarkerSections, extractCustomCommands
  |
  +-- lib/commands/setup.js       [Wave 4, depends on waves 1-2]
        ~95 functions: all setup orchestration, prerequisites,
        project detection, agent installation, tool integration,
        external services, prompts, summaries
```

---

## 7. Post-Extraction bin/forge.js Structure (~300 lines)

```js
#!/usr/bin/env node

// Requires (~20 lines)
const fs = require('node:fs');
const path = require('node:path');
const { loadCommands } = require('../lib/commands/_registry');
const { listTopics, getTopicContent } = require('../lib/docs-command');
const { resetSoft, resetHard, reinstall } = require('../lib/reset');
const { SetupActionLog, isNonInteractive } = require('../lib/setup-utils');
const { showRollbackMenu } = require('../lib/commands/rollback');
const setup = require('../lib/commands/setup');

// Bootstrap constants (~5 lines)
const packageDir = path.dirname(__dirname);
const VERSION = require(path.join(packageDir, 'package.json')).version;
let projectRoot = process.env.INIT_CWD || process.cwd();
const args = process.argv.slice(2);

// parseFlags + sub-parsers (~195 lines — could also extract)
function parseFlags() { ... }
function parsePathFlag() { ... }
function parseAgentsFlag() { ... }
function parseMergeFlag() { ... }
function parseTypeFlag() { ... }

// showHelp (~69 lines)
function showHelp() { ... }

// main() dispatch (~80-100 lines, slimmed)
async function main() {
  const command = args[0];
  const flags = parseFlags();
  // ... flag wiring ...

  if (flags.help) { showHelp(); return; }
  if (flags.version) { console.log(`Forge v${VERSION}`); return; }
  if (flags.path) { projectRoot = setup.handlePathSetup(flags.path); }

  const registry = loadCommands(...);
  // ... first-run check ...
  if (registry.commands.has(command)) { /* dispatch */ }

  if (command === 'setup') { await setup.handle(args, flags, projectRoot); }
  else if (command === 'rollback') { await showRollbackMenu(); }
  else if (command === 'recommend') { /* 8 lines */ }
  else if (command === 'docs') { /* 15 lines */ }
  else if (command === 'reset') { /* 30 lines */ }
  else if (command === 'reinstall') { /* 20 lines */ }
  else if (command === 'team') { /* 3 lines */ }
  else if (postinstall) { /* 10 lines */ }
  else { setup.minimalInstall(projectRoot); }
}

// Entry + exports (~10 lines)
if (require.main === module) { main().catch(console.error); }
module.exports = { getWorkflowCommands: require('../lib/validation-utils').getWorkflowCommands, ensureDirWithNote: require('../lib/commands/setup').ensureDirWithNote };
```

**Estimated size**: ~300-350 lines (parseFlags is the largest chunk at ~195 lines; could be extracted to a 5th module in a follow-up).
