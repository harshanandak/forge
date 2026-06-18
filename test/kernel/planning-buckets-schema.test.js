const { describe, expect, test } = require('bun:test');

const { buildSchemaMigration } = require('../../lib/kernel/migrations');
const {
	PLANNING_BUCKET_TABLES,
	SPRINT_STATES,
	RELEASE_STATES,
	MILESTONE_STATES,
	BOARD_MUTATION_EVENT_TYPES,
	getPlanningBucketsSchema,
	validatePlanningBucketsSchema,
} = require('../../lib/kernel/planning-buckets-schema');

describe('planning bucket entities (forge-2agy.9.2.7)', () => {
	test('defines sprint, release, and milestone entity tables', () => {
		expect(PLANNING_BUCKET_TABLES.sprint).toBeDefined();
		expect(PLANNING_BUCKET_TABLES.release).toBeDefined();
		expect(PLANNING_BUCKET_TABLES.milestone).toBeDefined();
		expect(PLANNING_BUCKET_TABLES.sprint.sqlName).toBe('kernel_sprint');
	});

	test('each bucket carries id, name, state, ordering, rollup, and revision', () => {
		for (const name of ['sprint', 'release', 'milestone']) {
			const fields = PLANNING_BUCKET_TABLES[name].fields.map(field => field.name);
			expect(fields).toContain('id');
			expect(fields).toContain('name');
			expect(fields).toContain('state');
			expect(fields).toContain('rank');
			expect(fields).toContain('entity_revision');
			// rollup read-model counters
			expect(fields).toContain('total_count');
			expect(fields).toContain('completed_count');
		}
	});

	test('every bucket carries an owner field for parity', () => {
		for (const name of ['sprint', 'release', 'milestone']) {
			const fields = PLANNING_BUCKET_TABLES[name].fields.map(field => field.name);
			expect(fields).toContain('owner');
		}
	});

	test('marks rollup counters as derived read-model storage', () => {
		const total = PLANNING_BUCKET_TABLES.sprint.fields.find(field => field.name === 'total_count');
		expect(total.storageClass).toBe('read_model');
	});

	test('exposes bucket state vocabularies', () => {
		expect(SPRINT_STATES).toContain('active');
		expect(RELEASE_STATES).toContain('released');
		expect(MILESTONE_STATES).toContain('reached');
	});

	test('passes the shared Kernel schema validator', () => {
		expect(validatePlanningBucketsSchema()).toBe(true);
	});

	test('returns isolated, migration-renderable schema definitions', () => {
		const schema = getPlanningBucketsSchema();
		schema.tables[0].fields[0].name = 'mutated';
		expect(getPlanningBucketsSchema().tables[0].fields[0].name).toBe('id');

		const migration = buildSchemaMigration(getPlanningBucketsSchema());
		const sql = migration.apply.join('\n');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS kernel_sprint');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS kernel_release');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS kernel_milestone');
	});

	test('defines the board rank mutation event vocabulary', () => {
		for (const eventType of [
			'issue.reordered',
			'issue.status_changed',
			'issue.sprint_assigned',
			'issue.release_assigned',
			'issue.blocked',
			'issue.unblocked',
			'issue.type_changed',
		]) {
			expect(BOARD_MUTATION_EVENT_TYPES).toContain(eventType);
		}
	});
});
