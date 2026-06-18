const KERNEL_STORAGE_CLASSES = Object.freeze([
	'authority',
	'read_model',
	'projection',
	'archive',
	'configuration',
	'cache',
	'external_provider',
]);

const KERNEL_FIELD_AUTHORITIES = Object.freeze([
	'forge',
	'provider',
	'configured_provider',
	'projection_only',
]);

function deepFreeze(value) {
	if (!value || typeof value !== 'object') return value;
	Object.freeze(value);
	for (const nestedValue of Object.values(value)) {
		deepFreeze(nestedValue);
	}
	return value;
}

function field(name, type, options = {}) {
	return {
		name,
		type,
		storageClass: options.storageClass,
		authority: options.authority || 'forge',
		primaryKey: Boolean(options.primaryKey),
		notNull: Boolean(options.notNull || options.primaryKey),
		default: options.default,
		references: options.references,
	};
}

function index(name, columns, options = {}) {
	return {
		name,
		columns,
		unique: Boolean(options.unique),
	};
}

function table(name, storageClass, fields, indexes = []) {
	return {
		name,
		sqlName: `kernel_${name}`,
		storageClass,
		authority: 'forge',
		fields: fields.map(fieldDefinition => ({
			...fieldDefinition,
			storageClass: fieldDefinition.storageClass || storageClass,
		})),
		indexes,
	};
}

