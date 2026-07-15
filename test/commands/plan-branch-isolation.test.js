// Regression test for kernel issue aa14966c:
// A Forge process must NEVER switch the shared checkout's HEAD branch.
// `/plan` (executePlan -> createFeatureBranch) previously ran `git checkout -b`,
// which flipped the shared working tree onto feat/<slug>, corrupting concurrent
// agents. createFeatureBranch must create the branch WITHOUT switching HEAD.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { createFeatureBranch } = require('../../lib/commands/plan.js');

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function currentBranch(cwd) {
	return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

describe('createFeatureBranch — shared-checkout HEAD isolation (aa14966c)', () => {
	let repoDir;
	let originalCwd;

	beforeEach(() => {
		originalCwd = process.cwd();
		repoDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-headbug-'));
		git(repoDir, ['init', '-b', 'master']);
		git(repoDir, ['config', 'user.email', 'test@example.com']);
		git(repoDir, ['config', 'user.name', 'Test']);
		nodeFs.writeFileSync(nodePath.join(repoDir, 'README.md'), '# test\n');
		git(repoDir, ['add', '.']);
		git(repoDir, ['commit', '-m', 'initial']);
		// createFeatureBranch resolves cwd via process.cwd()
		process.chdir(repoDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		nodeFs.rmSync(repoDir, { recursive: true, force: true });
	});

	test('creates the branch but leaves the shared checkout HEAD on master', () => {
		const before = currentBranch(repoDir);
		expect(before).toBe('master');

		const result = createFeatureBranch('head-isolation-demo');

		expect(result.success).toBe(true);
		expect(result.branchName).toBe('feat/head-isolation-demo');

		// The branch must now exist...
		const branches = git(repoDir, ['branch', '--list', 'feat/head-isolation-demo']);
		expect(branches).toContain('feat/head-isolation-demo');

		// ...but the shared working tree must STILL be on master (no HEAD flip).
		expect(currentBranch(repoDir)).toBe('master');
	});
});
