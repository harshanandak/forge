'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setupCommand = require('../lib/commands/setup');

describe('CLAUDE.md pointer authorization source head', () => {
	test('normalizes Git Windows line endings before exact pointer authorization', () => {
		expect(setupCommand.normalizeClaudePointerContent(Buffer.from('@AGENTS.md\r\n'))).toEqual(Buffer.from('@AGENTS.md\n'));
		expect(setupCommand.normalizeClaudePointerContent(Buffer.from('@AGENTS.md\r\nextra\r\n'))).toEqual(Buffer.from('@AGENTS.md\nextra\n'));
	});

	test('passes HEAD^{commit} as argv without shell parsing', () => {
		let call;
		const sourceHead = setupCommand.resolveCurrentSourceHead('C:\\repo', (file, args, options) => {
			call = { file, args, options };
			return Buffer.from('deadbeef\n');
		});

		expect(sourceHead).toBe('deadbeef');
		expect(call).toEqual({
			file: 'git',
			args: ['rev-parse', '--verify', 'HEAD^{commit}'],
			options: { cwd: 'C:\\repo', stdio: 'pipe' },
		});
		expect(call.options.shell).toBeUndefined();
	});

	test('fails closed when source head resolution fails', () => {
		const sourceHead = setupCommand.resolveCurrentSourceHead('C:\\repo', () => {
			throw new Error('git failed');
		});

		expect(sourceHead).toBe('');
	});

	test('reads the exact staged pointer bytes for authorization', () => {
		let call;
		const content = setupCommand.readStagedClaudePointerContent('C:\\repo', (file, args, options) => {
			call = { file, args, options };
			return Buffer.from('@AGENTS.md\n');
		});

		expect(content).toEqual(Buffer.from('@AGENTS.md\n'));
		expect(call).toEqual({
			file: 'git',
			args: ['show', ':CLAUDE.md'],
			options: { cwd: 'C:\\repo', encoding: null, stdio: 'pipe' },
		});
	});

	test('uses clean worktree pointer bytes when the index still has previous content', () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-pointer-'));
		try {
			fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), Buffer.from('@AGENTS.md\r\n'));
			const calls = [];
			const content = setupCommand.readStagedClaudePointerContent(cwd, (file, args, options) => {
				calls.push({ file, args, options });
				if (args[0] === 'show') return calls.length === 1 ? Buffer.from('previous-content\n') : Buffer.from('@AGENTS.md\r\n');
				return Buffer.alloc(0);
			});

			expect(content).toEqual(Buffer.from('@AGENTS.md\r\n'));
			expect(calls.map(call => call.args)).toEqual([
				['show', ':CLAUDE.md'],
				['read-tree', 'HEAD'],
				['add', '--', 'CLAUDE.md'],
				['show', ':CLAUDE.md'],
			]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('cleans untracked pointer bytes using Git filters before authorization', () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-pointer-'));
		try {
			fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), Buffer.from('@AGENTS.md\r\n'));
			const calls = [];
			const content = setupCommand.readStagedClaudePointerContent(cwd, (file, args, options) => {
				calls.push({ file, args, options });
				if (args[0] === 'show' && calls.length === 1) {
					const error = new Error('untracked');
					error.status = 128;
					throw error;
				}
				if (args[0] === 'ls-files') {
					const error = new Error('not tracked');
					error.status = 1;
					throw error;
				}
				if (args[0] === 'show') return Buffer.from('@AGENTS.md\r\n');
				return Buffer.alloc(0);
			});

			expect(content).toEqual(Buffer.from('@AGENTS.md\r\n'));
			expect(calls.map(call => call.args)).toEqual([
				['show', ':CLAUDE.md'],
				['ls-files', '--error-unmatch', '--', 'CLAUDE.md'],
				['read-tree', 'HEAD'],
				['add', '--', 'CLAUDE.md'],
				['show', ':CLAUDE.md'],
			]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('does not authorize worktree bytes when the index lookup fails for a tracked file', () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-pointer-'));
		try {
			fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), Buffer.from('@AGENTS.md\r\n'));
			expect(() => setupCommand.readStagedClaudePointerContent(cwd, (file, args) => {
				if (args[0] === 'show') {
					const error = new Error('index read failed');
					error.status = 128;
					throw error;
				}
				return Buffer.from('CLAUDE.md');
			})).toThrow('index read failed');
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