const TABLE_LIST = deepFreeze([
	table('issues', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('title', 'TEXT', { notNull: true }),
		field('body', 'TEXT'),
		field('type', 'TEXT', { notNull: true, default: "'task'" }),
		field('status', 'TEXT', { notNull: true, default: "'open'" }),
		field('priority', 'TEXT', { notNull: true, default: "'P2'" }),
		field('priority_rank', 'INTEGER', { notNull: true, default: '0', storageClass: 'read_model' }),
		field('created_at', 'TEXT', { notNull: true }),
		field('updated_at', 'TEXT', { notNull: true }),
		field('entity_revision', 'INTEGER', { notNull: true, default: '0' }),
		// D18 taxonomy: hierarchy, planning buckets, and execution stage are separate
		// axes from status. ready/blocked stay derived (readiness-model), never stored.
		field('parent_id', 'TEXT', { references: 'issues.id' }),
		field('sprint_id', 'TEXT'),
		field('release_id', 'TEXT'),
		field('stage_state', 'TEXT'),
		field('labels', 'TEXT'),
		field('acceptance_criteria', 'TEXT'),
		field('estimate', 'TEXT'),
	], [
		index('idx_kernel_issues_status_priority', ['status', 'priority_rank']),
		index('idx_kernel_issues_updated_at', ['updated_at']),
		index('idx_kernel_issues_parent', ['parent_id']),
		index('idx_kernel_issues_sprint', ['sprint_id']),
		index('idx_kernel_issues_release', ['release_id']),
	]),
	table('dependencies', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('issue_id', 'TEXT', { notNull: true, references: 'issues.id' }),
		field('blocks_issue_id', 'TEXT', { notNull: true, references: 'issues.id' }),
		field('dependency_type', 'TEXT', { notNull: true, default: "'blocks'" }),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_dependencies_issue', ['issue_id']),
		index('idx_kernel_dependencies_blocks', ['blocks_issue_id']),
	]),
	table('comments', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('issue_id', 'TEXT', { notNull: true, references: 'issues.id' }),
		field('body', 'TEXT', { notNull: true }),
		field('actor', 'TEXT', { notNull: true }),
		field('visibility', 'TEXT', { notNull: true, default: "'local'" }),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_comments_issue_created', ['issue_id', 'created_at']),
	]),
	table('priority_events', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('issue_id', 'TEXT', { notNull: true, references: 'issues.id' }),
		field('old_priority', 'TEXT'),
		field('new_priority', 'TEXT', { notNull: true }),
		field('priority_rank', 'INTEGER', { notNull: true }),
		field('actor', 'TEXT', { notNull: true }),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_priority_events_issue_created', ['issue_id', 'created_at']),
	]),
	table('claims', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('issue_id', 'TEXT', { notNull: true, references: 'issues.id' }),
		field('actor', 'TEXT', { notNull: true }),
		field('state', 'TEXT', { notNull: true, default: "'active'" }),
		field('session_id', 'TEXT'),
		field('worktree_id', 'TEXT'),
		field('claimed_at', 'TEXT', { notNull: true }),
		field('expires_at', 'TEXT'),
	], [
		index('idx_kernel_claims_issue_state', ['issue_id', 'state']),
		index('idx_kernel_claims_actor_state', ['actor', 'state']),
	]),
	table('sessions', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('actor', 'TEXT', { notNull: true }),
		field('git_common_dir', 'TEXT', { notNull: true }),
		field('worktree_id', 'TEXT'),
		field('started_at', 'TEXT', { notNull: true }),
		field('ended_at', 'TEXT'),
		field('state', 'TEXT', { notNull: true, default: "'active'" }),
	], [
		index('idx_kernel_sessions_common_dir_state', ['git_common_dir', 'state']),
	]),
	table('worktrees', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('git_common_dir', 'TEXT', { notNull: true }),
		field('path', 'TEXT', { notNull: true, storageClass: 'configuration' }),
		field('branch', 'TEXT', { notNull: true }),
		field('actor', 'TEXT'),
		field('registered_at', 'TEXT', { notNull: true }),
		field('state', 'TEXT', { notNull: true, default: "'active'" }),
	], [
		index('idx_kernel_worktrees_common_dir_branch', ['git_common_dir', 'branch']),
	]),
	table('stage_runs', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('issue_id', 'TEXT', { notNull: true, references: 'issues.id' }),
		field('stage', 'TEXT', { notNull: true }),
		field('substage', 'TEXT'),
		field('status', 'TEXT', { notNull: true }),
		field('started_at', 'TEXT', { notNull: true }),
		field('completed_at', 'TEXT'),
		field('evidence_id', 'TEXT'),
	], [
		index('idx_kernel_stage_runs_issue_stage', ['issue_id', 'stage']),
		index('idx_kernel_stage_runs_status', ['status']),
	]),
	table('evidence', 'archive', [
		field('id', 'TEXT', { primaryKey: true }),
		field('issue_id', 'TEXT'),
		field('run_id', 'TEXT'),
		field('kind', 'TEXT', { notNull: true }),
		field('uri', 'TEXT'),
		field('summary', 'TEXT'),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_evidence_issue_kind', ['issue_id', 'kind']),
	]),
	table('projections', 'projection', [
		field('id', 'TEXT', { primaryKey: true }),
		field('target', 'TEXT', { notNull: true, storageClass: 'external_provider', authority: 'configured_provider' }),
		field('entity_type', 'TEXT', { notNull: true }),
		field('entity_id', 'TEXT', { notNull: true }),
		field('status', 'TEXT', { notNull: true }),
		field('last_error', 'TEXT', { storageClass: 'cache', authority: 'projection_only' }),
		field('updated_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_projections_target_status', ['target', 'status']),
		index('idx_kernel_projections_entity', ['entity_type', 'entity_id']),
	]),
	table('conflicts', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('entity_type', 'TEXT', { notNull: true }),
		field('entity_id', 'TEXT', { notNull: true }),
		field('expected_revision', 'INTEGER', { notNull: true }),
		field('actual_revision', 'INTEGER', { notNull: true }),
		field('status', 'TEXT', { notNull: true, default: "'quarantined'" }),
		field('payload_json', 'TEXT', { notNull: true }),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_conflicts_status', ['status']),
		index('idx_kernel_conflicts_entity', ['entity_type', 'entity_id']),
	]),
	table('events', 'authority', [
		field('id', 'TEXT', { primaryKey: true }),
		field('entity_type', 'TEXT', { notNull: true }),
		field('entity_id', 'TEXT', { notNull: true }),
		field('event_type', 'TEXT', { notNull: true }),
		field('idempotency_key', 'TEXT', { notNull: true }),
		field('expected_revision', 'INTEGER', { notNull: true }),
		field('actor', 'TEXT', { notNull: true }),
		field('origin', 'TEXT', { notNull: true }),
		field('payload_json', 'TEXT', { notNull: true }),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_events_entity_created', ['entity_type', 'entity_id', 'created_at']),
		index('idx_kernel_events_idempotency', ['idempotency_key'], { unique: true }),
	]),
	table('outbox', 'projection', [
		field('id', 'TEXT', { primaryKey: true }),
		field('event_id', 'TEXT', { notNull: true, references: 'events.id' }),
		field('target', 'TEXT', { notNull: true }),
		field('status', 'TEXT', { notNull: true, default: "'pending'" }),
		field('attempts', 'INTEGER', { notNull: true, default: '0' }),
		field('next_attempt_at', 'TEXT'),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_outbox_target_status', ['target', 'status']),
	]),
	table('dead_letters', 'projection', [
		field('id', 'TEXT', { primaryKey: true }),
		field('outbox_id', 'TEXT'),
		field('target', 'TEXT', { notNull: true }),
		field('status', 'TEXT', { notNull: true, default: "'open'" }),
		field('error', 'TEXT', { notNull: true }),
		field('payload_json', 'TEXT', { notNull: true }),
		field('created_at', 'TEXT', { notNull: true }),
	], [
		index('idx_kernel_dead_letters_status', ['status']),
	]),
]);

