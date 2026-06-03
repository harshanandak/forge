'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { evaluateKernelEvent } = require('./evaluators');
const { buildKernelMigrationPlan } = require('./migrations');

const LOCAL_BROKER_PRAGMAS = Object.freeze([
	'PRAGMA journal_mode=WAL;',
	'PRAGMA synchronous=NORMAL;',
	'PRAGMA foreign_keys=ON;',
	'PRAGMA busy_timeout=5000;',
]);

function normalizeExecOutput(output) {
	if (Buffer.isBuffer(output)) {
		return output.toString('utf8');
	}
	return String(output || '');
}

function resolveGitCommonDir(projectRoot, deps = {}) {
	if (!projectRoot) {
		throw new Error('projectRoot is required to resolve the Kernel broker common-dir');
	}

	const exec = deps.execFileSync || execFileSync;
	const rawCommonDir = normalizeExecOutput(exec('git', [
		'-C',
		projectRoot,
		'rev-parse',
		'--git-common-dir',
	], { encoding: 'utf8' })).trim();

	if (!rawCommonDir) {
		throw new Error('git rev-parse --git-common-dir returned an empty path');
	}

	return path.resolve(path.isAbsolute(rawCommonDir)
		? rawCommonDir
		: path.join(projectRoot, rawCommonDir));
}

function buildLocalBrokerConfig(options = {}) {
	const projectRoot = options.projectRoot || process.cwd();
	const gitCommonDir = path.resolve(options.gitCommonDir || resolveGitCommonDir(projectRoot, options));
	const brokerDir = path.join(gitCommonDir, 'forge');

	return {
		mode: 'local',
		storage: 'sqlite',
		journalMode: 'WAL',
		synchronous: 'NORMAL',
		foreignKeys: true,
		busyTimeoutMs: 5000,
		projectRoot,
		gitCommonDir,
		brokerDir,
		databasePath: options.databasePath || path.join(brokerDir, 'kernel.sqlite'),
		pragmas: [...LOCAL_BROKER_PRAGMAS],
		migrationPlan: options.migrationPlan || buildKernelMigrationPlan(),
	};
}

function requireDriverMethod(driver, methodName) {
	if (!driver || typeof driver[methodName] !== 'function') {
		throw new Error(`Kernel local broker driver must provide ${methodName}()`);
	}
}

function isExpectedRevisionAddColumn(statement) {
	return statement === 'ALTER TABLE kernel_events ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0;';
}

function isDuplicateColumnError(error) {
	return /duplicate column name/i.test(String(error && error.message ? error.message : error));
}

async function execMigrationStatement(driver, statement, config) {
	try {
		await driver.exec(statement, config);
	} catch (error) {
		if (isExpectedRevisionAddColumn(statement) && isDuplicateColumnError(error)) {
			return { skipped: true, reason: 'column-already-exists' };
		}
		throw error;
	}
	return { skipped: false };
}

function buildProjectionOutboxEntry(event, target, now) {
	return {
		event_id: event.id,
		target,
		status: 'pending',
		attempts: 0,
		created_at: now,
	};
}

function parseEventPayload(event = {}) {
	if (event.payload) return event.payload;
	if (!event.payload_json) return {};
	try {
		return JSON.parse(event.payload_json);
	} catch {
		return {};
	}
}

function buildDependencyScope(event) {
	if (event.event_type !== 'dependency.add') return null;
	const payload = parseEventPayload(event);
	if (!payload.issue_id || !payload.blocks_issue_id) return null;
	return {
		issue_id: payload.issue_id,
		blocks_issue_id: payload.blocks_issue_id,
		dependency_type: payload.dependency_type || 'blocks',
		entity_type: event.entity_type,
		entity_id: event.entity_id,
	};
}

function createLocalBroker(options = {}) {
	const driver = options.driver;
	let cachedConfig;

	function getConfig() {
		if (!cachedConfig) {
			cachedConfig = buildLocalBrokerConfig(options);
		}
		return cachedConfig;
	}

	return {
		get config() {
			return getConfig();
		},

		async initialize() {
			requireDriverMethod(driver, 'exec');
			const config = getConfig();
			for (const statement of config.pragmas) {
				await driver.exec(statement, config);
			}
			for (const statement of config.migrationPlan.apply) {
				await execMigrationStatement(driver, statement, config);
			}

			return {
				success: true,
				mode: config.mode,
				databasePath: config.databasePath,
				gitCommonDir: config.gitCommonDir,
				journalMode: config.journalMode,
				synchronous: config.synchronous,
				foreignKeys: config.foreignKeys,
				migrationsApplied: config.migrationPlan.migrations.map(migration => migration.id),
			};
		},

		async runIssueOperation(operation, args = [], context = {}) {
			requireDriverMethod(driver, 'issueOperation');
			return driver.issueOperation(operation, args, context, getConfig());
		},

		async runGuardedEvent(event, context = {}) {
			for (const methodName of [
				'loadKernelEntity',
				'listKernelEvents',
				'loadKernelEventByIdempotencyKey',
				'insertKernelConflict',
				'insertKernelEvent',
				'enqueueKernelProjection',
			]) {
				requireDriverMethod(driver, methodName);
			}

			const config = getConfig();
			const now = context.now || new Date().toISOString();
			const normalizedEvent = {
				...event,
				created_at: event.created_at || now,
			};
			const dependencyScope = buildDependencyScope(normalizedEvent);
			if (dependencyScope) {
				requireDriverMethod(driver, 'listKernelDependencies');
			}

			const [entity, entityEvents, idempotencyEvent, dependencies] = await Promise.all([
				driver.loadKernelEntity(normalizedEvent.entity_type, normalizedEvent.entity_id, context, config),
				driver.listKernelEvents(normalizedEvent.entity_type, normalizedEvent.entity_id, context, config),
				driver.loadKernelEventByIdempotencyKey(normalizedEvent.idempotency_key, context, config),
				dependencyScope
					? driver.listKernelDependencies(dependencyScope, context, config)
					: Promise.resolve([]),
			]);
			const priorEvents = idempotencyEvent
				? [idempotencyEvent, ...entityEvents.filter(candidate => candidate.id !== idempotencyEvent.id)]
				: entityEvents;
			const evaluation = evaluateKernelEvent({
				event: normalizedEvent,
				entity,
				priorEvents,
				dependencies,
			});

			if (evaluation.decision === 'quarantine') {
				const conflict = await driver.insertKernelConflict({
					...evaluation.conflict,
					created_at: evaluation.conflict.created_at || now,
				}, context, config);
				return {
					...evaluation,
					conflict,
				};
			}

			if (evaluation.decision !== 'accept') {
				return evaluation;
			}

			const acceptedEvent = await driver.insertKernelEvent({
				...evaluation.event,
				created_at: evaluation.event.created_at || now,
			}, context, config);
			const outboxEntry = await driver.enqueueKernelProjection(
				buildProjectionOutboxEntry(acceptedEvent, context.projectionTarget || 'beads', now),
				context,
				config,
			);

			return {
				...evaluation,
				event: acceptedEvent,
				outboxEntry,
			};
		},
	};
}

module.exports = {
	LOCAL_BROKER_PRAGMAS,
	buildLocalBrokerConfig,
	createLocalBroker,
	resolveGitCommonDir,
};
