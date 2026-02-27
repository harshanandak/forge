const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
	parseArgs,
	isValidCommand,
	validateArgs,
	validateSlug,
	getHelpText,
} = require('../../bin/forge-cmd.js');

describe('CLI Command Dispatcher', () => {
	describe('parseArgs', () => {
		test('should parse command without arguments', () => {
			const args = ['node', 'forge-cmd.js', 'status'];
			const result = parseArgs(args);
			expect(result.command).toBe('status');
			expect(result.args).toEqual([]);
		});

		test('should parse command with single argument', () => {
			const args = ['node', 'forge-cmd.js', 'plan', 'stripe-billing'];
			const result = parseArgs(args);
			expect(result.command).toBe('plan');
			expect(result.args).toEqual(['stripe-billing']);
		});

		test('should parse command with multiple arguments', () => {
			const args = ['node', 'forge-cmd.js', 'review', '123'];
			const result = parseArgs(args);
			expect(result.command).toBe('review');
			expect(result.args).toEqual(['123']);
		});

		test('should handle no command (show help)', () => {
			const args = ['node', 'forge-cmd.js'];
			const result = parseArgs(args);
			expect(result.command).toBe(null);
		});
	});

	describe('Command validation', () => {
		test('should reject unknown command', () => {
			const command = 'unknown-command';
			const isValid = isValidCommand(command);
			expect(isValid).toBe(false);
		});

		test('should accept valid commands', () => {
			const validCommands = [
				'status',
				'plan',
				'dev',
				'check',
				'ship',
				'review',
				'merge',
				'verify',
			];

			for (const command of validCommands) {
				const isValid = isValidCommand(command);
				expect(isValid).toBe(true);
			}
		});
	});

	describe('Security: Slug validation', () => {
		test('should accept valid slugs', () => {
			const validSlugs = [
				'stripe-billing',
				'user-auth',
				'api-v2',
				'test123',
				'feature-name',
			];

			for (const slug of validSlugs) {
				const result = validateSlug(slug);
				expect(result.valid).toBe(true);
			}
		});

		test('should reject slugs with uppercase letters', () => {
			const result = validateSlug('Feature-Name');
			expect(result.valid).toBe(false);
			expect(result.error).toMatch(/lowercase/i);
		});

		test('should reject slugs with spaces', () => {
			const result = validateSlug('feature name');
			expect(result.valid).toBe(false);
			expect(result.error).toMatch(/invalid slug format/i);
		});

		test('should reject path traversal attempts', () => {
			const invalidSlugs = [
				'../../../etc/passwd',
				String.raw`..\\windows\\system32`,
				'test/../evil',
			];

			for (const slug of invalidSlugs) {
				const result = validateSlug(slug);
				expect(result.valid).toBe(false);
			}
		});

		test('should reject slugs with special characters', () => {
			const invalidSlugs = [
				'test;rm -rf /',
				'test&whoami',
				'test|cat /etc/passwd',
			];

			for (const slug of invalidSlugs) {
				const result = validateSlug(slug);
				expect(result.valid).toBe(false);
			}
		});
	});

	describe('Argument validation', () => {
		test('should reject plan without feature slug', () => {
			const command = 'plan';
			const args = [];
			const validation = validateArgs(command, args);
			expect(validation.valid).toBe(false);
			expect(validation.error).toMatch(/feature-slug required/i);
		});

		test('should accept review without PR number (guided stage, no args required)', () => {
			const command = 'review';
			const args = [];
			const validation = validateArgs(command, args);
			expect(validation.valid).toBe(true); // review/merge are guided stages, pr-number is optional
		});

		test('should accept status without arguments', () => {
			const command = 'status';
			const args = [];
			const validation = validateArgs(command, args);
			expect(validation.valid).toBe(true);
		});

		test('should reject plan with path traversal attempt', () => {
			const command = 'plan';
			const args = ['../../../etc/passwd'];
			const validation = validateArgs(command, args);
			expect(validation.valid).toBe(false);
		});
	});

	describe('Help text', () => {
		test('should display help with available commands', () => {
			const helpText = getHelpText();
			expect(helpText).toMatch(/forge <command>/i);
			expect(helpText).toMatch(/status/i);
			expect(helpText).toMatch(/plan/i);
		});

		test('should include command descriptions', () => {
			const helpText = getHelpText();
			expect(helpText).toMatch(/detect current workflow stage/i);
			expect(helpText).toMatch(/create branch/i);
		});
	});

	describe('Error handling', () => {
		const CLI = path.join(__dirname, '../../bin/forge-cmd.js');

		test('should exit with code 1 for unknown command', () => {
			const result = spawnSync(process.execPath, [CLI, 'unknown-command'], { encoding: 'utf8' });
			expect(result.status).toBe(1);
		});

		test('should exit with code 1 for missing required arguments', () => {
			// 'plan' requires <feature-slug> — fails at validateArgs before any handler runs
			const result = spawnSync(process.execPath, [CLI, 'plan'], { encoding: 'utf8' });
			expect(result.status).toBe(1);
		});

		test('should exit with code 0 for successful execution', () => {
			// 'status' reads filesystem/git (all try/catch) — no network, exits 0
			const result = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', timeout: 10000 });
			expect(result.status).toBe(0);
		});
	});
});
