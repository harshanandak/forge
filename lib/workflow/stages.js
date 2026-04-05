'use strict';

const WORKFLOW_CLASSIFICATIONS = Object.freeze([
	'critical',
	'standard',
	'refactor',
	'simple',
	'hotfix',
	'docs',
]);

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

const WORKFLOW_STAGE_MATRIX = Object.freeze({
	critical: Object.freeze(['plan', 'dev', 'validate', 'ship', 'review', 'premerge', 'verify']),
	standard: Object.freeze(['plan', 'dev', 'validate', 'ship', 'review', 'premerge']),
	refactor: Object.freeze(['plan', 'dev', 'validate', 'ship', 'premerge']),
	simple: Object.freeze(['dev', 'validate', 'ship']),
	hotfix: Object.freeze(['dev', 'validate', 'ship']),
	// Docs-only work intentionally reuses /verify as a pre-ship content check to
	// keep the existing lightweight docs path, even though /verify is post-merge
	// everywhere else in the full workflow.
	docs: Object.freeze(['verify', 'ship']),
});

const WORKFLOW_TERMINAL_STAGES = Object.freeze(Object.entries(WORKFLOW_STAGE_MATRIX).reduce((accumulator, [classification, path]) => {
	accumulator[classification] = path.at(-1);
	return accumulator;
}, {}));

function normalizeClassification(classification) {
	return typeof classification === 'string' && Object.hasOwn(WORKFLOW_STAGE_MATRIX, classification)
		? classification
		: null;
}

function normalizeStageId(stageId) {
	return typeof stageId === 'string' && Object.hasOwn(STAGE_LABELS, stageId)
		? stageId
		: null;
}

function isCanonicalStageId(stageId) {
	return normalizeStageId(stageId) !== null;
}

function getWorkflowPath(classification) {
	const normalized = normalizeClassification(classification);
	return normalized ? WORKFLOW_STAGE_MATRIX[normalized] : Object.freeze([]);
}

function getStageWorkflow(stageId, classification) {
	const normalizedStage = normalizeStageId(stageId);
	const normalizedClassification = normalizeClassification(classification);

	if (!normalizedStage || !normalizedClassification) {
		return null;
	}

	const path = WORKFLOW_STAGE_MATRIX[normalizedClassification];
	const order = path.indexOf(normalizedStage);

	if (order === -1) {
		return null;
	}

	const nextStages = order < path.length - 1 ? Object.freeze([path[order + 1]]) : Object.freeze([]);

	return {
		classification: normalizedClassification,
		order: order + 1,
		nextStages,
		terminal: order === path.length - 1,
	};
}

function getAllowedTransitions(stageId, classification) {
	const workflow = getStageWorkflow(stageId, classification);
	return workflow ? workflow.nextStages : Object.freeze([]);
}

function canTransition(fromStageId, toStageId, classification) {
	const normalizedClassification = normalizeClassification(classification);
	const fromStage = normalizeStageId(fromStageId);
	const toStage = normalizeStageId(toStageId);

	if (!normalizedClassification || !fromStage || !toStage) {
		return false;
	}

	const path = WORKFLOW_STAGE_MATRIX[normalizedClassification];
	const fromIndex = path.indexOf(fromStage);
	if (fromIndex === -1 || fromIndex === path.length - 1) {
		return false;
	}

	return path[fromIndex + 1] === toStage;
}

function isTerminalStage(stageId, classification) {
	const workflow = getStageWorkflow(stageId, classification);
	return workflow ? workflow.terminal : false;
}

function assertTransitionAllowed(fromStageId, toStageId, classification) {
	if (canTransition(fromStageId, toStageId, classification)) {
		return true;
	}

	const fromStage = normalizeStageId(fromStageId) || String(fromStageId);
	const toStage = normalizeStageId(toStageId) || String(toStageId);
	const normalizedClassification = normalizeClassification(classification) || 'unknown';
	const allowed = getAllowedTransitions(fromStageId, classification);
	const suffix = allowed.length > 0 ? ` Allowed next stages: ${allowed.join(', ')}.` : '';

	throw new Error(`Invalid workflow transition: ${fromStage} -> ${toStage} for ${normalizedClassification} workflow.${suffix}`);
}

const STAGE_MODEL = Object.freeze(STAGE_IDS.reduce((accumulator, stageId) => {
	const workflows = {};

	for (const classification of WORKFLOW_CLASSIFICATIONS) {
		const workflow = getStageWorkflow(stageId, classification);
		if (!workflow) {
			continue;
		}

		workflows[classification] = Object.freeze({
			order: workflow.order,
			nextStages: workflow.nextStages,
			terminal: workflow.terminal,
		});
	}

	accumulator[stageId] = Object.freeze({
		id: stageId,
		label: STAGE_LABELS[stageId],
		command: STAGE_COMMANDS[stageId],
		workflows: Object.freeze(workflows),
	});

	return accumulator;
}, {}));

const STAGE_TRANSITIONS = Object.freeze(STAGE_IDS.reduce((accumulator, stageId) => {
	accumulator[stageId] = Object.freeze(
		WORKFLOW_CLASSIFICATIONS.reduce((workflowMap, classification) => {
			workflowMap[classification] = getAllowedTransitions(stageId, classification);
			return workflowMap;
		}, {}),
	);
	return accumulator;
}, {}));

module.exports = {
	WORKFLOW_CLASSIFICATIONS,
	STAGE_IDS,
	STAGE_LABELS,
	STAGE_COMMANDS,
	WORKFLOW_STAGE_MATRIX,
	WORKFLOW_TERMINAL_STAGES,
	STAGE_TRANSITIONS,
	STAGE_MODEL,
	normalizeClassification,
	normalizeStageId,
	isCanonicalStageId,
	getWorkflowPath,
	getStageWorkflow,
	getAllowedTransitions,
	canTransition,
	isTerminalStage,
	assertTransitionAllowed,
};
