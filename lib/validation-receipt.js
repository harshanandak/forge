'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWorktreeScope } = require('./protected-state-authority');

const SCHEMA_VERSION = 1;
const RECEIPT_TTL_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const RUNNER_ID = 'forge-full-suite-v1';

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
		return { valid: true, head: receipt.payload.head };
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
};
