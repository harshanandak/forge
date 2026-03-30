# Registry Migration Plan: 7 Commands to Registry Pattern

**Issue:** forge-6w1
**Date:** 2026-03-30
**Status:** Research complete, ready for implementation

---

## Registry Pattern (Reference)

Compliant commands (`clean.js`, `push.js`, `sync.js`, `test.js`, `worktree.js`) export:

```js
module.exports = {
  name: 'commandname',        // string (required)
  description: 'What it does', // string (required)
  handler: async (args, flags, projectRoot, opts) => { ... }, // function (required)
  usage: 'forge cmd [options]', // string (optional)
  flags: { '--flag': 'desc' }, // object (optional)
  // Additional utility exports allowed (e.g., worktree.js exports stopDolt)
};
```

**Entry point:** `bin/forge.js` loads registry via `loadCommands()` at line 54. Registry commands dispatch at line 4160-4176. Non-registry commands (recommend, team, etc.) are dispatched via hardcoded `else if` blocks below.

**Secondary entry:** `bin/forge-cmd.js` imports 5 commands (status, plan, dev, validate, ship) via `HANDLERS` object and calls their exported functions directly (e.g., `HANDLERS.dev.executeDev()`).

---

## Command 1: dev.js

**Current exports:**
```
detectTDDPhase(context)
identifyFilePairs(files)
runTests(options)
getTDDGuidance(phase)
generateCommitMessage(context)
identifyParallelWork(features)
executeDev(featureName, options)
calculateDecisionRoute(score, dimensions)
DECISION_ROUTES                          // constant object
verifyTaskCompletion(taskTitle, ownedFiles, opts)
```

**Consumers:**
- `bin/forge-cmd.js:15` -- `require('../lib/commands/dev')` -> calls `HANDLERS.dev.executeDev(featureName, { phase })`
- `test/commands/dev.test.js:12` -- destructures: `detectTDDPhase, identifyFilePairs, runTests, getTDDGuidance, generateCommitMessage, identifyParallelWork, executeDev, calculateDecisionRoute, DECISION_ROUTES`
- `test/integration/package-distribution.test.js:320` -- path string check only

**Cross-command deps:** None. No other commands import from dev.js.

**Handler design:**
```js
handler(args, flags, projectRoot) {
  const featureName = args[0];
  const phase = args[1]?.toUpperCase() || flags['--phase']?.toUpperCase();
  return executeDev(featureName, { phase });
}
```

**Utility module:** Keep all utilities in `dev.js` itself. The module.exports just needs `name`, `description`, `handler` added. All existing exports remain for test/forge-cmd backward compatibility.

**process.exit() calls:** None in dev.js itself.
**Interactive prompts:** None.
**Circular risk:** None. Only imports from `node:child_process`, `node:fs`, `node:path`.
**Migration complexity:** LOW -- Add 3 registry fields + a thin `handler` wrapper around `executeDev`. All existing exports stay.

---

## Command 2: plan.js

**Current exports:**
```
readResearchDoc(featureSlug)
detectScope(researchContent)
createBeadsIssue(featureName, researchPath, scope)
createFeatureBranch(featureSlug)
extractDesignDecisions(researchContent)
extractTasksFromResearch(researchContent)
detectDRYViolation(tasks)
applyYAGNIFilter(tasks)
executePlan(featureName)
```

**Consumers:**
- `bin/forge-cmd.js:14` -- `require('../lib/commands/plan')` -> calls `HANDLERS.plan.executePlan(positionalArgs[0])`
- `test/commands/plan.test.js:10` -- destructures: `readResearchDoc, detectScope, createBeadsIssue, createFeatureBranch, extractDesignDecisions, extractTasksFromResearch, executePlan`
- `test/commands/plan.phases.test.js:44` -- destructures same + `detectDRYViolation, applyYAGNIFilter` (lines 566, 603)
- `test/integration/package-distribution.test.js:319` -- path string check only

**Cross-command deps:** None.

**Handler design:**
```js
handler(args, flags, projectRoot) {
  const featureName = args[0];
  return executePlan(featureName);
}
```

**Utility module:** Keep all utilities in `plan.js` itself. Add registry fields.

**process.exit() calls:** None in plan.js itself.
**Interactive prompts:** None.
**Circular risk:** None. Only imports `node:fs`, `node:path`, `node:child_process`.
**Migration complexity:** LOW -- Add 3 registry fields + thin `handler` wrapper around `executePlan`.

---

## Command 3: ship.js

