'use strict';

// f61601ab: populate the stage_runs table so workflow phase is REAL (queryable),
// not guessed from status+claim. The kernel_stage_runs table already existed in
// schema.js but nothing wrote to it. These tests drive the direct-registry driver
// methods (recordStageRun / getCurrentStage / listStageRuns) — mirroring the
// worktree-linkage registry — plus the current-stage field merged into `show`.
//
// The SQLite driver is REAL (migrated over a temp DB) and the issue is created
// through the broker so the stage_runs.issue_id FK resolves to a real issue row.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const TIMEOUT = 15000;

describe('Kernel stage_runs registry (f61601ab)', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const issueId = 'forge-stage-1';

	async function createIssue(id = issueId) {
		return broker.runIssueOperation(
			'create',
			['--id', id, '--title', 'Stage subject', '--type', 'task'],
			{ now: '2026-07-11T00:00:00.000Z', actor: 'tester' },
		);
	}

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-stage-'));
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		config = { databasePath: dbPath };
		driver = createBuiltinSQLiteDriver({});
		broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
		});
		await broker.initialize();
		await createIssue();
	});

	afterEach(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('recordStageRun start inserts an active row with started_at and no completed_at', () => {
		const row = driver.recordStageRun(
			{ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' },
			config,
		);
		expect(row.issue_id).toBe(issueId);
		expect(row.stage).toBe('dev');
		expect(row.status).toBe('active');
		expect(row.started_at).toBe('2026-07-11T01:00:00.000Z');
		expect(row.completed_at).toBeNull();
		expect(typeof row.id).toBe('string');
	}, TIMEOUT);

	test('recordStageRun complete sets completed_at and status=done on the same row', () => {
		const started = driver.recordStageRun(
			{ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' },
			config,
		);
		const completed = driver.recordStageRun(
			{ issue_id: issueId, stage: 'dev', action: 'complete', now: '2026-07-11T02:00:00.000Z' },
			config,
		);
		expect(completed.id).toBe(started.id); // same row, no duplicate
		expect(completed.status).toBe('done');
		expect(completed.completed_at).toBe('2026-07-11T02:00:00.000Z');
		expect(completed.started_at).toBe('2026-07-11T01:00:00.000Z');

		const all = driver.listStageRuns({ issue_id: issueId }, config);
		expect(all.length).toBe(1);
	}, TIMEOUT);

	test('start is idempotent per (issue_id, stage): repeat keeps one row + original started_at', () => {
		const first = driver.recordStageRun(
			{ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' },
			config,
		);
		const second = driver.recordStageRun(
			{ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T09:00:00.000Z' },
			config,
		);
		expect(second.id).toBe(first.id);
		expect(second.started_at).toBe('2026-07-11T01:00:00.000Z'); // unchanged
		expect(second.status).toBe('active');
		expect(driver.listStageRuns({ issue_id: issueId }, config).length).toBe(1);
	}, TIMEOUT);

	test('complete without a prior start creates a completed row', () => {
		const row = driver.recordStageRun(
			{ issue_id: issueId, stage: 'ship', action: 'complete', now: '2026-07-11T03:00:00.000Z' },
			config,
		);
		expect(row.status).toBe('done');
		expect(row.completed_at).toBe('2026-07-11T03:00:00.000Z');
		expect(row.started_at).toBe('2026-07-11T03:00:00.000Z');
		expect(driver.listStageRuns({ issue_id: issueId }, config).length).toBe(1);
	}, TIMEOUT);

	test('getCurrentStage prefers the latest ACTIVE stage over a completed one', () => {
		// dev completed at 02:00, validate started (active) at 01:30 — active wins.
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'validate', action: 'start', now: '2026-07-11T01:30:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'complete', now: '2026-07-11T02:00:00.000Z' }, config);

		const current = driver.getCurrentStage({ issue_id: issueId }, config);
		expect(current.stage).toBe('validate');
		expect(current.status).toBe('active');
	}, TIMEOUT);

	test('getCurrentStage falls back to the latest COMPLETED stage when none active', () => {
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'complete', now: '2026-07-11T02:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'ship', action: 'start', now: '2026-07-11T03:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'ship', action: 'complete', now: '2026-07-11T04:00:00.000Z' }, config);

		const current = driver.getCurrentStage({ issue_id: issueId }, config);
		expect(current.stage).toBe('ship'); // latest completed
		expect(current.status).toBe('done');
	}, TIMEOUT);

	test('getCurrentStage returns null when no stage runs exist', () => {
		expect(driver.getCurrentStage({ issue_id: issueId }, config)).toBeNull();
	}, TIMEOUT);

	test('listStageRuns returns rows ordered by started_at ascending', () => {
		driver.recordStageRun({ issue_id: issueId, stage: 'ship', action: 'start', now: '2026-07-11T03:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' }, config);
		const rows = driver.listStageRuns({ issue_id: issueId }, config);
		expect(rows.map(r => r.stage)).toEqual(['dev', 'ship']);
	}, TIMEOUT);

	test('show attaches current_stage + current_stage_status from stage_runs', async () => {
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'start', now: '2026-07-11T01:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'dev', action: 'complete', now: '2026-07-11T02:00:00.000Z' }, config);
		driver.recordStageRun({ issue_id: issueId, stage: 'review', action: 'start', now: '2026-07-11T03:00:00.000Z' }, config);

		const shown = await driver.issueOperation('show', [issueId], {}, config);
		expect(shown.ok).toBe(true);
		expect(shown.data.current_stage).toBe('review');
		expect(shown.data.current_stage_status).toBe('active');
	}, TIMEOUT);

	test('show reports null current_stage when no stage runs recorded', async () => {
		const shown = await driver.issueOperation('show', [issueId], {}, config);
		expect(shown.ok).toBe(true);
		expect(shown.data.current_stage).toBeNull();
		expect(shown.data.current_stage_status).toBeNull();
	}, TIMEOUT);
});
