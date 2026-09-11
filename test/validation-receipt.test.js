'use strict';

const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	beginValidation,
	completeValidation,
	resolveReceiptPath,
	verifyValidationReceipt,
} = require('../lib/validation-receipt');

function createRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge receipt path with spaces-'));
	fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
	execFileSync('git', ['init', '-q'], { cwd: root });
	const homeDir = path.join(root, '.git', 'forge-test-home');
	fs.mkdirSync(homeDir);
	execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'receipt@example.test'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Receipt Test'], { cwd: root });
	execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
	execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
	return { root, homeDir };
}

function fullPass() {
	return {
		success: true,
		checks: {
			conflictMarkers: { success: true },
			typeCheck: { success: true, skipped: true },
			lint: { success: true },
			security: { success: true },
			tests: { success: true, fullSuite: true, testsFound: true, total: 12, failed: 0 },
		},
	};
}

describe('validation receipt', () => {
	test('accepts an immediate complete validation for the unchanged exact head', () => {
		const { root, homeDir } = createRepo();
		const deps = { homeDir, runtimeIdentity: 'forge-runtime', testRuntimeIdentity: 'bun-a' };
		try {
			const snapshot = beginValidation(root, deps);
			expect(snapshot).toBeTruthy();
			expect(completeValidation(root, snapshot, fullPass(), deps)).toBe(true);
			expect(verifyValidationReceipt(root, deps)).toMatchObject({ valid: true });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects changed state, tampering, expiry, and incomplete validation', () => {
	const repo = createRepo();
		const deps = { homeDir: repo.homeDir, runtimeIdentity: 'forge-runtime', testRuntimeIdentity: 'bun-a' };
		const mint = () => completeValidation(repo.root, beginValidation(repo.root, deps), fullPass(), deps);
		try {
			expect(mint()).toBe(true);
			expect(verifyValidationReceipt(repo.root, { ...deps, testRuntimeIdentity: 'bun-b' }).valid, 'changed test runtime').toBe(false);

			expect(mint()).toBe(true);
			fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'dirty\n');
			expect(verifyValidationReceipt(repo.root, deps).valid, 'dirty worktree').toBe(false);
			fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'initial\n');

			expect(mint()).toBe(true);
			fs.writeFileSync(path.join(repo.root, 'tracked.txt'), 'new head\n');
			execFileSync('git', ['commit', '-am', 'changed', '-q'], { cwd: repo.root });
			expect(verifyValidationReceipt(repo.root, deps).valid, 'changed head').toBe(false);

			expect(mint()).toBe(true);
			expect(verifyValidationReceipt(repo.root, { ...deps, now: () => Date.now() + (2 * 60 * 60 * 1000) }).valid, 'expired').toBe(false);
			expect(verifyValidationReceipt(repo.root, { ...deps, now: () => Date.now() - (2 * 60 * 1000) }).valid, 'future dated').toBe(false);

			expect(mint()).toBe(true);
			const receiptPath = resolveReceiptPath(repo.root, deps);
			const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
			receipt.payload.head = '0'.repeat(40);
			fs.writeFileSync(receiptPath, JSON.stringify(receipt));
			expect(verifyValidationReceipt(repo.root, deps).valid, 'tampered').toBe(false);

			expect(mint()).toBe(true);
			beginValidation(repo.root, deps);
			expect(verifyValidationReceipt(repo.root, deps).valid, 'later partial validation').toBe(false);

			const snapshot = beginValidation(repo.root, deps);
			const incomplete = fullPass();
			incomplete.checks.tests.total = 0;
			incomplete.checks.tests.testsFound = false;
			expect(completeValidation(repo.root, snapshot, incomplete, deps)).toBe(false);
			expect(verifyValidationReceipt(repo.root, deps).valid).toBe(false);
		} finally {
			fs.rmSync(repo.root, { recursive: true, force: true });
		}
	});
});
