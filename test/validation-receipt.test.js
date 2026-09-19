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
	_pushProof,
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
			typeCheck: { success: true, skipped: true, notConfigured: true },
			lint: { success: true },
			security: { success: true },
			tests: { success: true, fullSuite: true, testsFound: true, total: 12, failed: 0 },
		},
	};
}

describe('validation receipt', () => {
	test('binds receipts to both Bun and Node test runtimes', () => {
		const repo = createRepo();
		const located = command => process.platform === 'win32' ? `C:\\tools\\${command}.exe` : `/tools/${command}`;
		const runtimeExecFileSync = (command, args) => {
			if (args[0] === '--version') return command === 'node' ? '22.1.0\n' : '1.4.2\n';
			return `${located(args[0])}\n`;
		};
		try {
			const first = beginValidation(repo.root, { homeDir: repo.homeDir, runtimeIdentity: 'forge-runtime', runtimeExecFileSync, env: {} });
			const changedNode = beginValidation(repo.root, {
				homeDir: repo.homeDir,
				runtimeIdentity: 'forge-runtime',
				env: {},
				runtimeExecFileSync(command, args) {
					if (args[0] === '--version') return command === 'node' ? '24.0.0\n' : '1.4.2\n';
					return `${located(args[0])}\n`;
				},
			});
			expect(first.testRuntime).not.toBe(changedNode.testRuntime);
		} finally {
			fs.rmSync(repo.root, { recursive: true, force: true });
		}
	});

	test('accepts an immediate complete validation for the unchanged exact head', () => {
		const { root, homeDir } = createRepo();
		const deps = { homeDir, runtimeIdentity: 'forge-runtime', testRuntimeIdentity: 'bun-a' };
		try {
			const snapshot = beginValidation(root, deps);
			expect(snapshot).toBeTruthy();
			expect(completeValidation(root, snapshot, fullPass(), deps)).toBe(true);
			expect(verifyValidationReceipt(root, deps)).toMatchObject({
				valid: true,
				identity: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects changed state, tampering, expiry, failed full-suite, and incomplete validation', () => {
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
			const failedSnapshot = beginValidation(repo.root, deps);
			expect(verifyValidationReceipt(repo.root, deps).valid, 'failed validation cannot reuse prior receipt').toBe(false);
			const failedFullSuite = fullPass();
			failedFullSuite.success = false;
			failedFullSuite.checks.tests.success = false;
			failedFullSuite.checks.tests.failed = 1;
			expect(failedSnapshot).not.toBeNull();
			expect(completeValidation(repo.root, failedSnapshot, failedFullSuite, deps)).toBe(false);
			expect(fs.existsSync(resolveReceiptPath(repo.root, deps)), 'failed validation cannot mint a receipt').toBe(false);

			const snapshot = beginValidation(repo.root, deps);
			const incomplete = fullPass();
			incomplete.checks.tests.total = 0;
			incomplete.checks.tests.testsFound = false;
			expect(completeValidation(repo.root, snapshot, incomplete, deps)).toBe(false);
			expect(verifyValidationReceipt(repo.root, deps).valid).toBe(false);

			const missingTypeScript = fullPass();
			missingTypeScript.checks.typeCheck = { success: true, skipped: true };
			expect(completeValidation(repo.root, beginValidation(repo.root, deps), missingTypeScript, deps)).toBe(false);
		} finally {
			fs.rmSync(repo.root, { recursive: true, force: true });
		}
	});

	test('push proof binds exact clean state and symbolic branch without changing receipt semantics', () => {
		const { root, homeDir } = createRepo();
		const deps = { homeDir, runtimeIdentity: 'forge-runtime', testRuntimeIdentity: 'bun-a' };
		try {
			execFileSync('git', ['switch', '-q', '-c', 'feature'], { cwd: root });
			const snapshot = _pushProof.begin(root, deps);
			const proof = _pushProof.create(root, snapshot, {
				nonce: '00000000-0000-4000-8000-000000000000',
				mode: 'full',
				gates: ['branch-protection', 'lint', 'tests'],
				owner: { pid: 42, identity: 'process-start-a' },
				receiptIdentity: 'fresh-tests',
			}, deps);
			expect(_pushProof.verify(root, proof, {
				nonce: proof.payload.nonce,
				env: {},
			}, deps)).toMatchObject({ valid: true });

			execFileSync('git', ['switch', '-q', '-c', 'main'], { cwd: root });
			expect(_pushProof.verify(root, proof, {
				nonce: proof.payload.nonce,
				env: {},
			}, deps)).toMatchObject({ valid: false, reason: 'state' });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('push proof refuses to bless mutations made after the pre-gate snapshot', () => {
		const { root, homeDir } = createRepo();
		const deps = { homeDir, runtimeIdentity: 'forge-runtime', testRuntimeIdentity: 'bun-a' };
		try {
			const snapshot = _pushProof.begin(root, deps);
			fs.writeFileSync(path.join(root, 'tracked.txt'), 'mutated by gate\n');
			expect(() => _pushProof.create(root, snapshot, {
				nonce: '00000000-0000-4000-8000-000000000000',
				mode: 'full',
				gates: ['branch-protection', 'lint', 'tests'],
				owner: { pid: 42, identity: 'process-start-a' },
				receiptIdentity: 'fresh-tests',
			}, deps)).toThrow('state changed');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('never accepts a signed push proof as a full validation receipt', () => {
		const { root, homeDir } = createRepo();
		const deps = { homeDir, runtimeIdentity: 'forge-runtime', testRuntimeIdentity: 'bun-a' };
		try {
			const snapshot = _pushProof.begin(root, deps);
			const proof = _pushProof.create(root, snapshot, {
				nonce: '00000000-0000-4000-8000-000000000000',
				mode: 'full',
				gates: ['branch-protection', 'lint', 'tests'],
				owner: { pid: 42, identity: 'process-start-a' },
				receiptIdentity: 'fresh-tests',
			}, deps);
			fs.mkdirSync(path.dirname(resolveReceiptPath(root, deps)), { recursive: true });
			fs.writeFileSync(resolveReceiptPath(root, deps), JSON.stringify(proof));

			expect(verifyValidationReceipt(root, deps)).toMatchObject({ valid: false });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
