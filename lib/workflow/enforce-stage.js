'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { repairWorkflowRuntimeAssets } = require('../commands/setup');
const { checkRuntimeHealth } = require('../runtime-health');
const { normalizeStageId } = require('./stages');
const {
  getAllowedTransitionsForWorkflowState,
  normalizeOverrideRecord,
  readWorkflowState,
} = require('./state');

const WORKFLOW_STATE_FILENAME = '.forge-state.json';

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

  const statePath = path.join(projectRoot, WORKFLOW_STATE_FILENAME);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return fs.readFileSync(statePath, 'utf8');
}

function resolveWorkflowStateInput(workflowState, flags = {}, args = [], projectRoot) {
  return workflowState
    || flags.workflowState
    || flags['--workflow-state']
    || getCliFlagValue('--workflow-state', args)
    || readWorkflowStateFile(projectRoot);
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

async function enforceStageEntry({ commandName, args = [], flags = {}, projectRoot, workflowState, health, repairRuntime } = {}) {
  const stageId = normalizeStageId(commandName);
  if (!stageId) {
    return { allowed: true };
  }

  if (projectRoot) {
    repairWorkflowRuntimeAssets(projectRoot);
  }

  let runtimeHealth = health || checkRuntimeHealth(projectRoot);
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
  const currentState = readWorkflowStateInput(stateInput);
  if (!currentState) {
    if (stageId === 'plan') {
      return { allowed: true, stage: stageId, workflowState: null };
    }

    throw new Error(
      `Stage ${stageId} requires authoritative workflow state. ` +
      `Provide --workflow-state or restore ${WORKFLOW_STATE_FILENAME} before continuing.`
    );
  }

  const currentStage = currentState.currentStage;
  const classification = currentState.workflowDecisions?.classification;
  if (!currentStage || !classification || stageId === currentStage) {
    return { allowed: true, stage: stageId, workflowState: currentState };
  }

  const allowedTransitions = getAllowedTransitionsForWorkflowState(currentState);
  if (allowedTransitions.includes(stageId)) {
    return { allowed: true, stage: stageId, workflowState: currentState };
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

  return {
    allowed: true,
    stage: stageId,
    workflowState: currentState,
    override,
  };
}

module.exports = {
  enforceStageEntry,
  getCliFlagValue,
  parseOverride,
  resolveWorkflowStateInput,
  readWorkflowStateFile,
};
