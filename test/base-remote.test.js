const { describe, test, expect } = require('bun:test');

const {
	resolveBaseRemote,
	resolveBaseBranch,
	resolveRemoteHeadTarget,
	remoteHasTrackingBase,
} = require('../lib/base-remote');
const ship = require('../lib/commands/ship');

function fakeExec(responses) {
	return (command, args, options) => {
		expect(command).toBe('git');
		expect(options && options.stdio).toBe('pipe');
		const key = args.join(' ');
		if (!Object.prototype.hasOwnProperty.call(responses, key)) {
			throw new Error(`Unexpected git command: ${key}`);
		}
		const value = responses[key];
		if (value instanceof Error) throw value;
		return value;
	};
}

describe('lib/base-remote', () => {
	test('prefers upstream over origin as the base remote', () => {
		const exec = fakeExec({
			'remote get-url upstream': 'https://github.com/base/repo.git\n',
			'symbolic-ref refs/remotes/upstream/HEAD': 'refs/remotes/upstream/main\n',
			'rev-parse --verify refs/remotes/upstream/main': 'refs/remotes/upstream/main\n',
		});

		expect(resolveBaseRemote(exec, '/repo')).toBe('upstream');
	});

	test('falls back to origin when upstream has no fetched tracking refs', () => {
		const exec = fakeExec({
			'remote get-url upstream': 'https://github.com/base/repo.git\n',
			'symbolic-ref refs/remotes/upstream/HEAD': new Error('no HEAD'),
			'rev-parse --verify refs/remotes/upstream/main': new Error('missing'),
			'rev-parse --verify refs/remotes/upstream/master': new Error('missing'),
			'remote get-url origin': 'https://github.com/fork/repo.git\n',
			'symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/master\n',
			'rev-parse --verify refs/remotes/origin/master': 'refs/remotes/origin/master\n',
		});

		expect(resolveBaseRemote(exec, '/repo')).toBe('origin');
	});

	test('falls back to origin when no remote qualifies', () => {
		const exec = fakeExec({
			'remote get-url upstream': new Error('no upstream'),
			'remote get-url origin': new Error('no origin'),
		});

		expect(resolveBaseRemote(exec, '/repo')).toBe('origin');
	});

	test('resolves the base branch from the remote HEAD', () => {
		const exec = fakeExec({
			'symbolic-ref refs/remotes/upstream/HEAD': 'refs/remotes/upstream/release/2026\n',
			'rev-parse --verify refs/remotes/upstream/release/2026': 'refs/remotes/upstream/release/2026\n',
		});

		expect(resolveBaseBranch(exec, '/repo', 'upstream')).toBe('release/2026');
	});

	test('falls back to master when the base branch cannot be resolved', () => {
		const exec = fakeExec({
			'symbolic-ref refs/remotes/upstream/HEAD': new Error('no HEAD'),
			'rev-parse --verify refs/remotes/upstream/main': new Error('missing'),
			'rev-parse --verify refs/remotes/upstream/master': new Error('missing'),
		});

		expect(resolveBaseBranch(exec, '/repo', 'upstream')).toBe('master');
	});

	test('reports a missing remote HEAD as null and no tracking base', () => {
		const exec = fakeExec({
			'symbolic-ref refs/remotes/origin/HEAD': new Error('no HEAD'),
			'rev-parse --verify refs/remotes/origin/main': new Error('missing'),
			'rev-parse --verify refs/remotes/origin/master': new Error('missing'),
		});

		expect(resolveRemoteHeadTarget(exec, '/repo', 'origin')).toBeNull();
		expect(remoteHasTrackingBase(exec, '/repo', 'origin')).toBe(false);
	});

	// One implementation, two surfaces: `/ship` picks the PR base with these, and
	// scripts/protected-state-check.js resolves merge provenance with them. If they
	// ever diverge, a fork-published protected change could pass the ancestry gate.
	test('ship re-exports the shared resolver rather than duplicating it', () => {
		expect(ship.resolveBaseRemote).toBe(resolveBaseRemote);
		expect(ship.resolveBaseBranch).toBe(resolveBaseBranch);
	});

	test('the protected-state check consumes the shared resolver', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'protected-state-check.js'), 'utf8');
		expect(source).toContain("require('../lib/base-remote')");
		expect(source).toContain('resolveBaseRemote(');
	});
});
