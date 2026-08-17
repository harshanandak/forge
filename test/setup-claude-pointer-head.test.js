'use strict';

const { describe, test, expect } = require('bun:test');
const setupCommand = require('../lib/commands/setup');

describe('CLAUDE.md pointer authorization source head', () => {
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
});
