'use strict';

const { repairWorkflowRuntimeAssets } = require('../commands/setup');
const { checkRuntimeHealth } = require('../runtime-health');
const { resolveIssueBackend } = require('../issue-backend');
const { normalizeStageId } = require('./stages');
const {
  getAllowedTransitionsForWorkflowState,
  normalizeOverrideRecord,
  readWorkflowState,
} = require('./state');
const { loadState, WORKFLOW_STATE_FILENAME } = require('./state-manager');

const STATELESS_ENTRY_STAGES = new Set(['plan', 'dev', 'validate', 'verify']);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Canonical full-ladder path (critical superset). Used to derive a stage's
// immediate predecessor for the kernel completion gate.
const STAGE_PATH = Object.freeze(['plan', 'dev', 'validate', 'ship', 'review', 'verify']);

function stagePredecessor(stageId) {
  const index = STAGE_PATH.indexOf(stageId);
  return index > 0 ? STAGE_PATH[index - 1] : null;
}

// Emit a warning to stderr. Writes even under FORGE_JSON=1 on purpose: stderr
// never pollutes machine-readable stdout, and a dropped kernel write must always
// leave a trace ("never silent") so a JSON-mode agent can see it.
function defaultStageWarn(message) {
  process.stderr.write(`${message}\n`);
}

// Best-effort kernel write (action 'start' | 'complete') at the stage
// chokepoint. Idempotent per (issue_id, stage). A failure warns to stderr but
// never throws — ship's gate stays tolerant of whatever IS durably recorded.
function recordStageRunSafe(driver, issueId, stageId, action, warn = defaultStageWarn) {
  if (!driver || !issueId || !stageId || typeof driver.recordStageRun !== 'function') {
    return false;
  }

  try {
    driver.recordStageRun({ issue_id: issueId, stage: stageId, action }, {});
    return true;
  } catch (error) {
    warn(`[forge] could not record stage '${stageId}' (${action}) for ${issueId} in the kernel: ${error.message}`);
    return false;
  }
}

