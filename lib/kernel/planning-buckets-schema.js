'use strict';

const { cloneTableList, deepFreeze, field, index, table, validateKernelSchema } = require('./schema');

// Planning buckets are first-class entities, not string fields on issues (D5/D18,
// forge-2agy.9.2.7). Sprint/release/milestone each carry id, name, state, dates,
// owner/goal, ordering rank, completion rollups, and an entity revision.
const SPRINT_STATES = Object.freeze(['planned', 'active', 'completed', 'cancelled']);
const RELEASE_STATES = Object.freeze(['planned', 'in_progress', 'released', 'cancelled']);
const MILESTONE_STATES = Object.freeze(['planned', 'reached', 'missed', 'cancelled']);

// Board drag/drop and assignment operations emit Kernel events carrying
// expected_revision + idempotency_key (board rank / mutation event model,
// forge-2agy.9.2.6). See docs/reference/KERNEL_TAXONOMY_VALIDATION.md.
const BOARD_MUTATION_EVENT_TYPES = Object.freeze([
	'issue.reordered',
	'issue.status_changed',
	'issue.sprint_assigned',
	'issue.release_assigned',
	'issue.blocked',
	'issue.unblocked',
	'issue.type_changed',
]);

const ROLLUP = Object.freeze({ storageClass: 'read_model' });

const PLANNING_BUCKET_TABLE_LIST = deepFreeze([
	table('sprint', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('name', 'TEXT', { notNull: true }),
		field('state', 'TEXT', { notNull: true, default: "'planned'" }),
		field('goal', 'TEXT'),
		field('owner', 'TEXT'),
		field('start_date', 'TEXT'),
		field('end_date', 'TEXT'),
		field('capacity', 'INTEGER'),
		field('rank', 'INTEGER', { notNull: true, default: '0' }),
		field('total_count', 'INTEGER', { notNull: true, default: '0', ...ROLLUP }),
		field('completed_count', 'INTEGER', { notNull: true, default: '0', ...ROLLUP }),
		field('created_at', 'TEXT', { notNull: true }),
		field('updated_at', 'TEXT', { notNull: true }),
		field('entity_revision', 'INTEGER', { notNull: true, default: '0' }),
	], [
		index('idx_kernel_sprint_state', ['state']),
		index('idx_kernel_sprint_rank', ['rank']),
	]),
	table('release', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('name', 'TEXT', { notNull: true }),
		field('state', 'TEXT', { notNull: true, default: "'planned'" }),
		field('goal', 'TEXT'),
		field('owner', 'TEXT'),
		field('target_date', 'TEXT'),
		field('released_at', 'TEXT'),
		field('rank', 'INTEGER', { notNull: true, default: '0' }),
		field('total_count', 'INTEGER', { notNull: true, default: '0', ...ROLLUP }),
		field('completed_count', 'INTEGER', { notNull: true, default: '0', ...ROLLUP }),
		field('created_at', 'TEXT', { notNull: true }),
		field('updated_at', 'TEXT', { notNull: true }),
		field('entity_revision', 'INTEGER', { notNull: true, default: '0' }),
	], [
		index('idx_kernel_release_state', ['state']),
		index('idx_kernel_release_rank', ['rank']),
	]),
	table('milestone', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('name', 'TEXT', { notNull: true }),
		field('state', 'TEXT', { notNull: true, default: "'planned'" }),
		field('release_id', 'TEXT'),
		field('goal', 'TEXT'),
		field('owner', 'TEXT'),
		field('target_date', 'TEXT'),
		field('reached_at', 'TEXT'),
		field('rank', 'INTEGER', { notNull: true, default: '0' }),
		field('total_count', 'INTEGER', { notNull: true, default: '0', ...ROLLUP }),
		field('completed_count', 'INTEGER', { notNull: true, default: '0', ...ROLLUP }),
		field('created_at', 'TEXT', { notNull: true }),
		field('updated_at', 'TEXT', { notNull: true }),
		field('entity_revision', 'INTEGER', { notNull: true, default: '0' }),
	], [
		index('idx_kernel_milestone_state', ['state']),
		index('idx_kernel_milestone_release', ['release_id']),
	]),
]);

const PLANNING_BUCKET_TABLES = deepFreeze(
	Object.fromEntries(PLANNING_BUCKET_TABLE_LIST.map(definition => [definition.name, definition])),
);

function getPlanningBucketsSchema() {
	return {
		version: 1,
		tables: cloneTableList(PLANNING_BUCKET_TABLE_LIST),
	};
}

function validatePlanningBucketsSchema(schema = getPlanningBucketsSchema()) {
	return validateKernelSchema(schema);
}

module.exports = {
	BOARD_MUTATION_EVENT_TYPES,
	MILESTONE_STATES,
	PLANNING_BUCKET_TABLES,
	RELEASE_STATES,
	SPRINT_STATES,
	getPlanningBucketsSchema,
	validatePlanningBucketsSchema,
};