**Current exports:**
```
extractKeyDecisions(researchContent)
extractTestScenarios(researchContent)
getTestCoverage(opts)
generatePRBody(options)
validatePRTitle(title)
createPR(options)
executeShip(options)
```

**Consumers:**
- `bin/forge-cmd.js:17` -- `require('../lib/commands/ship')` -> calls `HANDLERS.ship.executeShip({ featureSlug, title, dryRun })`
- `test/commands/ship.test.js:9` -- destructures: `extractKeyDecisions, extractTestScenarios, getTestCoverage, generatePRBody, createPR, executeShip`
- `test/integration/package-distribution.test.js:322` -- path string check only

**Cross-command deps:** None.

**Handler design:**
```js
handler(args, flags, projectRoot) {
  const featureSlug = args[0];
  const title = args[1];
  const dryRun = !!(flags['--dry-run'] || flags.dryRun);
  return executeShip({ featureSlug, title, dryRun });
}
```

**Utility module:** Keep all utilities in `ship.js` itself. Add registry fields.

**process.exit() calls:** None in ship.js itself.
**Interactive prompts:** None.
**Circular risk:** None. Only imports `node:child_process`, `node:fs`, `node:path`.
**Migration complexity:** LOW -- Add 3 registry fields + thin `handler` wrapper around `executeShip`.

---

## Command 4: status.js

**Current exports:**
```
detectStage(context)
analyzeBranch(branch)
analyzeFiles(context)
analyzePR(pr)
analyzeChecks(checks)
analyzeBeads(beadsIssue)
calculateConfidence(factors, stage)
formatStatus(stageResult)
```

**Consumers:**
- `bin/forge-cmd.js:13` -- `require('../lib/commands/status')` -> calls `HANDLERS.status.detectStage(context)` and `HANDLERS.status.formatStatus(stageResult)`
- `test/commands/status.test.js:10` -- destructures: `detectStage, analyzeBranch, analyzeFiles, analyzePR, analyzeChecks, analyzeBeads, formatStatus`
- `test/integration/package-distribution.test.js:323` -- path string check only

**Cross-command deps:** None.

**Handler design:**
```js
handler(args, flags, projectRoot) {
  // status requires building a context object from the project state
  // The forge-cmd.js currently builds this context inline (reads git branch, lists files, etc.)
  // The handler should encapsulate this context-building logic
  const context = buildStatusContext(projectRoot);
  const stageResult = detectStage(context);
  return { success: true, ...stageResult, formatted: formatStatus(stageResult) };
}
```
Note: `bin/forge-cmd.js` builds the `context` object inline (reads branch, lists dirs, etc.). The handler needs a new `buildStatusContext(projectRoot)` helper extracted from `forge-cmd.js` inline logic (lines ~225-240) so the registry handler is self-contained.

**Utility module:** Keep all utilities in `status.js`. Add registry fields + a `buildStatusContext` helper.

**process.exit() calls:** None in status.js itself.
**Interactive prompts:** None.
**Circular risk:** None. Pure analysis functions, no external imports beyond node builtins.
**Migration complexity:** MEDIUM -- Needs a `buildStatusContext(projectRoot)` helper extracted from `forge-cmd.js` inline logic. All other changes are additive.

---

## Command 5: validate.js

**Current exports:**
```
runTypeCheck(opts)
runLint(opts)
runSecurityScan(opts)
runAllTests(opts)
executeValidate(opts)
executeDebugMode(opts)
```

**Consumers:**
- `bin/forge-cmd.js:16` -- `require('../lib/commands/validate')` -> calls `HANDLERS.validate.executeValidate()`
- `test/commands/validate.test.js:9` -- destructures: `runTypeCheck, runLint, runSecurityScan, runAllTests, executeValidate, executeDebugMode`
- `test/commands/validate.test.js:166` -- secondary `require` for `executeValidate`
- `test/integration/package-distribution.test.js:321` -- path string check only

**Cross-command deps:** None.

**Handler design:**
```js
handler(args, flags, projectRoot) {
  const debug = !!(flags['--debug'] || flags.debug);
  if (debug) return executeDebugMode();
  return executeValidate();
}
```

**Utility module:** Keep all utilities in `validate.js`. Add registry fields.

**process.exit() calls:** None in validate.js itself.
**Interactive prompts:** None.
**Circular risk:** None. Only imports `node:child_process`, `node:fs`, `node:path`.
**Migration complexity:** LOW -- Add 3 registry fields + thin `handler` wrapper around `executeValidate`.

---

## Command 6: recommend.js

**Current exports:**
```
formatRecommendations(recommendations)
handleRecommend(flags, projectPath)
```

