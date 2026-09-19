'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWorktreeScope } = require('./protected-state-authority');
const { QUICK_LANE_ENV_VAR, QUICK_LANE_VALUE } = require('../scripts/test');

const SCHEMA_VERSION = 1;
const RECEIPT_TTL_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const RUNNER_ID = 'forge-full-suite-v1';
const PUSH_PROOF_SCHEMA_VERSION = 1;
const PUSH_MODES = Object.freeze({
	full: Object.freeze(['branch-protection', 'lint', 'tests']),
	quick: Object.freeze(['branch-protection', 'lint']),
});

function git(projectRoot, args, deps = {}) {
	return (deps.execFileSync || execFileSync)('git', args, {
		cwd: projectRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function resolveGitRoot(projectRoot, deps = {}) {
	return path.resolve(git(projectRoot, ['rev-parse', '--show-toplevel'], deps));
}

function resolveReceiptPath(projectRoot, deps = {}) {
	const root = resolveGitRoot(projectRoot, deps);
	const gitPath = git(root, ['rev-parse', '--git-path', 'forge/validation-receipt.json'], deps);
	return path.resolve(root, gitPath);
}

function resolveKeyPath(deps = {}) {
	return path.join(deps.homeDir || os.homedir(), '.forge', 'validation-receipt.key');
}

function runtimeIdentity(deps = {}) {
	return deps.runtimeIdentity
		|| [process.platform, process.arch, process.versions.node, process.versions.bun || 'node'].join(':');
}

function commandIdentity(command, projectRoot, env, run) {
	const version = run(command, ['--version'], {
		cwd: projectRoot,
		encoding: 'utf8',
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
	const located = path.isAbsolute(command)
		? fs.realpathSync.native(command)
		: run(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
			encoding: 'utf8',
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim().split(/\r?\n/)[0];
	return `${process.platform === 'win32' ? located.toLowerCase() : located}:${version}`;
}

function testRuntimeIdentity(projectRoot, deps = {}) {
	if (deps.testRuntimeIdentity) return deps.testRuntimeIdentity;
	const env = deps.env || process.env;
	const run = deps.runtimeExecFileSync || execFileSync;
	return [env.BUN_EXE || 'bun', 'node']
		.map(command => commandIdentity(command, projectRoot, env, run))
		.join('|');
}

function captureState(projectRoot, deps = {}) {
	const root = resolveGitRoot(projectRoot, deps);
	return {
		worktree: resolveWorktreeScope(root, deps),
		head: git(root, ['rev-parse', 'HEAD'], deps),
		clean: git(root, ['status', '--porcelain=v1', '--untracked-files=all'], deps) === '',
		runtime: runtimeIdentity(deps),
		testRuntime: testRuntimeIdentity(root, deps),
		runner: RUNNER_ID,
	};
}

function sameState(left, right) {
	return left?.clean === true
		&& right?.clean === true
		&& left.worktree === right.worktree
		&& left.head === right.head
		&& left.runtime === right.runtime
		&& left.testRuntime === right.testRuntime
		&& left.runner === right.runner;
}

function capturePushState(projectRoot, deps = {}) {
	if (deps.capturePushState) return deps.capturePushState(projectRoot);
	const root = resolveGitRoot(projectRoot, deps);
	return {
		...captureState(root, deps),
		branch: git(root, ['symbolic-ref', '--quiet', 'HEAD'], deps),
	};
}

function samePushState(left, right) {
	return sameState(left, right) && left?.branch === right?.branch;
}

function hasExactGates(mode, gates) {
	if (mode !== 'full' && mode !== 'quick') return false;
	const expected = PUSH_MODES[mode];
	return Boolean(expected)
		&& Array.isArray(gates)
		&& gates.length === expected.length
		&& gates.every((gate, index) => gate === expected[index]);
}

function beginPushProof(projectRoot, deps = {}) {
	try {
		const state = capturePushState(projectRoot, deps);
		return state.clean ? state : null;
	} catch {
		return null;
	}
}

function createPushProof(projectRoot, snapshot, claims, deps = {}) {
	if (!snapshot) throw new Error('push proof requires a clean pre-gate snapshot');
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims?.nonce || '')) {
		throw new Error('push proof requires a valid nonce');
	}
	if (!hasExactGates(claims?.mode, claims?.gates)) throw new Error('push proof gates do not match mode');
	if (!Number.isInteger(claims?.owner?.pid) || claims.owner.pid <= 0 || typeof claims.owner.identity !== 'string' || !claims.owner.identity) {
		throw new Error('push proof requires an exact process owner');
	}
	if (claims.mode === 'full' && (typeof claims.receiptIdentity !== 'string' || !claims.receiptIdentity)) {
		throw new Error('full push proof requires test evidence identity');
	}
	const current = capturePushState(projectRoot, deps);
	if (!samePushState(snapshot, current)) throw new Error('push proof state changed during gates');
	const payload = {
		schemaVersion: PUSH_PROOF_SCHEMA_VERSION,
		type: 'forge-push-invocation',
		nonce: claims.nonce,
		state: current,
		mode: claims.mode,
		gates: [...claims.gates],
		owner: { ...claims.owner },
		receiptIdentity: claims.receiptIdentity || null,
	};
	return { payload, signature: sign(payload, deps) };
}

function verifyPushProof(projectRoot, proof, expected, deps = {}) {
	try {
		const payload = proof?.payload;
		if (payload?.schemaVersion !== PUSH_PROOF_SCHEMA_VERSION || payload.type !== 'forge-push-invocation') {
			return { valid: false, reason: 'schema' };
		}
		if (payload.nonce !== expected?.nonce) return { valid: false, reason: 'nonce' };
		if (!signatureMatches(payload, proof.signature, deps)) return { valid: false, reason: 'signature' };
		if (!hasExactGates(payload.mode, payload.gates)) return { valid: false, reason: 'gates' };
		const quickLane = expected?.env?.[QUICK_LANE_ENV_VAR] === QUICK_LANE_VALUE;
		if ((payload.mode === 'quick') !== quickLane) return { valid: false, reason: 'mode' };
		if (payload.mode === 'full' && (typeof payload.receiptIdentity !== 'string' || !payload.receiptIdentity)) {
			return { valid: false, reason: 'test-evidence' };
		}
		if (!samePushState(payload.state, capturePushState(projectRoot, deps))) {
			return { valid: false, reason: 'state' };
		}
		return { valid: true, payload };
	} catch {
		return { valid: false, reason: 'missing-or-invalid' };
	}
}

function validationIsComplete(result) {
	const checks = result?.checks || {};
	const tests = checks.tests || {};
	return result?.success === true
		&& checks.conflictMarkers?.success === true
		&& checks.typeCheck?.success === true
		&& (checks.typeCheck.skipped !== true || checks.typeCheck.notConfigured === true)
		&& checks.lint?.success === true && checks.lint?.skipped !== true
		&& checks.security?.success === true && checks.security?.skipped !== true
		&& tests.success === true && tests.skipped !== true
		&& tests.fullSuite === true && tests.testsFound === true
		&& tests.total > 0 && tests.failed === 0;
}

function readOrCreateKey(deps = {}) {
	const keyPath = resolveKeyPath(deps);
	fs.mkdirSync(path.dirname(keyPath), { recursive: true });
	try {
		fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
	}
	return fs.readFileSync(keyPath);
}

function sign(payload, deps = {}) {
	return crypto.createHmac('sha256', readOrCreateKey(deps))
		.update(JSON.stringify(payload))
		.digest('hex');
}

function signatureMatches(payload, signature, deps = {}) {
	if (!/^[a-f0-9]{64}$/.test(signature || '')) return false;
	const expected = Buffer.from(sign(payload, deps), 'hex');
	const actual = Buffer.from(signature, 'hex');
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function writeAtomic(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
		fs.renameSync(temporary, filePath);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function beginValidation(projectRoot, deps = {}) {
	try {
		fs.rmSync(resolveReceiptPath(projectRoot, deps), { force: true });
		const state = captureState(projectRoot, deps);
		return state.clean ? state : null;
	} catch {
		return null;
	}
}

function completeValidation(projectRoot, snapshot, result, deps = {}) {
	try {
		if (!snapshot || !validationIsComplete(result)) return false;
		const current = captureState(projectRoot, deps);
		if (!sameState(snapshot, current)) return false;
		const issuedAt = (deps.now || Date.now)();
		const payload = {
			schemaVersion: SCHEMA_VERSION,
			...current,
			issuedAt,
			expiresAt: issuedAt + RECEIPT_TTL_MS,
			gates: ['conflictMarkers', 'typeCheck', 'lint', 'security', 'tests'],
		};
		writeAtomic(resolveReceiptPath(projectRoot, deps), JSON.stringify({ payload, signature: sign(payload, deps) }));
		return true;
	} catch {
		return false;
	}
}

function verifyValidationReceipt(projectRoot, deps = {}) {
	try {
		const receipt = JSON.parse(fs.readFileSync(resolveReceiptPath(projectRoot, deps), 'utf8'));
		if (receipt?.payload?.schemaVersion !== SCHEMA_VERSION) return { valid: false, reason: 'schema' };
		if (!signatureMatches(receipt.payload, receipt.signature, deps)) return { valid: false, reason: 'signature' };
		const now = (deps.now || Date.now)();
		if (receipt.payload.issuedAt > now + FUTURE_SKEW_MS) return { valid: false, reason: 'future' };
		if (receipt.payload.expiresAt < now) return { valid: false, reason: 'expired' };
		if (!sameState(receipt.payload, captureState(projectRoot, deps))) return { valid: false, reason: 'state' };
		return { valid: true, head: receipt.payload.head, identity: receipt.signature };
	} catch {
		return { valid: false, reason: 'missing-or-invalid' };
	}
}

module.exports = {
	beginValidation,
	completeValidation,
	resolveReceiptPath,
	validationIsComplete,
	verifyValidationReceipt,
	_pushProof: {
		begin: beginPushProof,
		create: createPushProof,
		verify: verifyPushProof,
	},
};
