'use strict';

// D19-B2 regression: the default-on filesystem gate must guard EVERY DB-creating
// broker path, not just initialize(). KernelIssueAdapter.run → runIssueOperation
// and the export consumer → listProjectionOutbox both reach driver.exec /
// getDatabase WITHOUT calling initialize(). The gate now lives in the memoized
// getConfig() chokepoint, so it fires (fail-closed) on first config access from
// any entry point — and must keep firing on subsequent calls, never caching a
// config that skipped the gate.

const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');

const T = 3000;

const REFUSE_CLASSIFICATION = {
	class: 'onedrive',
	riskTier: 'refuse',
	signal: 'injected',
	remediationKey: 'onedrive',
};

// A driver that records driver-level DB access. issueOperation/exec are present
// so the ONLY thing that can throw is the filesystem gate (not a missing-method
// guard). If the gate failed to fire, these would record calls / create a file.
function makeRecordingDriver() {
	const calls = [];
	return {
		calls,
		async exec(statement) {
			calls.push(['exec', statement]);
		},
		async issueOperation(operation) {
			calls.push(['issueOperation', operation]);
			return { ok: true, operation };
		},
		async listProjectionOutbox() {
			calls.push(['listProjectionOutbox']);
			return [];
		},
	};
}

function makeRefuseBroker(driver) {
	return createLocalBroker({
		projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
		gitCommonDir: path.join(os.tmpdir(), 'forge-worktree', '.git'),
		driver,
		env: {},
		classifyFilesystem: () => REFUSE_CLASSIFICATION,
	});
}

describe('broker filesystem gate is a structural chokepoint (D19-B2)', () => {
	test('runIssueOperation (read) on a refuse FS THROWS before any driver call — without initialize()', async () => {
		const driver = makeRecordingDriver();
		const broker = makeRefuseBroker(driver);

		// A read op routes through getConfig() (4th arg to driver.issueOperation).
		await expect(broker.runIssueOperation('list', [])).rejects.toThrow();
		// Gate fired BEFORE driver.issueOperation / driver.exec — zero driver calls.
		expect(driver.calls.length).toBe(0);
	}, T);

	test('the gate is fail-closed: a SECOND runIssueOperation still throws (no cached unguarded config)', async () => {
		const driver = makeRecordingDriver();
		const broker = makeRefuseBroker(driver);

		await expect(broker.runIssueOperation('list', [])).rejects.toThrow();
		// If getConfig cached the config BEFORE asserting, this second call would
		// return the cached config and the read would proceed (bypass reintroduced).
		await expect(broker.runIssueOperation('list', [])).rejects.toThrow();
		expect(driver.calls.length).toBe(0);
	}, T);

	test('listProjectionOutbox on a refuse FS THROWS before any driver call', async () => {
		const driver = makeRecordingDriver();
		const broker = makeRefuseBroker(driver);

		await expect(broker.listProjectionOutbox({})).rejects.toThrow();
		expect(driver.calls.length).toBe(0);
	}, T);

	test('the config getter itself throws on a refuse FS (gate guards config access)', () => {
		const driver = makeRecordingDriver();
		const broker = makeRefuseBroker(driver);

		expect(() => broker.config).toThrow();
		// Repeated access must keep throwing (fail-closed, not cached-unguarded).
		expect(() => broker.config).toThrow();
		expect(driver.calls.length).toBe(0);
	}, T);

	test('refuse FS with FORGE_KERNEL_ALLOW_UNSAFE_FS=1 allows runIssueOperation (override path)', async () => {
		const driver = makeRecordingDriver();
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-worktree', '.git'),
			driver,
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: '1' },
			warn: () => {},
			classifyFilesystem: () => REFUSE_CLASSIFICATION,
		});

		const result = await broker.runIssueOperation('list', []);
		expect(result.ok).toBe(true);
		expect(driver.calls).toContainEqual(['issueOperation', 'list']);
	}, T);

	test('local-ok FS lets runIssueOperation proceed (regression guard)', async () => {
		const driver = makeRecordingDriver();
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-worktree', '.git'),
			driver,
			env: {},
			classifyFilesystem: () => ({
				class: 'local-ok', riskTier: 'safe', signal: 'injected', remediationKey: 'local-ok',
			}),
		});

		const result = await broker.runIssueOperation('list', []);
		expect(result.ok).toBe(true);
	}, T);
});
