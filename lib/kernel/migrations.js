const { getKernelSchema, validateKernelSchema } = require('./schema');

function assertIdentifier(identifier, label) {
	if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
		throw new Error(`Invalid Kernel SQL ${label}: ${identifier}`);
	}
}

function renderReference(reference) {
	const [tableName, columnName] = String(reference || '').split('.');
	assertIdentifier(tableName, 'reference table');
	assertIdentifier(columnName, 'reference column');
	return `REFERENCES kernel_${tableName}(${columnName})`;
}

function renderColumn(field) {
	assertIdentifier(field.name, 'column');
	const parts = [field.name, field.type];
	if (field.notNull) parts.push('NOT NULL');
	if (field.primaryKey) parts.push('PRIMARY KEY');
	if (field.default !== undefined) parts.push(`DEFAULT ${field.default}`);
	if (field.references) parts.push(renderReference(field.references));
	return parts.join(' ');
}

function renderCreateTable(table) {
	assertIdentifier(table.sqlName, 'table');
	const columns = table.fields.map(field => `  ${renderColumn(field)}`).join(',\n');
	return `CREATE TABLE IF NOT EXISTS ${table.sqlName} (\n${columns}\n);`;
}

function renderCreateIndex(table, index) {
	assertIdentifier(index.name, 'index');
	const unique = index.unique ? 'UNIQUE ' : '';
	const columns = index.columns.join(', ');
	return `CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON ${table.sqlName} (${columns});`;
}

function renderDropIndex(index) {
	assertIdentifier(index.name, 'index');
	return `DROP INDEX IF EXISTS ${index.name};`;
}

function renderDropTable(table) {
	assertIdentifier(table.sqlName, 'table');
	return `DROP TABLE IF EXISTS ${table.sqlName};`;
}

function buildSchemaMigration() {
	const schema = getKernelSchema();
	validateKernelSchema(schema);

	const apply = [];
	for (const table of schema.tables) {
		apply.push(renderCreateTable(table));
		for (const tableIndex of table.indexes) {
			apply.push(renderCreateIndex(table, tableIndex));
		}
	}

	const rollback = [];
	for (const table of [...schema.tables].reverse()) {
		for (const tableIndex of [...table.indexes].reverse()) {
			rollback.push(renderDropIndex(tableIndex));
		}
		rollback.push(renderDropTable(table));
	}

	return {
		id: '001_kernel_schema',
		apply,
		rollback,
	};
}

function validateKernelMigrations(migrations) {
	const ids = new Set();
	for (const migration of migrations) {
		if (!migration || !migration.id) {
			throw new Error('Kernel migration is missing an id');
		}
		if (ids.has(migration.id)) {
			throw new Error(`Duplicate Kernel migration id: ${migration.id}`);
		}
		ids.add(migration.id);
		if (!Array.isArray(migration.apply) || migration.apply.length === 0) {
			throw new Error(`Kernel migration ${migration.id} has no apply statements`);
		}
		if (!Array.isArray(migration.rollback) || migration.rollback.length === 0) {
			throw new Error(`Kernel migration ${migration.id} has no rollback statements`);
		}
	}

	return true;
}

function buildKernelMigrationPlan(migrations = [buildSchemaMigration()]) {
	validateKernelMigrations(migrations);

	return {
		migrations,
		apply: migrations.flatMap(migration => migration.apply),
		rollback: [...migrations].reverse().flatMap(migration => migration.rollback),
	};
}

module.exports = {
	buildKernelMigrationPlan,
	validateKernelMigrations,
};
