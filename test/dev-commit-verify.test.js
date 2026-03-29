/**
 * Tests for verifyTaskCompletion() in dev.js
 * Validates post-task commit verification logic with dependency-injected execFileSync.
 */

const { describe, test, expect } = require('bun:test');
const { verifyTaskCompletion } = require('../lib/commands/dev');

describe('verifyTaskCompletion', () => {
	test('clean working directory returns no changes', () => {
		const mockExec = (cmd, args) => {
			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				return ''; // clean
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		const result = verifyTaskCompletion('add login form', [], { _exec: mockExec });

		expect(result).toEqual({
			committed: false,
			autoCommitted: false,
			commitSha: null,
			hasChanges: false,
		});
	});

	test('dirty working dir with ownedFiles stages only owned files and commits', () => {
		const calls = [];
		const mockExec = (cmd, args) => {
			calls.push({ cmd, args: [...args] });

			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				return ' M lib/commands/dev.js\n M lib/utils/helper.js\n';
			}
			if (cmd === 'git' && args[0] === 'add') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'commit') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'log') {
				return 'abc123def456\n';
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		const ownedFiles = ['lib/commands/dev.js'];
		const result = verifyTaskCompletion('add login form', ownedFiles, { _exec: mockExec });

		expect(result).toEqual({
			committed: true,
			autoCommitted: true,
			commitSha: 'abc123def456',
			hasChanges: true,
		});

		// Verify only owned files were staged (not -A or .)
		const addCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'add');
		expect(addCall).toBeDefined();
		expect(addCall.args).toContain('lib/commands/dev.js');
		expect(addCall.args).not.toContain('lib/utils/helper.js');
		expect(addCall.args).not.toContain('-A');
		expect(addCall.args).not.toContain('.');
	});

	test('dirty working dir without ownedFiles stages only tracked modified files', () => {
		const calls = [];
		const mockExec = (cmd, args) => {
			calls.push({ cmd, args: [...args] });

			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				return ' M lib/commands/dev.js\n?? new-untracked.js\n';
			}
			if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
				return 'lib/commands/dev.js\n';
			}
			if (cmd === 'git' && args[0] === 'add') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'commit') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'log') {
				return 'def789abc012\n';
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		const result = verifyTaskCompletion('implement auth', null, { _exec: mockExec });

		expect(result).toEqual({
			committed: true,
			autoCommitted: true,
			commitSha: 'def789abc012',
			hasChanges: true,
		});

		// Verify git diff --name-only was called to get tracked files
		const diffCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'diff');
		expect(diffCall).toBeDefined();
		expect(diffCall.args).toContain('--name-only');

		// Verify only tracked modified files were staged (not untracked)
		const addCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'add');
		expect(addCall).toBeDefined();
		expect(addCall.args).toContain('lib/commands/dev.js');
		expect(addCall.args).not.toContain('new-untracked.js');
		expect(addCall.args).not.toContain('-A');
		expect(addCall.args).not.toContain('.');
	});

	test('auto-commit message format is feat(task): <taskTitle>', () => {
		const calls = [];
		const mockExec = (cmd, args) => {
			calls.push({ cmd, args: [...args] });

			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				return ' M lib/feature.js\n';
			}
			if (cmd === 'git' && args[0] === 'add') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'commit') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'log') {
				return 'aaa111bbb222\n';
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		verifyTaskCompletion('implement password validation', ['lib/feature.js'], { _exec: mockExec });

		const commitCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'commit');
		expect(commitCall).toBeDefined();
		expect(commitCall.args).toContain('-m');
		const msgIndex = commitCall.args.indexOf('-m') + 1;
		expect(commitCall.args[msgIndex]).toBe('feat(task): implement password validation');
	});

	test('untracked files outside OWNS list are NOT staged', () => {
		const calls = [];
		const mockExec = (cmd, args) => {
			calls.push({ cmd, args: [...args] });

			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				return ' M lib/owned.js\n?? .env\n?? node_modules/pkg/index.js\n';
			}
			if (cmd === 'git' && args[0] === 'add') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'commit') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'log') {
				return 'ccc333ddd444\n';
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		verifyTaskCompletion('secure feature', ['lib/owned.js'], { _exec: mockExec });

		const addCalls = calls.filter(c => c.cmd === 'git' && c.args[0] === 'add');
		for (const addCall of addCalls) {
			expect(addCall.args).not.toContain('.env');
			expect(addCall.args).not.toContain('node_modules/pkg/index.js');
			expect(addCall.args).not.toContain('-A');
			expect(addCall.args).not.toContain('.');
		}
	});

	test('returns commitSha from git log output (trimmed)', () => {
		const mockExec = (cmd, args) => {
			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				return ' M lib/x.js\n';
			}
			if (cmd === 'git' && args[0] === 'add') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'commit') {
				return '';
			}
			if (cmd === 'git' && args[0] === 'log') {
				return '  e5f6a7b8c9d0e1f2  \n';
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		const result = verifyTaskCompletion('trim sha', ['lib/x.js'], { _exec: mockExec });
		expect(result.commitSha).toBe('e5f6a7b8c9d0e1f2');
	});

	test('no files to stage after diff returns empty skips commit', () => {
		const calls = [];
		const mockExec = (cmd, args) => {
			calls.push({ cmd, args: [...args] });

			if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
				// Has untracked files but no tracked modifications
				return '?? random-untracked.txt\n';
			}
			if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
				return ''; // no tracked modified files
			}
			throw new Error(`Unexpected call: ${cmd} ${args.join(' ')}`);
		};

		// No ownedFiles, so falls back to git diff --name-only which returns empty
		const result = verifyTaskCompletion('no tracked changes', null, { _exec: mockExec });

		expect(result).toEqual({
			committed: false,
			autoCommitted: false,
			commitSha: null,
			hasChanges: true,
		});

		// Should NOT have called git add or git commit
		const addCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'add');
		expect(addCall).toBeUndefined();
		const commitCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'commit');
		expect(commitCall).toBeUndefined();
	});
});
