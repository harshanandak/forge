const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const {
	KERNEL_STORAGE_CLASSES,
	KERNEL_FIELD_AUTHORITIES,
	KERNEL_TABLES,
	classifyKernelStorage,
	getKernelSchema,
	validateKernelSchema,
} = require('../../lib/kernel/schema');

const REQUIRED_TABLES = [
	'issues',
	'dependencies',
	'comments',
	'priority_events',
	'claims',
	'sessions',
	'worktrees',
	'stage_runs',
	'evidence',
	'projections',
	'conflicts',
	'events',
	'outbox',
	'dead_letters',
];

describe('kernel schema registry', () => {
	test('defines the 0.0.20 authority entities and indexes', () => {
		const schema = getKernelSchema();

		expect(schema.tables.map(table => table.name)).toEqual(REQUIRED_TABLES);
		for (const tableName of REQUIRED_TABLES) {
			const table = KERNEL_TABLES[tableName];
			expect(table).toBeDefined();
			expect(table.sqlName).toMatch(/^kernel_[a-z0-9_]+$/);
			expect(table.fields.some(field => field.primaryKey)).toBe(true);
			expect(table.fields.length).toBeGreaterThan(2);
		}

		expect(KERNEL_TABLES.issues.indexes.map(index => index.name)).toContain('idx_kernel_issues_status_priority');
		expect(KERNEL_TABLES.dependencies.indexes.map(index => index.name)).toContain('idx_kernel_dependencies_blocks');
		expect(KERNEL_TABLES.stage_runs.indexes.map(index => index.name)).toContain('idx_kernel_stage_runs_issue_stage');
		expect(KERNEL_TABLES.projections.indexes.map(index => index.name)).toContain('idx_kernel_projections_target_status');
		expect(KERNEL_TABLES.conflicts.indexes.map(index => index.name)).toContain('idx_kernel_conflicts_status');
		expect(KERNEL_TABLES.events.fields.map(field => field.name)).toContain('expected_revision');
	});

	test('classifies every table and field with valid storage and authority metadata', () => {
		expect(KERNEL_STORAGE_CLASSES).toEqual([
			'authority',
			'read_model',
			'projection',
			'archive',
			'configuration',
			'cache',
			'external_provider',
		]);
		expect(KERNEL_FIELD_AUTHORITIES).toEqual([
			'forge',
			'provider',
			'configured_provider',
			'projection_only',
		]);

		for (const table of getKernelSchema().tables) {
			expect(KERNEL_STORAGE_CLASSES).toContain(table.storageClass);
			expect(classifyKernelStorage(table.name).storageClass).toBe(table.storageClass);
			for (const field of table.fields) {
				expect(KERNEL_STORAGE_CLASSES).toContain(field.storageClass);
				expect(KERNEL_FIELD_AUTHORITIES).toContain(field.authority);
			}
		}

		const usedStorageClasses = new Set();
		for (const table of getKernelSchema().tables) {
			usedStorageClasses.add(table.storageClass);
			for (const field of table.fields) {
				usedStorageClasses.add(field.storageClass);
			}
		}
		expect([...usedStorageClasses].sort()).toEqual([...KERNEL_STORAGE_CLASSES].sort());

		expect(classifyKernelStorage('issues')).toMatchObject({
			storageClass: 'authority',
			authority: 'forge',
		});
		expect(classifyKernelStorage('projections')).toMatchObject({
			storageClass: 'projection',
			authority: 'forge',
		});
		expect(classifyKernelStorage('evidence')).toMatchObject({
			storageClass: 'archive',
			authority: 'forge',
		});
		expect(() => classifyKernelStorage('unknown')).toThrow('Unknown Kernel table');
		expect(validateKernelSchema()).toBe(true);
	});

	test('guards storage metadata against storage-model drift', () => {
		const storageModel = fs.readFileSync(
			path.join(__dirname, '..', '..', 'docs', 'reference', 'FORGE_KERNEL_STORAGE_MODEL.md'),
			'utf8',
		);
		const requiredStorageModelPhrases = {
			authority: 'Authority',
			read_model: 'Read model',
			projection: 'Projection state',
			archive: 'Archive',
			configuration: 'Configuration',
			cache: 'cached',
			external_provider: 'provider',
		};

		for (const [storageClass, phrase] of Object.entries(requiredStorageModelPhrases)) {
			expect(KERNEL_STORAGE_CLASSES).toContain(storageClass);
			expect(storageModel).toContain(phrase);
		}
		expect(storageModel).toContain('Forge Kernel owns issue, claim, stage, run, and projection state');
		expect(storageModel).toContain('Beads is import/export compatibility only');

		const invalidStorageSchema = {
			tables: [{
				...KERNEL_TABLES.issues,
				fields: [{ ...KERNEL_TABLES.issues.fields[0], storageClass: 'invalid' }],
			}],
		};
		const invalidAuthoritySchema = {
			tables: [{
				...KERNEL_TABLES.issues,
				fields: [{ ...KERNEL_TABLES.issues.fields[0], authority: 'invalid' }],
			}],
		};
		const invalidTableAuthoritySchema = {
			tables: [{
				...KERNEL_TABLES.issues,
				authority: 'invalid',
			}],
		};

		expect(() => validateKernelSchema(invalidStorageSchema)).toThrow('Invalid storage class for issues.id');
		expect(() => validateKernelSchema(invalidAuthoritySchema)).toThrow('Invalid field authority for issues.id');
		expect(() => validateKernelSchema(invalidTableAuthoritySchema)).toThrow('Invalid table authority for issues');
	});

	test('returns isolated schema definitions for consumer planning', () => {
		const schema = getKernelSchema();
		schema.tables[0].fields[0].name = 'mutated';
		schema.tables[0].indexes[0].columns.push('mutated_column');

		const freshSchema = getKernelSchema();

		expect(freshSchema.tables[0].fields[0].name).toBe('id');
		expect(freshSchema.tables[0].indexes[0].columns).not.toContain('mutated_column');
		expect(KERNEL_TABLES.issues.fields[0].name).toBe('id');
		expect(KERNEL_TABLES.issues.indexes[0].columns).not.toContain('mutated_column');
	});

	test('deep-freezes the exported schema registry', () => {
		KERNEL_TABLES.issues.fields[0].name = 'mutated';

		expect(() => KERNEL_TABLES.issues.indexes[0].columns.push('mutated_column')).toThrow();
		expect(KERNEL_TABLES.issues.fields[0].name).toBe('id');
		expect(KERNEL_TABLES.issues.indexes[0].columns).not.toContain('mutated_column');
	});
});
