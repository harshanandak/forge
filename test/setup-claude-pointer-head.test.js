'use strict';

const { describe, test, expect } = require('bun:test');
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
});
