// Regression tests for kernel issue aa14966c + the composed plan-first flow.
//
// 1. HEAD isolation: a Forge process must NEVER switch the shared checkout's
//    HEAD. `/plan` (executePlan -> createFeatureBranch) previously ran
//    `git checkout -b`, which flipped the shared working tree onto feat/<slug>,
//    corrupting concurrent agents. createFeatureBranch must create the branch
//    WITHOUT switching HEAD.
//
// 2. Reachability: because HEAD does NOT move, the branch->issue linkage plan
//    registers for feat/<slug> is only reachable from a checkout whose HEAD is
//    ON feat/<slug> (an isolated worktree, or a solo `git switch`). This test
//    derives the branch from HEAD the way the CLI does (detectWorktree, which
//    detectBranchName wraps) and drives the REAL enforce-stage reader
//    (resolveActiveIssueId) — it does NOT inject `branch:` explicitly. From the
//    shared tree (HEAD on master) resolution is null (the ship dead-end); from a
//    worktree on feat/<slug> it resolves the issue (ship reachable).
//
// 3. Guidance: when plan creates a fresh branch it must tell the user to enter
//    an isolated checkout before stage commands — never a bare "Next: /dev" that
//    would run /dev from master.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const {
	createFeatureBranch,
	registerBranchIssueLinkage,
	handler,
} = require('../../lib/commands/plan.js');
const { resolveActiveIssueId } = require('../../lib/workflow/enforce-stage.js');
const { detectWorktree } = require('../../lib/detect-worktree.js');

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: GIT_ENV }).trim();
}

function initRepo() {
	const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-headbug-'));
	git(dir, ['init', '-b', 'master']);
	git(dir, ['config', 'user.email', 'test@example.com']);
	git(dir, ['config', 'user.name', 'Test']);
	nodeFs.writeFileSync(nodePath.join(dir, 'README.md'), '# test\n');
	git(dir, ['add', '.']);
	git(dir, ['commit', '-m', 'initial']);
	return dir;
}

// In-memory stand-in for the kernel worktree registry: the same shape plan
// writes (registerWorktree) and enforce-stage reads (listWorktrees, newest first).
function makeRegistryDriver() {
	const rows = [];
	return {
		registerWorktree(row) { rows.unshift(row); },
		listWorktrees() { return rows; },
	};
}

describe('createFeatureBranch — shared-checkout HEAD isolation (aa14966c)', () => {
	let repoDir;
	let originalCwd;

	beforeEach(() => {
		originalCwd = process.cwd();
		repoDir = initRepo();
		process.chdir(repoDir); // createFeatureBranch resolves cwd via process.cwd()
	});

	afterEach(() => {
		process.chdir(originalCwd);
		nodeFs.rmSync(repoDir, { recursive: true, force: true });
	});

	test('creates the branch but leaves the shared checkout HEAD on master', () => {
		expect(git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master');

		const result = createFeatureBranch('head-isolation-demo');

		expect(result.success).toBe(true);
		expect(result.branchName).toBe('feat/head-isolation-demo');

		// The branch must now exist...
		expect(git(repoDir, ['branch', '--list', 'feat/head-isolation-demo']))
			.toContain('feat/head-isolation-demo');

		// ...but the shared working tree must STILL be on master (no HEAD flip).
		expect(git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master');
	});
});

describe('plan-first reachability — branch derived from HEAD (aa14966c composition)', () => {
	let repoDir;
	let wtDir;
	let originalCwd;

	beforeEach(() => {
		originalCwd = process.cwd();
		repoDir = initRepo();
		process.chdir(repoDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (wtDir) nodeFs.rmSync(wtDir, { recursive: true, force: true });
		nodeFs.rmSync(repoDir, { recursive: true, force: true });
		wtDir = undefined;
	});

	test('linkage is unreachable from master (dead-end) but reachable from a worktree on feat/<slug>', async () => {
		const driver = makeRegistryDriver();
		const ISSUE_ID = 'kernel-reach-1';

		// Simulate `/plan`: create the branch (HEAD stays on master) and register
		// the branch->issue linkage exactly as executePlan does.
		const branch = createFeatureBranch('head-reach-demo');
		expect(branch.success).toBe(true);
		await registerBranchIssueLinkage({ projectRoot: repoDir, driver }, branch.branchName, ISSUE_ID);

		// The CLI derives the branch from HEAD (detectWorktree == detectBranchName's
		// source). From the shared tree HEAD is master → NO linkage row → null.
		// This is the exact ship dead-end the honest next-step guidance prevents.
		const branchFromSharedTree = detectWorktree(repoDir).branch;
		expect(branchFromSharedTree).toBe('master');
		expect(await resolveActiveIssueId(driver, branchFromSharedTree)).toBeNull();

		// Follow the honest next step: enter an isolated worktree ON feat/<slug>.
		wtDir = nodePath.join(nodePath.dirname(repoDir), `${nodePath.basename(repoDir)}-wt`);
		git(repoDir, ['worktree', 'add', wtDir, branch.branchName]);

		// Now the CLI-derived branch is feat/<slug> and resolution reaches the issue
		// → /dev, /validate, /ship resolve authoritative state (no null dead-end).
		const branchFromWorktree = detectWorktree(wtDir).branch;
		expect(branchFromWorktree).toBe('feat/head-reach-demo');
		expect(await resolveActiveIssueId(driver, branchFromWorktree)).toBe(ISSUE_ID);
	});
});

describe('plan guidance — fresh branch must direct into an isolated checkout', () => {
	let originalCwd;
	let repoDir;
	let prevBackend;

	beforeEach(() => {
		originalCwd = process.cwd();
		repoDir = initRepo();
		nodeFs.mkdirSync(nodePath.join(repoDir, 'docs', 'research'), { recursive: true });
		nodeFs.writeFileSync(
			nodePath.join(repoDir, 'docs', 'research', 'head-guidance-demo.md'),
			'# Head Guidance Demo\n\n**Timeline**: 2 hours\n**Strategic/Tactical**: Tactical\n',
		);
		prevBackend = process.env.FORGE_ISSUE_BACKEND;
		delete process.env.FORGE_ISSUE_BACKEND; // default resolver → kernel
		process.chdir(repoDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (prevBackend === undefined) delete process.env.FORGE_ISSUE_BACKEND;
		else process.env.FORGE_ISSUE_BACKEND = prevBackend;
		nodeFs.rmSync(repoDir, { recursive: true, force: true });
	});

	test('output points into a worktree / git switch, not a bare "Next: /dev" from master', async () => {
		const fakeRun = async () => ({ ok: true, command: 'issue.create', data: { id: 'kernel-guid-1' }, next_commands: [] });

		const result = await handler(['head guidance demo'], {}, repoDir, { runIssueOperation: fakeRun });

		expect(result.success).toBe(true);
		expect(result.branchCreated).toBe(true);
		// Honest next step: enter isolation on the created branch before stage cmds.
		expect(result.output).toContain('forge worktree create head-guidance-demo');
		expect(result.output).toContain('git switch feat/head-guidance-demo');
		// It must NOT tell the user to just run /dev from the current (master) tree.
		expect(result.output).not.toContain('Next: /dev');
	});
});
