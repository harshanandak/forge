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

// Classification used when synthesizing workflow state purely from the kernel's
// recorded stage. `critical` is the full-ladder path
// (plan->dev->validate->ship->review->verify) — a superset of every other
// classification's path — so no canonical stage the kernel could hold is ever
// rejected as "not valid for this workflow". The synthesized classification is
// never persisted; it only drives the allowed-transition computation for this
// single enforcement check.
const KERNEL_SYNTHESIS_CLASSIFICATION = 'critical';

function defaultStageWarn(message) {
  if (process.env.FORGE_JSON === '1') {
    return; // keep machine-readable stdout consumers clean
  }
  process.stderr.write(`${message}\n`);
}

// Resolve the kernel issue that THIS worktree/branch is working on, so stage
// state can be read and written kernel-authoritatively without an explicit
// issue argument on `forge ship`. Prefers the branch->issue linkage registry;
// falls back to a UUID encoded in the branch name (e.g. feat/<uuid>).
function resolveActiveIssueId(driver, branch) {
  if (!driver || !branch) {
    return null;
  }

  try {
    if (typeof driver.listWorktrees === 'function') {
      const rows = driver.listWorktrees() || [];
      const match = rows.find(row => row && row.branch === branch && row.issue_id);
      if (match) {
        return match.issue_id;
      }
    }
  } catch (_error) {
    // Fall through to branch-name parsing.
  }

  const encoded = UUID_RE.exec(String(branch));
  return encoded ? encoded[0] : null;
}

// Read the kernel's recorded current stage for an issue and synthesize an
// authoritative workflow-state object from it. Returns null when the kernel
// holds nothing durable for the issue (fail-closed: the caller then falls back
// to the stateless-entry rules or a hard block).
function synthesizeWorkflowStateFromKernel(driver, issueId) {
  if (!driver || !issueId || typeof driver.getCurrentStage !== 'function') {
    return null;
  }

  let current;
  try {
    current = driver.getCurrentStage({ issue_id: issueId }, {});
  } catch (_error) {
    return null;
  }
  if (!current || !current.stage) {
    return null;
  }

  try {
    return readWorkflowState(JSON.stringify({
      currentStage: current.stage,
      completedStages: [],
      skippedStages: [],
      workflowDecisions: {
        classification: KERNEL_SYNTHESIS_CLASSIFICATION,
        reason: 'kernel-stage-state',
        userOverride: false,
        overrides: [],
      },
      parallelTracks: [],
    }));
  } catch (_error) {
    return null;
  }
}

// Reliable write at the single stage chokepoint: record that we are ENTERING
// stageId for the active issue. Idempotent per (issue_id, stage). Best-effort
// but never silent — a failure warns to stderr so a dropped write leaves a
// trace, while ship's read stays tolerant of whatever IS durably recorded.
function recordStageEntry(driver, issueId, stageId, warn = defaultStageWarn) {
  if (!driver || !issueId || !stageId || typeof driver.recordStageRun !== 'function') {
    return false;
  }

  try {
    driver.recordStageRun({ issue_id: issueId, stage: stageId, action: 'start' }, {});
    return true;
  } catch (error) {
    warn(`[forge] could not record stage '${stageId}' for ${issueId} in the kernel: ${error.message}`);
    return false;
  }
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
  } catch (_error) {
    return null;
  }
}

function detectBranchName(projectRoot) {
  try {
    const { detectWorktree } = require('../detect-worktree');
    const info = detectWorktree(projectRoot || process.cwd());
    return info && info.branch ? info.branch : null;
  } catch (_error) {
    return null;
  }
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
  const issueBackend = resolveIssueBackend({
    deps: {},
    env: process.env,
    projectRoot,
    warn: () => {}
  });
  const runHealthCheck = checkHealth || checkRuntimeHealth;
  let runtimeHealth = health || runHealthCheck(projectRoot, { issueBackend });
  if (runtimeHealth.hardStop && typeof repairRuntime === 'function') {
    const repairedHealth = await repairRuntime({
      commandName,
      flags,
      projectRoot,
      workflowState,
      health: runtimeHealth,
    });
    if (repairedHealth) {
      runtimeHealth = repairedHealth;
    }
  }
  if (runtimeHealth.hardStop) {
    throw new Error(`Stage ${stageId} blocked by runtime prerequisites: ${formatDiagnostics(runtimeHealth.diagnostics)}`);
  }

  const stateInput = resolveWorkflowStateInput(workflowState, flags, args, projectRoot);
  const stateInlineProvided = Boolean(
    workflowState
    || flags.workflowState
    || flags['--workflow-state']
    || getCliFlagValue('--workflow-state', args)
  );

  // Kernel stage-state authority is active when a driver is injected (tests) or
  // the caller opts in (real CLI via autoResolveKernel). An inline/flag state
  // disables it: the caller is explicitly driving state, so no kernel read or
  // write side effects should occur.
  const kernelEnabled = !stateInlineProvided && (Boolean(kernelDriver) || autoResolveKernel === true);
  let driver = kernelDriver || null;
  let issueId = activeIssueId || null;
  if (kernelEnabled) {
    if (!driver) {
      driver = await buildKernelDriver(projectRoot);
    }
    if (driver && !issueId) {
      issueId = resolveActiveIssueId(driver, branch || detectBranchName(projectRoot));
    }
  }

  // Reliable write at the chokepoint: once a stage is allowed, record that the
  // CLI entered it so the kernel always reflects the real workflow phase.
  const finish = (result) => {
    if (kernelEnabled && driver && issueId) {
      recordStageEntry(driver, issueId, stageId, warn);
    }
    return result;
  };

  let currentState = readWorkflowStateInput(stateInput);

  // Tolerant read: with no inline/file state, synthesize authoritative state
  // from what the kernel durably holds (stage_runs, which the chokepoint write
  // and the comment-driven stage-transition recorder both populate). This is
  // what makes `ship` reachable from a pure-CLI plan->dev->validate progression
  // that never wrote a .forge-state.json.
  if (!currentState && kernelEnabled && driver && issueId) {
    currentState = synthesizeWorkflowStateFromKernel(driver, issueId);
  }

  if (!currentState) {
    if (STATELESS_ENTRY_STAGES.has(stageId)) {
      return finish({ allowed: true, stage: stageId, workflowState: null });
    }

    throw new Error(
      `Stage ${stageId} requires authoritative workflow state. ` +
      `Provide --workflow-state or restore ${WORKFLOW_STATE_FILENAME} before continuing.`
    );
  }

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

  return finish({
    allowed: true,
    stage: stageId,
    workflowState: currentState,
    override,
  });
}

module.exports = {
  enforceStageEntry,
  getCliFlagValue,
  parseOverride,
  resolveWorkflowStateInput,
  readWorkflowStateFile,
  resolveActiveIssueId,
  synthesizeWorkflowStateFromKernel,
  recordStageEntry,
};
