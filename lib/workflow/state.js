'use strict';

const {
  WORKFLOW_CLASSIFICATIONS,
  STAGE_IDS,
  STAGE_MODEL,
  getWorkflowPath,
  normalizeStageId,
} = require('./stages.js');

const WORKFLOW_STATE_SCHEMA_VERSION = 2;
const LEGACY_STANDARD_VERIFY = Symbol('legacy-standard-verify');
const LEGACY_STANDARD_WORKFLOW_PATH = Object.freeze([
  'plan',
  'dev',
  'validate',
  'ship',
  'review',
  'premerge',
  'verify',
]);
const LEGACY_WORKFLOW_STATE_OPTIONS = Object.freeze({
  allowLegacyDefaultClassification: true,
  allowLegacyStandardVerify: true,
  allowLegacyOverrideRecords: true,
});

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

function normalizeOverrideRecord(override = {}, options = {}) {
  const type = normalizeString(override.type || override.kind) || 'manual';
  const fromStage = override.fromStage == null ? null : normalizeStageId(override.fromStage);
  const toStage = override.toStage == null ? null : normalizeStageId(override.toStage);
  const reason = normalizeString(override.reason);
  const actor = normalizeString(override.actor) || 'unknown';
  const recordedAt = normalizeString(override.recordedAt || override.at || override.timestamp) || new Date().toISOString();

  if (!type) {
    throw new Error('Override record must include a type');
  }

  if (!options.allowLegacyOverrideRecords && (!fromStage || !toStage || !reason)) {
    throw new Error('Override record must include fromStage, toStage, and a non-empty reason');
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

function normalizeWorkflowOverrides(value = {}, options = {}) {
  const overrides = Array.isArray(value.overrides)
    ? value.overrides.map(override => normalizeOverrideRecord(override, options))
    : [];
  const userOverride = normalizeBoolean(value.userOverride);

  if (userOverride && overrides.length === 0) {
    throw new Error('workflowDecisions.userOverride requires at least one override record');
  }

  return {
    overrides,
    userOverride: overrides.length > 0 || userOverride,
  };
}

function buildWorkflowDecisions(classification, value, overrideState) {
  return {
    classification,
    reason: normalizeString(value.reason),
    userOverride: overrideState.userOverride,
    overrides: overrideState.overrides,
  };
}

function normalizeWorkflowDecisions(value = {}, options = {}) {
  const hasClassification = value && typeof value === 'object'
    ? Object.hasOwn(value, 'classification')
    : false;
  const classification = normalizeString(value.classification);
  const overrideState = normalizeWorkflowOverrides(value, options);

  if (!classification) {
    if (options.allowLegacyDefaultClassification && !hasClassification) {
      return buildWorkflowDecisions('standard', value, overrideState);
    }

    throw new Error(
      'Workflow state is missing a classification field. Delete .forge-state.json to reset, or add "classification": "standard" manually.'
    );
  }

  if (!WORKFLOW_CLASSIFICATIONS.includes(classification)) {
    throw new Error(
      `Invalid workflow classification: ${value.classification}. Expected one of: ${WORKFLOW_CLASSIFICATIONS.join(', ')}`
    );
  }

  return buildWorkflowDecisions(classification, value, overrideState);
}

function shouldUseLegacyStandardVerifyPath(classification, input, options = {}) {
  const legacyBySchema = input.schemaVersion == null
    ? options.treatMissingSchemaAsCurrent !== true
    : input.schemaVersion < WORKFLOW_STATE_SCHEMA_VERSION;

  return (
    options.allowLegacyStandardVerify === true &&
    classification === 'standard' &&
    (
      input[LEGACY_STANDARD_VERIFY] === true ||
      legacyBySchema
    )
  );
}

function assertWorkflowPathTransition(previousStage, currentStage, workflowPath, classification) {
  const previousIndex = workflowPath.indexOf(previousStage);
  const currentIndex = workflowPath.indexOf(currentStage);
  const allowed = previousIndex === -1 || previousIndex === workflowPath.length - 1
    ? []
    : [workflowPath[previousIndex + 1]];

  if (previousIndex !== -1 && currentIndex === previousIndex + 1) {
    return true;
  }

  const suffix = allowed.length > 0 ? ` Allowed next stages: ${allowed.join(', ')}.` : '';
  throw new Error(
    `Invalid workflow transition: ${previousStage} -> ${currentStage} for ${classification} workflow.${suffix}`
  );
}

function normalizeWorkflowState(input = {}, options = {}) {
  const currentStage = normalizeStageId(input.currentStage);
  if (!currentStage) {
    throw new Error(`Invalid current stage: ${input.currentStage}`);
  }

  const workflowDecisions = normalizeWorkflowDecisions(input.workflowDecisions || {}, options);
  const useLegacyStandardVerify = shouldUseLegacyStandardVerifyPath(
    workflowDecisions.classification,
    input,
    options
  );
  const workflowPath = useLegacyStandardVerify
    ? LEGACY_STANDARD_WORKFLOW_PATH
    : getWorkflowPath(workflowDecisions.classification);

  const previousStage = input.previousStage == null ? null : normalizeStageId(input.previousStage);
  if (input.previousStage != null && !previousStage) {
    throw new Error(`Invalid previous stage: ${input.previousStage}`);
  }

  if (!workflowPath.includes(currentStage)) {
    throw new Error(`Stage ${currentStage} is not valid for ${workflowDecisions.classification} workflow`);
  }

  if (previousStage) {
    assertWorkflowPathTransition(previousStage, currentStage, workflowPath, workflowDecisions.classification);
  }

  const completedStages = normalizeStageList(input.completedStages);
  const skippedStages = normalizeStageList(input.skippedStages);
  const invalidCompletedStage = completedStages.find(stage => !workflowPath.includes(stage));
  if (invalidCompletedStage) {
    throw new Error(`Completed stage ${invalidCompletedStage} is not valid for ${workflowDecisions.classification} workflow`);
  }
  const invalidSkippedStage = skippedStages.find(stage => !workflowPath.includes(stage));
  if (invalidSkippedStage) {
    throw new Error(`Skipped stage ${invalidSkippedStage} is not valid for ${workflowDecisions.classification} workflow`);
  }
  const parallelTracks = Array.isArray(input.parallelTracks)
    ? input.parallelTracks.map(normalizeParallelTrack).filter(Boolean)
    : [];

  const payload = {
    schemaVersion: useLegacyStandardVerify ? 1 : WORKFLOW_STATE_SCHEMA_VERSION,
    currentStage,
    completedStages,
    skippedStages,
    workflowDecisions,
    parallelTracks,
  };

  if (useLegacyStandardVerify) {
    Object.defineProperty(payload, LEGACY_STANDARD_VERIFY, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  return payload;
}

function serializeWorkflowState(input) {
  return normalizeWorkflowState(input, {
    ...LEGACY_WORKFLOW_STATE_OPTIONS,
    treatMissingSchemaAsCurrent: true,
  });
}

function readWorkflowState(source) {
  if (source == null) {
    return null;
  }

  if (typeof source === 'string') {
    try {
      return normalizeWorkflowState(JSON.parse(source), LEGACY_WORKFLOW_STATE_OPTIONS);
    } catch (error) {
      throw new Error(`Failed to parse workflow state: ${error.message}`);
    }
  }

  if (typeof source !== 'object') {
    throw new Error('Workflow state source must be a string or object');
  }

  if (source.schemaVersion === WORKFLOW_STATE_SCHEMA_VERSION || source.currentStage) {
    return normalizeWorkflowState(source, LEGACY_WORKFLOW_STATE_OPTIONS);
  }

  if (source.workflowState) {
    return normalizeWorkflowState(source.workflowState, LEGACY_WORKFLOW_STATE_OPTIONS);
  }

  if (source.metadata && source.metadata.workflowState) {
    return normalizeWorkflowState(source.metadata.workflowState, LEGACY_WORKFLOW_STATE_OPTIONS);
  }

  return normalizeWorkflowState(source, LEGACY_WORKFLOW_STATE_OPTIONS);
}

function writeWorkflowState(input) {
  const payload = serializeWorkflowState(input);

  return JSON.stringify(payload, null, 2);
}

function getWorkflowPathForState(workflowState) {
  if (!workflowState || typeof workflowState !== 'object') {
    return Object.freeze([]);
  }

  return workflowState[LEGACY_STANDARD_VERIFY]
    ? LEGACY_STANDARD_WORKFLOW_PATH
    : getWorkflowPath(workflowState.workflowDecisions?.classification);
}

function getAllowedTransitionsForWorkflowState(workflowState) {
  const currentStage = normalizeStageId(workflowState?.currentStage);
  if (!currentStage) {
    return Object.freeze([]);
  }

  const workflowPath = getWorkflowPathForState(workflowState);
  const currentIndex = workflowPath.indexOf(currentStage);
  if (currentIndex === -1 || currentIndex === workflowPath.length - 1) {
    return Object.freeze([]);
  }

  return Object.freeze([workflowPath[currentIndex + 1]]);
}

module.exports = {
  getAllowedTransitionsForWorkflowState,
  getWorkflowPathForState,
  LEGACY_STANDARD_VERIFY,
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
