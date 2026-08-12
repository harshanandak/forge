#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { createBuiltinSQLiteDriver, hardenBackupPermissions } = require('../lib/kernel/sqlite-driver');
const {
	ClaimRepairError,
	createVerifiedClaimRepairBackup,
} = require('../lib/kernel/legacy-claim-repair');

const HELP = `Usage:
  bun scripts/legacy-claim-repair.js --dry-run --database <kernel.sqlite> --backup <separate.sqlite> --at <canonical-UTC>
  bun scripts/legacy-claim-repair.js --apply --database <kernel.sqlite> --backup <separate.sqlite> --at <canonical-UTC> --approved-digest <sha256> --actor <identity>

The tool never discovers or repairs a database automatically. Apply is rejected
without a verified restorable backup and the exact human-approved dry-run digest.`;

function parseArgs(argv = []) {
	const result = { mode: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') return { help: true };
		if (arg === '--dry-run' || arg === '--apply') {
			const mode = arg.slice(2);
			if (result.mode && result.mode !== mode) throw new Error('Choose exactly one of --dry-run or --apply');
			result.mode = mode;
			continue;
		}
		const names = {
			'--database': 'databasePath',
			'--backup': 'backupPath',
			'--at': 'observedAt',
			'--approved-digest': 'approvedDigest',
			'--actor': 'actor',
		};
		if (!Object.hasOwn(names, arg)) throw new Error(`Unknown argument: ${arg}`);
		const name = names[arg];
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
		result[name] = value;
		index += 1;
	}
	if (!result.mode) throw new Error('Choose exactly one of --dry-run or --apply');
	for (const required of ['databasePath', 'backupPath', 'observedAt']) {
		if (!result[required]) throw new Error(`Missing required option: ${required}`);
	}
	for (const requiredPath of ['databasePath', 'backupPath']) {
		if (!path.isAbsolute(result[requiredPath])) {
			throw new Error(`${requiredPath} must be an absolute path`);
		}
	}
	if (result.mode === 'apply' && !result.approvedDigest) {
		throw new Error('--apply requires --approved-digest');
	}
	if (result.mode === 'apply' && !result.actor) {
		throw new Error('--apply requires --actor');
	}
	if (result.mode === 'dry-run' && result.approvedDigest) {
		throw new Error('--approved-digest is valid only with --apply');
	}
	if (result.mode === 'dry-run' && result.actor) {
		throw new Error('--actor is valid only with --apply');
	}
	return result;
}

async function run(options, dependencies = {}) {
	const openDriver = dependencies.openDriver
		|| (databasePath => createBuiltinSQLiteDriver({ databasePath }));
	const createBackup = dependencies.createVerifiedClaimRepairBackup
		|| createVerifiedClaimRepairBackup;
	const hardenPath = dependencies.hardenPath || hardenBackupPermissions;
	const sourceDriver = openDriver(options.databasePath);
	try {
		if (options.mode === 'dry-run') {
			const backup = await createBackup({
				sourceDriver,
				backupPath: options.backupPath,
				observedAt: options.observedAt,
				openDriver,
				hardenPath,
			});
			const preflight = await sourceDriver.preflightLegacyClaimRepair({ observedAt: options.observedAt });
			if (preflight.digest !== backup.plan_digest) {
				throw new ClaimRepairError(
					'CLAIM_REPAIR_BACKUP_DRIFT',
					'Live claim authority changed while binding the reported preflight to its verified backup',
				);
			}
			return { ok: true, preflight, backup };
		}

		const receipt = await sourceDriver.applyLegacyClaimRepair({
			observedAt: options.observedAt,
			approvedDigest: options.approvedDigest,
			backupPath: options.backupPath,
			actor: options.actor,
		});
		return { ok: true, receipt };
	} finally {
		sourceDriver.close();
	}
}

async function main(argv = process.argv.slice(2)) {
	try {
		const options = parseArgs(argv);
		if (options.help) {
			process.stdout.write(`${HELP}\n`);
			return;
		}
		process.stdout.write(`${JSON.stringify(await run(options), null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({
			ok: false,
			error: {
				code: error?.code || 'CLAIM_REPAIR_USAGE',
				message: error?.message || String(error),
			},
		}, null, 2)}\n`);
		process.exitCode = 1;
	}
}

if (require.main === module) void main();

module.exports = {
	HELP,
	main,
	parseArgs,
	run,
};
