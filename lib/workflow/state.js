'use strict';

const {
  STAGE_IDS,
  STAGE_MODEL,
  assertTransitionAllowed,
  normalizeStageId,
} = require('./stages.js');

const WORKFLOW_STATE_SCHEMA_VERSION = 1;
const WORKFLOW_CLASSIFICATIONS = Object.freeze([
  'critical',
  'standard',
  'simple',
  'hotfix',
  'docs',
  'refactor',
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeStageList(stages) {
  if (!Array.isArray(stages)) {
    return [];
  }

  const normalized = [];
  for (const stage of stages) {
    const stageId = normalizeStageId(stage);
    if (!stageId || normalized.includes(stageId)) {
      continue;
    }
    normalized.push(stageId);
  }

  return normalized;
}

function normalizeParallelTrack(track) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    return null;
  }

  const normalized = {
    name: normalizeString(track.name),
    agent: normalizeString(track.agent),
    status: normalizeString(track.status),
  };

  if (track.worktree && typeof track.worktree === 'object' && !Array.isArray(track.worktree)) {
    normalized.worktree = {
      path: normalizeString(track.worktree.path),
      branch: normalizeString(track.worktree.branch),
    };
  }

  return normalized;
}

function normalizeOverrideRecord(override = {}) {
  const type = normalizeString(override.type || override.kind) || 'manual';
  const fromStage = override.fromStage == null ? null : normalizeStageId(override.fromStage);
  const toStage = override.toStage == null ? null : normalizeStageId(override.toStage);
  const reason = normalizeString(override.reason);
  const actor = normalizeString(override.actor) || 'unknown';
  const recordedAt = normalizeString(override.recordedAt || override.at || override.timestamp) || new Date().toISOString();

  if (override.fromStage != null && !fromStage) {
    throw new Error(`Invalid override fromStage: ${override.fromStage}`);
  }

  if (override.toStage != null && !toStage) {
    throw new Error(`Invalid override toStage: ${override.toStage}`);
  }

  return {
    type,
    fromStage,
    toStage,
    reason,
    actor,
    userOverride: normalizeBoolean(override.userOverride),
    recordedAt,
  };
}

function normalizeWorkflowDecisions(value = {}) {
  const classification = normalizeString(value.classification) || 'standard';
  if (!WORKFLOW_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`Invalid workflow classification: ${value.classification}`);
  }

  const overrides = Array.isArray(value.overrides)
    ? value.overrides.map(normalizeOverrideRecord)
    : [];

  return {
    classification,
    reason: normalizeString(value.reason),
    userOverride: normalizeBoolean(value.userOverride),
    overrides,
  };
}

function normalizeWorkflowState(input = {}) {
  const currentStage = normalizeStageId(input.currentStage);
  if (!currentStage) {
    throw new Error(`Invalid current stage: ${input.currentStage}`);
  }

  const previousStage = input.previousStage == null ? null : normalizeStageId(input.previousStage);
  if (input.previousStage != null && !previousStage) {
    throw new Error(`Invalid previous stage: ${input.previousStage}`);
  }

  if (previousStage) {
    assertTransitionAllowed(previousStage, currentStage);
  }

  const completedStages = normalizeStageList(input.completedStages);
  const skippedStages = normalizeStageList(input.skippedStages);
  const workflowDecisions = normalizeWorkflowDecisions(input.workflowDecisions || {});
  const parallelTracks = Array.isArray(input.parallelTracks)
    ? input.parallelTracks.map(normalizeParallelTrack).filter(Boolean)
    : [];

  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    currentStage,
    completedStages,
    skippedStages,
    workflowDecisions,
    parallelTracks,
  };
}

function serializeWorkflowState(input) {
  if (input && typeof input === 'object' && input.schemaVersion === WORKFLOW_STATE_SCHEMA_VERSION) {
    return normalizeWorkflowState(input);
  }

  return normalizeWorkflowState(input);
}

function readWorkflowState(source) {
  if (source == null) {
    return null;
  }

  if (typeof source === 'string') {
    return normalizeWorkflowState(JSON.parse(source));
  }

  if (typeof source !== 'object') {
    throw new Error('Workflow state source must be a string or object');
  }

  if (source.schemaVersion === WORKFLOW_STATE_SCHEMA_VERSION || source.currentStage) {
    return normalizeWorkflowState(source);
  }

  if (source.workflowState) {
    return normalizeWorkflowState(source.workflowState);
  }

  if (source.metadata && source.metadata.workflowState) {
    return normalizeWorkflowState(source.metadata.workflowState);
  }

  return normalizeWorkflowState(source);
}

function writeWorkflowState(input) {
  const payload = input && typeof input === 'object' && input.schemaVersion === WORKFLOW_STATE_SCHEMA_VERSION
    ? normalizeWorkflowState(input)
    : serializeWorkflowState(input);

  return JSON.stringify(payload, null, 2);
}

module.exports = {
  WORKFLOW_STATE_SCHEMA_VERSION,
  WORKFLOW_CLASSIFICATIONS,
  normalizeOverrideRecord,
  normalizeWorkflowDecisions,
  normalizeWorkflowState,
  serializeWorkflowState,
  readWorkflowState,
  writeWorkflowState,
  STAGE_IDS,
  STAGE_MODEL,
};