// Latest stage-run row for a specific (issue, stage), or null.
function findLatestStageRun(driver, issueId, stage) {
  if (!driver || typeof driver.listStageRuns !== 'function') {
    return null;
  }

  try {
    const runs = driver.listStageRuns({ issue_id: issueId }, {}) || [];
    let latest = null;
    for (const run of runs) {
      if (run?.stage === stage) {
        latest = run;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

// (Re-)entering an earlier stage invalidates the work that followed it: any
// DOWNSTREAM stage previously recorded 'done' is reopened to 'active' so a gated
// stage (ship/review) re-requires a fresh completion (R2 — the dev<->validate
// rework loop must not let a stale validate=done pass ship). Reuses the idempotent
// 'start' write, which keeps the row's id + original started_at but clears its
// done status. Stages the entered stage does not precede (and non-'done' rows) are
// left untouched, so forward progression records nothing extra.
function invalidateDownstreamStages(driver, issueId, stageId, warn) {
  const index = STAGE_PATH.indexOf(stageId);
  if (index < 0) {
    return;
  }
  for (let next = index + 1; next < STAGE_PATH.length; next += 1) {
    const downstream = STAGE_PATH[next];
    const run = findLatestStageRun(driver, issueId, downstream);
    if (run?.status === 'done') {
      recordStageRunSafe(driver, issueId, downstream, 'start', warn);
    }
  }
}

// Decide whether entering stageId is allowed given ONLY the kernel's recorded
// stage history (used when no inline/file workflow state exists):
//   - Stateless stages (plan/dev/validate/verify) are always re-entrant, so the
//     dev<->validate rework loop never dead-ends.
//   - A gated stage (ship/review) requires its immediate predecessor to be
//     COMPLETED (status 'done'); merely ENTERING validate does not unlock ship.
//   - When nothing is recorded for the predecessor, returns { kernelEmpty } so
//     the caller falls through to the fail-closed hard block.
function evaluateKernelStageGate(driver, issueId, stageId) {
  if (STATELESS_ENTRY_STAGES.has(stageId)) {
    return { allowed: true };
  }

  const predecessor = stagePredecessor(stageId);
  const predecessorRun = predecessor ? findLatestStageRun(driver, issueId, predecessor) : null;
  if (predecessorRun?.status === 'done') {
    return { allowed: true };
  }
  if (predecessorRun) {
    return {
      allowed: false,
      reason: `Stage ${stageId} requires ${predecessor} to be completed first (currently ${predecessorRun.status}).`,
    };
  }
  return { allowed: false, kernelEmpty: true };
}

// Verify a kernel issue exists before binding stage state to it (F4a: a UUID
// parsed from a branch name must not bind to a phantom issue).
async function kernelIssueExists(driver, issueId) {
  if (!driver || typeof driver.findIssueIdsByPrefix !== 'function') {
    return false;
  }

  try {
    // findIssueIdsByPrefix returns rows ({ id, title }); tolerate plain-id shapes too.
    const matches = await driver.findIssueIdsByPrefix(issueId, 6, {}, {});
    return Array.isArray(matches) && matches.some(row => (row?.id ?? row) === issueId);
  } catch {
    return false;
  }
}

// Resolve the kernel issue that THIS worktree/branch is working on, so stage
// state can be read and written without an explicit issue argument on `forge
// ship`. Prefers the branch->issue linkage registry (authoritative); falls back
// to a UUID encoded in the branch name, but ONLY after verifying it exists.
async function resolveActiveIssueId(driver, branch) {
  if (!driver || !branch) {
    return null;
  }

  try {
    if (typeof driver.listWorktrees === 'function') {
      const rows = driver.listWorktrees() || [];
      // Match only ACTIVE (live) linkage rows, newest first (listWorktrees orders
      // registered_at DESC). A stale/superseded registration for a reused branch
      // name must not rebind stage state to the OLD issue (be18881c). Tolerate a
      // null state for rows written before the state column was populated.
      const match = rows.find(row => row && row.branch === branch && row.issue_id
        && (row.state === 'active' || row.state == null));
      if (match) {
        return match.issue_id;
      }
    }
  } catch {
    // Fall through to branch-name parsing.
  }

  const encoded = UUID_RE.exec(String(branch));
  if (encoded && await kernelIssueExists(driver, encoded[0])) {
    return encoded[0];
  }
  return null;
}

// Lazily build a kernel driver from the project root (the real CLI path).
// Best-effort: returns null when the kernel is unavailable so the caller
// degrades to legacy file/beads state instead of crashing a stage command.
async function buildKernelDriver(projectRoot) {
  if (!projectRoot) {
    return null;
  }

  try {
    const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
    const deps = await buildMigratedKernelIssueDeps({ projectRoot });
    return deps.kernelDriver || null;
  } catch {
    return null;
  }
}

function detectBranchName(projectRoot) {
  try {
    const { detectWorktree } = require('../detect-worktree');
    const info = detectWorktree(projectRoot || process.cwd());
    return info?.branch || null;
  } catch {
    return null;
  }
}

// Resolve { driver, issueId } for kernel stage-state: build the driver from the
// project root and resolve the active issue from the branch when not explicitly
// injected. Best-effort — returns nulls when the kernel is absent.
async function resolveKernelContext({ kernelDriver, activeIssueId, branch, projectRoot }) {
  const driver = kernelDriver || await buildKernelDriver(projectRoot);
  let issueId = activeIssueId || null;
  if (driver && !issueId) {
    issueId = await resolveActiveIssueId(driver, branch || detectBranchName(projectRoot));
  }
  return { driver, issueId };
}

function getOverrideInput(flags = {}) {
  if (Object.hasOwn(flags, 'overrideStage')) {
    return flags.overrideStage;
  }
  if (Object.hasOwn(flags, '--override-stage')) {
    return flags['--override-stage'];
  }
  return null;
}

function getCliFlagValue(flagName, args = []) {
  if (!Array.isArray(args)) {
    return null;
  }

  const prefix = `${flagName}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flagName) {
      return index + 1 < args.length ? args[index + 1] : null;
    }
    if (typeof arg === 'string' && arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }

  return null;
}

function resolveOverrideInput(flags = {}, args = []) {
  return getOverrideInput(flags) || getCliFlagValue('--override-stage', args);
}

function parseOverride(flags = {}, args = []) {
  const input = resolveOverrideInput(flags, args);
  if (!input) {
    return null;
  }

  let parsed;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (error) {
    throw new Error(`Invalid JSON in override-stage flag: ${error.message}`);
  }
  return normalizeOverrideRecord(parsed);
}

function readWorkflowStateFile(projectRoot) {
  if (!projectRoot) {
    return null;
  }

  const fs = require('node:fs');
  const path = require('node:path');
  const statePath = path.join(projectRoot, WORKFLOW_STATE_FILENAME);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return fs.readFileSync(statePath, 'utf8');
}

function resolveWorkflowStateInput(workflowState, flags = {}, args = [], projectRoot) {
  const inlineOrFlag = workflowState
    || flags.workflowState
    || flags['--workflow-state']
    || getCliFlagValue('--workflow-state', args);

  if (inlineOrFlag) {
    return inlineOrFlag;
  }

  const { state } = loadState(projectRoot);
  return state;
}

function readWorkflowStateInput(input) {
  if (!input) {
    return null;
  }

  return readWorkflowState(input);
}

function formatDiagnostics(diagnostics = []) {
  return diagnostics
    .map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)
    .join('; ');
}

// Enforce a stage entry against authoritative FILE/inline workflow state
// (unchanged legacy behavior: normal path-transition + override rules).
function enforceWithFileState(currentState, stageId, flags, args, finish) {
  const currentStage = currentState.currentStage;
  const classification = currentState.workflowDecisions?.classification;
  if (!currentStage || !classification || stageId === currentStage) {
    return finish({ allowed: true, stage: stageId, workflowState: currentState });
  }

  const allowedTransitions = getAllowedTransitionsForWorkflowState(currentState);
  if (allowedTransitions.includes(stageId)) {
    return finish({ allowed: true, stage: stageId, workflowState: currentState });
  }

  const override = parseOverride(flags, args);
  if (!override) {
    throw new Error(
      `Stage ${stageId} is blocked from ${currentStage}. ` +
      `Provide an explicit override payload via overrideStage or --override-stage.`
    );
  }

  if (override.fromStage !== currentStage || override.toStage !== stageId) {
    throw new Error(
      `Stage override does not match workflow state. Expected ${currentStage} -> ${stageId}.`
    );
  }

  return finish({ allowed: true, stage: stageId, workflowState: currentState, override });
}

function isInlineStateProvided(workflowState, flags, args) {
  return Boolean(
    workflowState || flags.workflowState || flags['--workflow-state'] || getCliFlagValue('--workflow-state', args)
  );
}

// Enforce a stage entry against kernel-recorded stage state (completion gate).
// Returns a decided enforcement result, or null to fall through to the
// stateless / hard-block rules.
function enforceWithKernelState(driver, issueId, stageId, finish) {
  const gate = evaluateKernelStageGate(driver, issueId, stageId);
  if (gate.allowed) {
    return finish({ allowed: true, stage: stageId, workflowState: null });
  }
  if (!gate.kernelEmpty) {
    throw new Error(gate.reason);
  }
  return null;
}

async function resolveStageRuntimeHealth({ health, checkHealth, projectRoot, issueBackend, commandName, flags, workflowState, repairRuntime }) {
  const runHealthCheck = checkHealth || checkRuntimeHealth;
  let runtimeHealth = health || runHealthCheck(projectRoot, { issueBackend });
  if (runtimeHealth.hardStop && typeof repairRuntime === 'function') {
    const repaired = await repairRuntime({ commandName, flags, projectRoot, workflowState, health: runtimeHealth });
    if (repaired) {
      runtimeHealth = repaired;
    }
  }
  return runtimeHealth;
}

async function enforceStageEntry({
  commandName,
  args = [],
  flags = {},
  projectRoot,
  workflowState,
  health,
  repairRuntime,
  checkHealth,
  // B1 — kernel stage-state authority. Injectable for tests; the real CLI sets
  // autoResolveKernel:true so the driver + active issue are resolved from the
  // worktree. When neither a driver nor autoResolveKernel is provided, the
  // kernel path is inert and behavior matches the legacy file/beads state.
  kernelDriver,
  activeIssueId,
  branch,
  autoResolveKernel = false,
  warn = defaultStageWarn,
} = {}) {
  const stageId = normalizeStageId(commandName);
  if (!stageId) {
    return { allowed: true };
  }

  if (projectRoot) {
    repairWorkflowRuntimeAssets(projectRoot);
  }

  // Resolve the active issue backend (env > .forge/config.yaml > default 'kernel') so
  // the runtime gate only treats bd as a hard prerequisite for the beads backend. The
  // kernel default needs no bd, so stages must run without it.
  const issueBackend = resolveIssueBackend({ deps: {}, env: process.env, projectRoot, warn: () => {} });
  const runtimeHealth = await resolveStageRuntimeHealth({
    health, checkHealth, projectRoot, issueBackend, commandName, flags, workflowState, repairRuntime,
  });
  if (runtimeHealth.hardStop) {
    throw new Error(`Stage ${stageId} blocked by runtime prerequisites: ${formatDiagnostics(runtimeHealth.diagnostics)}`);
  }

  const stateInput = resolveWorkflowStateInput(workflowState, flags, args, projectRoot);

  // Kernel stage-state authority is active when a driver is injected (tests) or
  // the caller opts in (real CLI via autoResolveKernel). Inline/flag state
  // disables it: the caller is explicitly driving state, so no kernel side
  // effects should occur.
  const kernelEnabled = !isInlineStateProvided(workflowState, flags, args)
    && (Boolean(kernelDriver) || autoResolveKernel === true);
  const { driver, issueId } = kernelEnabled
    ? await resolveKernelContext({ kernelDriver, activeIssueId, branch, projectRoot })
    : { driver: null, issueId: null };
  const kernelActive = Boolean(kernelEnabled && driver && issueId);

  // On an allowed entry, record the stage as started (active) AND return a
  // recordCompletion() the command runner calls after the handler SUCCEEDS — so
  // a stage only counts as 'done' when its command actually passed (the ship
  // gate below requires the predecessor to be done, not merely entered).
  const finish = (result) => {
    if (kernelActive) {
      recordStageRunSafe(driver, issueId, stageId, 'start', warn);
      invalidateDownstreamStages(driver, issueId, stageId, warn);
      result.recordCompletion = () => recordStageRunSafe(driver, issueId, stageId, 'complete', warn);
    }
    return result;
  };

  const currentState = readWorkflowStateInput(stateInput);
  if (currentState) {
    return enforceWithFileState(currentState, stageId, flags, args, finish);
  }

  // B1 — strict mode is the explicit opt-in to the legacy fail-closed behavior:
  // require prior stages / authoritative state. The default (unset) degrades to a
  // loud warning and seeds the kernel so future gating gets real data. A recorded
  // history that CONTRADICTS (e.g. validate started-but-not-done) still throws in
  // both modes — that rework protection lives in enforceWithKernelState below and
  // is never weakened by this flag.
  const strict = process.env.FORGE_STAGE_GATE === 'strict';

  // No inline/file state: the kernel is authoritative. Gate on recorded stage
  // completions (tolerant read) so `ship` is reachable from a pure-CLI
  // plan->dev->validate progression with no .forge-state.json.
  if (kernelActive) {
    const decided = enforceWithKernelState(driver, issueId, stageId, finish);
    if (decided) {
      return decided;
    }
    // enforceWithKernelState returned null → the kernel has an issue linked but
    // NO recorded predecessor (a contradiction would have thrown above). Degrade
    // to warn + seed unless strict: allow the stage and let finish() record it so
    // future gating has real history.
    if (!strict) {
      warn(
        `[forge] no recorded workflow history for issue ${issueId} — allowing '${stageId}' ` +
        `and recording it in the kernel. Set FORGE_STAGE_GATE=strict to require prior stages.`
      );
      return finish({ allowed: true, stage: stageId, workflowState: null, degradedGate: 'kernel-empty' });
    }
  }

  if (STATELESS_ENTRY_STAGES.has(stageId)) {
    return finish({ allowed: true, stage: stageId, workflowState: null });
  }

  // No workflow state AND no kernel-linked issue for this branch. Degrade to warn
  // unless strict so incremental adoption (fresh setup, in-flight branch, manual
  // commit) is not blocked.
  if (!strict) {
    warn(
      `[forge] no workflow state and no kernel-linked issue for this branch — stage gate skipped for '${stageId}'. ` +
      `Link an issue with 'forge worktree create <slug>' to enable stage tracking.`
    );
    return finish({ allowed: true, stage: stageId, workflowState: null, degradedGate: 'no-kernel-context' });
  }

  throw new Error(
    `Stage ${stageId} requires authoritative workflow state. ` +
    `Provide --workflow-state or restore ${WORKFLOW_STATE_FILENAME} before continuing (or unset FORGE_STAGE_GATE).`
  );
}

module.exports = {
  enforceStageEntry,
  getCliFlagValue,
  parseOverride,
  resolveWorkflowStateInput,
  readWorkflowStateFile,
  resolveActiveIssueId,
  evaluateKernelStageGate,
  recordStageRunSafe,
  stagePredecessor,
};