**Consumers:**
- `bin/forge.js:4218` -- `require('../lib/commands/recommend')` -> calls `handleRecommend(flags, projectRoot)` and `formatRecommendations(result.recommendations)` inline
- `test/commands/recommend.test.js:6` -- destructures: `formatRecommendations, handleRecommend`
- `test/integration/package-distribution.test.js` -- path string check only

**Cross-command deps:** None. Imports from `../plugin-recommender`, `../project-discovery`, `../plugin-catalog` (lib-level modules, not other commands).

**Handler design:**
```js
handler(args, flags, projectRoot) {
  const result = handleRecommend(flags, projectRoot);
  if (result.error) {
    return { success: false, error: result.error };
  }
  return { success: true, ...result, formatted: formatRecommendations(result.recommendations) };
}
```

**Utility module:** Keep all utilities in `recommend.js`. Add registry fields.

**process.exit() calls:** None. Uses `process.exitCode = 1` in `forge.js` dispatch only.
**Interactive prompts:** None.
**Circular risk:** None. Imports lib-level modules only.
**Migration complexity:** LOW -- Add 3 registry fields + thin `handler` wrapper. The `forge.js` dispatch block (line 4217-4225) can then be removed in favor of registry dispatch.

---

## Command 7: team.js

**Current exports:**
```
handleTeam(args)
```

**Consumers:**
- `bin/forge.js:4325` -- `require('../lib/commands/team.js')` -> calls `handleTeam(process.argv.slice(3))`
- `test/commands/team.test.js` -- imports `handleTeam`, checks it's a function + routing exists

**Cross-command deps:** None.

**Handler design:**
```js
handler(args, flags, projectRoot) {
  // handleTeam currently calls process.exit on error -- must be refactored
  return handleTeamSafe(args, projectRoot);
}
```

**Utility module:** Keep in `team.js`. Refactor `handleTeam` to return result object instead of calling `process.exit()`.

**process.exit() calls:** YES -- `team.js` line ~35: `process.exit(err.status || 1)` in the catch block of `handleTeam`. **Must be refactored** to return `{ success: false, error: ... }` instead.
**Interactive prompts:** None (delegates to bash script via `execFileSync` with `stdio: 'inherit'`).
**Circular risk:** None. Only imports `node:fs`, `node:child_process`, `node:path`.
**Migration complexity:** MEDIUM -- Must remove `process.exit()` from `handleTeam` and return a result object instead. Also needs `_resolveBash` to remain as internal utility. The `forge.js` dispatch block (line 4324-4326) can then be removed.

---

## Summary: Migration Order (Recommended)

| Priority | Command      | Complexity | Reason |
|----------|-------------|------------|--------|
| 1        | validate.js | LOW        | Simplest: `executeValidate()` takes no args, no process.exit |
| 2        | ship.js     | LOW        | Clean `executeShip(options)` pattern |
| 3        | dev.js      | LOW        | Clean `executeDev(name, opts)` pattern |
| 4        | plan.js     | LOW        | Clean `executePlan(name)` pattern |
| 5        | recommend.js| LOW        | Already has handler pattern, just needs registry fields |
| 6        | status.js   | MEDIUM     | Needs `buildStatusContext()` helper extraction |
| 7        | team.js     | MEDIUM     | Must remove `process.exit()`, refactor to return result |

## Consumers That Need Updating

### bin/forge-cmd.js
- Currently imports 5 commands (status, plan, dev, validate, ship) as `HANDLERS`
- After migration: Can switch to registry imports OR keep destructuring (exports preserved)
- **No breaking change** -- all existing utility exports remain on the module

### bin/forge.js
- Lines 4217-4225: `recommend` dispatch block -- can be removed (registry handles it)
- Lines 4324-4326: `team` dispatch block -- can be removed (registry handles it)
- Line 4147: `recommend` in setup-check skip list -- can be removed (registry check handles it at line 4150)

### Test files
- **No changes needed** -- all test files destructure utility functions which remain exported
- Tests import directly from `lib/commands/<name>.js`, not via the registry

## Cross-Command Dependencies

**None found.** All 7 commands are independent:
- No command file imports from another command file
- No circular dependency risk between any command modules
- The only shared code is lib-level modules (`plugin-recommender`, `project-discovery`, `plugin-catalog`) used by `recommend.js`

## Global Findings

- **process.exit():** Only in `team.js` (must fix)
- **Interactive prompts:** None in any of the 7 commands (all prompts are in `bin/forge.js` setup flow)
- **Circular deps:** None possible (no cross-command imports)
- **Backward compatibility:** All existing exports remain -- registry fields are purely additive
