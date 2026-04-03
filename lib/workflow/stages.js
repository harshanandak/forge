'use strict';

const STAGE_IDS = Object.freeze([
  'plan',
  'dev',
  'validate',
  'ship',
  'review',
  'premerge',
  'verify',
]);

const STAGE_LABELS = Object.freeze({
  plan: 'Plan',
  dev: 'Dev',
  validate: 'Validate',
  ship: 'Ship',
  review: 'Review',
  premerge: 'Premerge',
  verify: 'Verify',
});

const STAGE_COMMANDS = Object.freeze({
  plan: '/plan',
  dev: '/dev',
  validate: '/validate',
  ship: '/ship',
  review: '/review',
  premerge: '/premerge',
  verify: '/verify',
});

const STAGE_TRANSITIONS = Object.freeze({
  plan: Object.freeze(['dev']),
  dev: Object.freeze(['validate']),
  validate: Object.freeze(['ship']),
  ship: Object.freeze(['review']),
  review: Object.freeze(['premerge']),
  premerge: Object.freeze(['verify']),
  verify: Object.freeze([]),
});

const STAGE_MODEL = Object.freeze(STAGE_IDS.reduce((accumulator, stageId, index) => {
  accumulator[stageId] = Object.freeze({
    id: stageId,
    order: index + 1,
    label: STAGE_LABELS[stageId],
    command: STAGE_COMMANDS[stageId],
    nextStages: STAGE_TRANSITIONS[stageId],
  });
  return accumulator;
}, {}));

function normalizeStageId(stageId) {
  return typeof stageId === 'string' && Object.prototype.hasOwnProperty.call(STAGE_MODEL, stageId)
    ? stageId
    : null;
}

function isCanonicalStageId(stageId) {
  return normalizeStageId(stageId) !== null;
}

function getAllowedTransitions(stageId) {
  const normalized = normalizeStageId(stageId);
  return normalized ? STAGE_TRANSITIONS[normalized] : Object.freeze([]);
}

function canTransition(fromStageId, toStageId) {
  const fromStage = normalizeStageId(fromStageId);
  const toStage = normalizeStageId(toStageId);

  if (!fromStage || !toStage) {
    return false;
  }

  return STAGE_TRANSITIONS[fromStage].includes(toStage);
}

function assertTransitionAllowed(fromStageId, toStageId) {
  if (canTransition(fromStageId, toStageId)) {
    return true;
  }

  const fromStage = normalizeStageId(fromStageId) || String(fromStageId);
  const toStage = normalizeStageId(toStageId) || String(toStageId);
  const allowed = getAllowedTransitions(fromStageId);
  const suffix = allowed.length > 0 ? ` Allowed next stages: ${allowed.join(', ')}.` : '';

  throw new Error(`Invalid workflow transition: ${fromStage} -> ${toStage}.${suffix}`);
}

module.exports = {
  STAGE_IDS,
  STAGE_LABELS,
  STAGE_COMMANDS,
  STAGE_TRANSITIONS,
  STAGE_MODEL,
  normalizeStageId,
  isCanonicalStageId,
  getAllowedTransitions,
  canTransition,
  assertTransitionAllowed,
};
