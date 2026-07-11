'use strict';

// f61601ab: `forge stage <issue-id> <stage> --start|--complete` writes real
// stage_runs rows, and `--current` / `--list` read them back. The SQLite driver is
// REAL (migrated over a temp DB) and the issue is created through the broker so the
// FK resolves; the command is exercised via its exported handler with the driver
// injected (opts._kernelDriver), so no git repo is spawned.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stage = require('../../lib/commands/stage');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const TIMEOUT = 15000;

describe('forge stage command (f61601ab)', () => {
	let tmpDir;
	let driver;
	let broker;
	let projectRoot;
	const issueId = 'forge-stage-cmd-1';

	async function run(args) {
		return stage.handler(args, {}, projectRoot, { _kernelDriver: driver });
	}

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cmd-'));
		projectRoot = tmpDir;
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		// Bake the databasePath into the driver — mirrors the real CLI driver from
		// buildMigratedKernelIssueDeps, so the command's config-less calls resolve.
		driver = createBuiltinSQLiteDriver({ databasePath: dbPath });
		broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
		});
		await broker.initialize();
		await broker.runIssueOperation(
			'create',
			['--id', issueId, '--title', 'Stage subject', '--type', 'task'],
			{ now: '2026-07-11T00:00:00.000Z', actor: 'tester' },
		);
	});

	afterEach(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('--start records an active stage run', async () => {
		const result = await run([issueId, 'dev', '--start']);
		expect(result.success).toBe(true);
		expect(result.stage_run.stage).toBe('dev');
		expect(result.stage_run.status).toBe('active');

		const current = driver.getCurrentStage({ issue_id: issueId }, {});
		expect(current.stage).toBe('dev');
	}, TIMEOUT);

	test('--complete marks the stage done on the same row', async () => {
		await run([issueId, 'dev', '--start']);
		const result = await run([issueId, 'dev', '--complete']);
		expect(result.success).toBe(true);
		expect(result.stage_run.status).toBe('done');
		expect(driver.listStageRuns({ issue_id: issueId }, {}).length).toBe(1);
	}, TIMEOUT);

	test('--current prints the latest active stage', async () => {
		await run([issueId, 'dev', '--start']);
		await run([issueId, 'dev', '--complete']);
		await run([issueId, 'ship', '--start']);
		const result = await run([issueId, '--current']);
		expect(result.success).toBe(true);
		expect(result.current_stage).toBe('ship');
		expect(result.current_stage_status).toBe('active');
	}, TIMEOUT);

	test('--list returns the full ordered history', async () => {
		await run([issueId, 'dev', '--start']);
		await run([issueId, 'ship', '--start']);
		const result = await run([issueId, '--list']);
		expect(result.success).toBe(true);
		expect(result.stage_runs.map(r => r.stage)).toEqual(['dev', 'ship']);
	}, TIMEOUT);

	test('rejects an unknown stage id', async () => {
		const result = await run([issueId, 'bogus', '--start']);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Invalid or missing stage');
	}, TIMEOUT);

	test('errors when no issue id is given', async () => {
		const result = await run(['--current']);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Missing issue id');
	}, TIMEOUT);

	test('--json emits machine-readable output', async () => {
		const result = await run([issueId, 'dev', '--start', '--json']);
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.stage_run.stage).toBe('dev');
		expect(parsed.action).toBe('start');
	}, TIMEOUT);

	test('resolves an 8-char UUID prefix to the full issue id', async () => {
		const uuid = require('node:crypto').randomUUID();
		await broker.runIssueOperation(
			'create',
			['--id', uuid, '--title', 'UUID subject', '--type', 'task'],
			{ now: '2026-07-11T00:00:00.000Z', actor: 'tester' },
		);
		const result = await run([uuid.slice(0, 8), 'dev', '--start']);
		expect(result.success).toBe(true);
		expect(result.stage_run.issue_id).toBe(uuid);
	}, TIMEOUT);
});
