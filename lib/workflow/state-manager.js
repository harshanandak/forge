'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { secureExecFileSync } = require('../shell-utils.js');
const { readWorkflowState, serializeWorkflowState, WORKFLOW_STATE_SCHEMA_VERSION, getAllowedTransitionsForWorkflowState } = require('./state.js');
const { getWorkflowPath, WORKFLOW_CLASSIFICATIONS, normalizeStageId } = require('./stages.js');

const WORKFLOW_STATE_FILENAME = '.forge-state.json';

function extractWorkflowStateFromComments(comments = '') {
  const matches = String(comments).match(/^WorkflowState:\s*(\{.*\})$/gm);
  if (!matches || matches.length === 0) {
    return null;
  }

  const latest = matches.at(-1).replace(/^WorkflowState:\s*/, '');
  return readWorkflowState(latest);
}

function readWorkflowStateFromBeads(issueId, options = {}) {
  if (!issueId) {
    return null;
  }

  const comments = options.comments || secureExecFileSync('bd', ['comments', 'list', issueId], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (!comments) {
    return null;
  }

  return extractWorkflowStateFromComments(comments);
}

function loadState(projectRoot, options = {}) {
  if (!projectRoot) {
    return { state: null, source: null };
  }

  const statePath = path.join(projectRoot, WORKFLOW_STATE_FILENAME);
  if (fs.existsSync(statePath)) {
    const raw = fs.readFileSync(statePath, 'utf8');
    return { state: readWorkflowState(raw), source: 'file' };
  }

  if (options.comments) {
    const state = extractWorkflowStateFromComments(options.comments);
    if (state) {
      return { state, source: 'beads' };
    }
  }

  return { state: null, source: null };
}

function saveState(projectRoot, state) {
  const normalized = serializeWorkflowState(state);
  const json = JSON.stringify(normalized, null, 2);
  const tmpPath = path.join(projectRoot, `${WORKFLOW_STATE_FILENAME}.tmp`);
  const statePath = path.join(projectRoot, WORKFLOW_STATE_FILENAME);

  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, statePath);

  return normalized;
}

function initializeState(projectRoot, classification, firstStage) {
  if (!WORKFLOW_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`Invalid classification: ${classification}. Expected one of: ${WORKFLOW_CLASSIFICATIONS.join(', ')}`);
  }

  const workflowPath = getWorkflowPath(classification);
  const currentStage = firstStage || workflowPath[0];

  const state = {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    currentStage,
    completedStages: [],
    skippedStages: [],
    workflowDecisions: {
      classification,
      reason: 'initialized',
      userOverride: false,
      overrides: [],
    },
    parallelTracks: [],
  };

  return saveState(projectRoot, state);
}

function transitionStage(projectRoot, toStage, options = {}) {
  const targetStage = normalizeStageId(toStage);
  if (!targetStage) {
    throw new Error(`Invalid target stage: ${toStage}`);
  }

  const { state: currentState } = loadState(projectRoot, options);
  if (!currentState) {
    throw new Error('No workflow state found. Initialize state first with initializeState().');
  }

  const previousState = { ...currentState };
  const allowed = getAllowedTransitionsForWorkflowState(currentState);

  if (!allowed.includes(targetStage)) {
    if (!options.override) {
      throw new Error(
        `Transition from ${currentState.currentStage} to ${targetStage} is not allowed. ` +
        `Allowed transitions: ${allowed.join(', ') || 'none'}. Provide an override to force.`
      );
    }
  }

  const completedStages = [...currentState.completedStages];
  if (!completedStages.includes(currentState.currentStage)) {
    completedStages.push(currentState.currentStage);
  }

  const overrides = [...(currentState.workflowDecisions.overrides || [])];
  if (options.override) {
    overrides.push({
      type: options.override.type || 'manual',
      fromStage: options.override.fromStage || currentState.currentStage,
      toStage: options.override.toStage || targetStage,
      reason: options.override.reason || '',
      actor: options.override.actor || 'unknown',
      userOverride: true,
      recordedAt: new Date().toISOString(),
    });
  }

  const newStateInput = {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    currentStage: targetStage,
    completedStages,
    skippedStages: currentState.skippedStages || [],
    workflowDecisions: {
      ...currentState.workflowDecisions,
      overrides,
      userOverride: overrides.length > 0,
    },
    parallelTracks: currentState.parallelTracks || [],
  };

  const newState = saveState(projectRoot, newStateInput);

  return {
    previousState,
    newState,
    transitioned: true,
  };
}

module.exports = {
  WORKFLOW_STATE_FILENAME,
  extractWorkflowStateFromComments,
  initializeState,
  loadState,
  readWorkflowStateFromBeads,
  saveState,
  transitionStage,
};
