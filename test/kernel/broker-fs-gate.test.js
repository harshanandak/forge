'use strict';

const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');

const T = 3000;

function makeRecordingDriver() {
	const execCalls = [];
	return {
		execCalls,
		async exec(statement) {
			execCalls.push(statement);
		},
		// The ledger-aware initialize() reads applied migration ids via queryAll;
		// an empty result means every migration applies. The D19 gate under test
		// fires in getConfig() BEFORE any driver call, so this stub only needs to let
		// initialize() proceed past the migration-ledger read in the non-refuse cases.
		async queryAll() {
			return [];
		},
	};
}

describe('broker default-on filesystem gate (D19-T3)', () => {
	test('refuse-class path rejects initialize() with ZERO exec calls (no file/pragma before throw)', async () => {
		const driver = makeRecordingDriver();
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-worktree', '.git'),
			driver,
			env: {},
			classifyFilesystem: () => ({
				class: 'onedrive',
				riskTier: 'refuse',
				signal: 'injected',
				remediationKey: 'onedrive',
			}),
		});

		await expect(broker.initialize()).rejects.toThrow();
		expect(driver.execCalls.length).toBe(0);
	}, T);

	test('refuse-class path with FORGE_KERNEL_ALLOW_UNSAFE_FS=1 resolves and runs pragmas', async () => {
		const driver = makeRecordingDriver();
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-worktree', '.git'),
			driver,
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: '1' },
			warn: () => {},
			classifyFilesystem: () => ({
				class: 'onedrive',
				riskTier: 'refuse',
				signal: 'injected',
				remediationKey: 'onedrive',
			}),
		});

		const result = await broker.initialize();
		expect(result.success).toBe(true);
		expect(driver.execCalls.length).toBeGreaterThan(0);
	}, T);

	test('local-ok path resolves normally (regression guard)', async () => {
		const driver = makeRecordingDriver();
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-worktree', '.git'),
			driver,
			env: {},
			classifyFilesystem: () => ({
				class: 'local-ok',
				riskTier: 'safe',
				signal: 'injected',
				remediationKey: 'local-ok',
			}),
		});

		const result = await broker.initialize();
		expect(result.success).toBe(true);
		expect(driver.execCalls.length).toBeGreaterThan(0);
	}, T);
});
