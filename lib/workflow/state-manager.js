'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { secureExecFileSync } = require('../shell-utils.js');
const { readWorkflowState, serializeWorkflowState, WORKFLOW_STATE_SCHEMA_VERSION, getAllowedTransitionsForWorkflowState } = require('./state.js');
const { getWorkflowPath, WORKFLOW_CLASSIFICATIONS, normalizeStageId } = require('./stages.js');

const WORKFLOW_STATE_FILENAME = '.forge-state.json';

function parseRelaxedWorkflowStatePayload(payload = '') {
  const currentStage = String(payload).match(/currentStage:([a-z]+)/)?.[1];
  if (!currentStage) {
    return null;
  }

  const completedStages = (String(payload).match(/completedStages:\[([^\]]*)\]/)?.[1] || '')
    .split(',')
    .map(stage => stage.trim())
    .filter(Boolean);
  const skippedStages = (String(payload).match(/skippedStages:\[([^\]]*)\]/)?.[1] || '')
    .split(',')
    .map(stage => stage.trim())
    .filter(Boolean);
  const classification = String(payload).match(/classification:([a-z]+)/)?.[1] || 'standard';
  const reason = String(payload).match(/reason:([^,}\]]+)/)?.[1]?.trim() || 'legacy-comment';

  return readWorkflowState(JSON.stringify({
    currentStage,
    completedStages,
    skippedStages,
    workflowDecisions: {
      classification,
      reason,
      userOverride: false,
      overrides: [],
    },
    parallelTracks: [],
  }));
}

function extractWorkflowStateFromComments(comments = '') {
  const matches = String(comments)
    .split(/\r?\n/)
    .filter(line => line.startsWith('WorkflowState:'));
  if (!matches || matches.length === 0) {
    return null;
  }

  for (const match of [...matches].reverse()) {
    const payload = match.replace(/^WorkflowState:\s*/, '');
    try {
      return readWorkflowState(payload);
    } catch (_strictError) {
      try {
        const relaxedState = parseRelaxedWorkflowStatePayload(payload);
        if (relaxedState) {
          return relaxedState;
        }
      } catch (_relaxedError) {
        // Continue to any earlier payloads.
      }
    }
  }

  return null;
}

function extractWorkflowStateFromIssue(issue = {}) {
  if (!issue || typeof issue !== 'object') {
    return null;
  }

  if (typeof issue.comments === 'string') {
    return extractWorkflowStateFromComments(issue.comments);
  }

  if (!Array.isArray(issue.comments) || issue.comments.length === 0) {
    return null;
  }

  const mergedComments = issue.comments
    .map(comment => {
      if (typeof comment === 'string') {
        return comment;
      }

      return comment && typeof comment === 'object' ? comment.text || '' : '';
    })
    .filter(Boolean)
    .join('\n');

  if (!mergedComments) {
    return null;
  }

  return extractWorkflowStateFromComments(mergedComments);
}

function readBeadsIssue(issueId, options = {}) {
  if (!issueId) {
    return null;
  }

  try {
    const { projectRoot, ...execOptions } = options;
    const raw = secureExecFileSync('bd', ['show', issueId, '--json'], {
      encoding: 'utf8',
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...execOptions,
    }).trim();

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed[0] || null;
    }

    return parsed;
  } catch (_error) {
    return null;
  }
}

function readWorkflowStateFromBeads(issueId, options = {}) {
  if (!issueId) {
    return null;
  }

  if (options.issue) {
    const state = extractWorkflowStateFromIssue(options.issue);
    if (state) {
      return state;
    }
  }

  let comments = options.comments;
  if (!comments) {
    try {
      const issue = readBeadsIssue(issueId, { projectRoot: options.projectRoot });
      const state = extractWorkflowStateFromIssue(issue);
      if (state) {
        return state;
      }
    } catch (_error) {
      // Fall through to comments-list fallback.
    }
  }

  comments = comments || secureExecFileSync('bd', ['comments', 'list', issueId], {
    encoding: 'utf8',
    cwd: options.projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (!comments) {
    return null;
  }

  return extractWorkflowStateFromComments(comments);
}

function loadStateFromBeads(options, projectRoot) {
  if (options.comments) {
    const state = extractWorkflowStateFromComments(options.comments);
    if (state) {
      return { state, source: 'beads' };
    }
  }

  if (options.issue) {
    const state = extractWorkflowStateFromIssue(options.issue);
    if (state) {
      return { state, source: 'beads' };
    }
  }

  if (options.issueId) {
    const state = readWorkflowStateFromBeads(options.issueId, {
      comments: options.comments,
      issue: options.issue,
      projectRoot,
    });
    if (state) {
      return { state, source: 'beads' };
    }
  }

  return null;
}

function loadState(projectRoot, options = {}) {
  if (!projectRoot) {
    const beadsResult = loadStateFromBeads(options, null);
    return beadsResult || { state: null, source: null };
  }

  if (options.preferBeads && (options.comments || options.issue || options.issueId)) {
    const beadsResult = loadStateFromBeads(options, projectRoot);
    if (beadsResult) {
      return beadsResult;
    }
  }

  const statePath = path.join(projectRoot, WORKFLOW_STATE_FILENAME);
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      return { state: readWorkflowState(raw), source: 'file' };
    } catch (_parseError) {
      // File is malformed — fall through to Beads fallback
    }
  }

  const beadsResult = loadStateFromBeads(options, projectRoot);
  if (beadsResult) {
    return beadsResult;
  }

  return { state: null, source: null };
}

function saveState(projectRoot, state) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('saveState requires a valid projectRoot path');
  }

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

  const previousState = JSON.parse(JSON.stringify(currentState));
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
      fromStage: currentState.currentStage,
      toStage: targetStage,
      reason: options.override.reason || '',
      actor: options.override.actor || 'unknown',
      userOverride: true,
      recordedAt: new Date().toISOString(),
    });
  }

  const newStateInput = {
    schemaVersion: currentState.schemaVersion || WORKFLOW_STATE_SCHEMA_VERSION,
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
  extractWorkflowStateFromIssue,
  initializeState,
  loadState,
  readBeadsIssue,
  readWorkflowStateFromBeads,
  saveState,
  transitionStage,
};