const KERNEL_TABLES = deepFreeze(Object.fromEntries(TABLE_LIST.map(candidate => [candidate.name, candidate])));

function classifyKernelStorage(tableName) {
	const tableDefinition = KERNEL_TABLES[tableName];
	if (!tableDefinition) {
		throw new Error(`Unknown Kernel table: ${tableName}`);
	}

	return {
		table: tableDefinition.name,
		sqlName: tableDefinition.sqlName,
		storageClass: tableDefinition.storageClass,
		authority: tableDefinition.authority,
	};
}

function validateKernelSchema(schema = getKernelSchema()) {
	const tableNames = new Set();
	for (const tableDefinition of schema.tables) {
		if (tableNames.has(tableDefinition.name)) {
			throw new Error(`Duplicate Kernel table: ${tableDefinition.name}`);
		}
		tableNames.add(tableDefinition.name);
		if (!KERNEL_STORAGE_CLASSES.includes(tableDefinition.storageClass)) {
			throw new Error(`Invalid storage class for ${tableDefinition.name}: ${tableDefinition.storageClass}`);
		}
		if (!KERNEL_FIELD_AUTHORITIES.includes(tableDefinition.authority)) {
			throw new Error(`Invalid table authority for ${tableDefinition.name}: ${tableDefinition.authority}`);
		}
		for (const fieldDefinition of tableDefinition.fields) {
			if (!KERNEL_STORAGE_CLASSES.includes(fieldDefinition.storageClass)) {
				throw new Error(`Invalid storage class for ${tableDefinition.name}.${fieldDefinition.name}: ${fieldDefinition.storageClass}`);
			}
			if (!KERNEL_FIELD_AUTHORITIES.includes(fieldDefinition.authority)) {
				throw new Error(`Invalid field authority for ${tableDefinition.name}.${fieldDefinition.name}: ${fieldDefinition.authority}`);
			}
		}
	}

	return true;
}

function cloneTableList(tableList) {
	return tableList.map(tableDefinition => ({
		...tableDefinition,
		fields: tableDefinition.fields.map(fieldDefinition => ({ ...fieldDefinition })),
		indexes: tableDefinition.indexes.map(indexDefinition => ({
			...indexDefinition,
			columns: [...indexDefinition.columns],
		})),
	}));
}

function getKernelSchema() {
	return {
		version: 1,
		tables: cloneTableList(TABLE_LIST),
	};
}

module.exports = {
	KERNEL_FIELD_AUTHORITIES,
	KERNEL_STORAGE_CLASSES,
	KERNEL_TABLES,
	classifyKernelStorage,
	cloneTableList,
	deepFreeze,
	field,
	getKernelSchema,
	index,
	table,
	validateKernelSchema,
};
