'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
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
			for (const statement of [...config.pragmas, ...config.migrationPlan.apply]) {
				await driver.exec(statement, config);
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
	};
}

module.exports = {
	LOCAL_BROKER_PRAGMAS,
	buildLocalBrokerConfig,
	createLocalBroker,
	resolveGitCommonDir,
};
