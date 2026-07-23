'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getDeveloperIdentity, getGitConfig } = require('../../lib/status/identity.js');

// These live in their own module after Slice C deleted lib/status/beads-snapshot.js.
// The identity lookup is backend-agnostic — it reads git config, never an issue store —
// so it must keep working with no Beads store and no kernel store present.
describe('status identity (git-config backed)', () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-identity-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('reads the configured git identity from the project root', () => {
		execFileSync('git', ['init', '--quiet'], { cwd: tmpDir, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpDir, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.name', 'Dev Example'], { cwd: tmpDir, stdio: 'ignore' });

		expect(getDeveloperIdentity(tmpDir)).toEqual({
			email: 'dev@example.com',
			name: 'Dev Example',
		});
	});

	test('returns empty strings instead of throwing when the key is unset', () => {
		execFileSync('git', ['init', '--quiet'], { cwd: tmpDir, stdio: 'ignore' });

		// A repo with no local identity configured must not crash status. The value may
		// still resolve from global git config, so assert the contract (always a string)
		// rather than a specific value the developer machine controls.
		const identity = getDeveloperIdentity(tmpDir);
		expect(typeof identity.email).toBe('string');
		expect(typeof identity.name).toBe('string');
	});

	test('getGitConfig returns an empty string for an unknown key', () => {
		execFileSync('git', ['init', '--quiet'], { cwd: tmpDir, stdio: 'ignore' });

		expect(getGitConfig(tmpDir, 'forge.definitelyNotSet')).toBe('');
	});
});
