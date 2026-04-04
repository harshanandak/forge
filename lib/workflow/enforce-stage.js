'use strict';

const { repairWorkflowRuntimeAssets } = require('../commands/setup');
const { checkRuntimeHealth } = require('../runtime-health');
const { getAllowedTransitions, normalizeStageId } = require('./stages');
const { normalizeOverrideRecord, readWorkflowState } = require('./state');

function getOverrideInput(flags = {}) {
  if (Object.prototype.hasOwnProperty.call(flags, 'overrideStage')) {
    return flags.overrideStage;
  }
  if (Object.prototype.hasOwnProperty.call(flags, '--override-stage')) {
    return flags['--override-stage'];
  }
  return null;
}

function parseOverride(flags = {}) {
  const input = getOverrideInput(flags);
  if (!input) {
    return null;
  }

  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  return normalizeOverrideRecord(parsed);
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

async function enforceStageEntry({ commandName, flags = {}, projectRoot, workflowState, health, repairRuntime } = {}) {
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

  const stateInput = workflowState || flags.workflowState || flags['--workflow-state'];
  const currentState = readWorkflowStateInput(stateInput);
  if (!currentState) {
    return { allowed: true, stage: stageId, workflowState: null };
  }

  const currentStage = currentState.currentStage;
  const classification = currentState.workflowDecisions?.classification;
  if (!currentStage || !classification || stageId === currentStage) {
    return { allowed: true, stage: stageId, workflowState: currentState };
  }

  const allowedTransitions = getAllowedTransitions(currentStage, classification);
  if (allowedTransitions.includes(stageId)) {
    return { allowed: true, stage: stageId, workflowState: currentState };
  }

  const override = parseOverride(flags);
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
  parseOverride,
};
