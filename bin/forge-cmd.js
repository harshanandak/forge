#!/usr/bin/env node

/**
 * Forge CLI Command Dispatcher
 * Executable automation for Forge workflow stages
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

// Command handlers - connected to lib/commands/
const HANDLERS = {
	status: require('../lib/commands/status'),
	research: require('../lib/commands/research'),
	plan: require('../lib/commands/plan'),
	dev: require('../lib/commands/dev'),
	check: require('../lib/commands/check'),
	ship: require('../lib/commands/ship'),
};

const VALID_COMMANDS = [
	'status',
	'research',
	'plan',
	'dev',
	'check',
	'ship',
	'review',
	'merge',
	'verify',
];

const COMMAND_DESCRIPTIONS = {
	status: 'Detect current workflow stage (1-9)',
	research: 'Auto-invoke parallel-ai for web research',
	plan: 'Create branch + Beads + OpenSpec proposal',
	dev: 'Implement with TDD (RED-GREEN-REFACTOR)',
	check: 'Run type check, lint, security, tests',
	ship: 'Auto-generate PR body and create PR',
	review: 'Aggregate all review feedback',
	merge: 'Update docs, merge PR, cleanup',
	verify: 'Final documentation verification',
};

const REQUIRED_ARGS = {
	research: ['feature-name'],
	plan: ['feature-slug'],
	review: ['pr-number'],
	merge: ['pr-number'],
	// Other commands don't require arguments
	status: [],
	dev: [],
	check: [],
	ship: [],
	verify: [],
};

/**
 * Parse command line arguments
 * @param {string[]} argv - Process arguments
 * @returns {{command: string|null, args: string[]}}
 */
function parseArgs(argv) {
	// Skip 'node' and script name
	const args = argv.slice(2);

	if (args.length === 0) {
		return { command: null, args: [] };
	}

	const command = args[0];
	const commandArgs = args.slice(1);

	return { command, args: commandArgs };
}

/**
 * Check if command is valid
 * @param {string} command - Command to validate
 * @returns {boolean}
 */
function isValidCommand(command) {
	return VALID_COMMANDS.includes(command);
}

const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 100;

/**
 * Validate slug format (security: prevent path traversal, command injection)
 * @param {string} slug - Feature slug to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateSlug(slug) {
	// Security: Enforce length limits to prevent resource exhaustion (OWASP A01)
	if (!slug || slug.length < MIN_SLUG_LENGTH) {
		return {
			valid: false,
			error: `Error: Slug too short (minimum ${MIN_SLUG_LENGTH} characters)\n\nExample: stripe-billing, user-auth, api-v2`,
		};
	}
	if (slug.length > MAX_SLUG_LENGTH) {
		return {
			valid: false,
			error: `Error: Slug too long (maximum ${MAX_SLUG_LENGTH} characters)`,
		};
	}

	// Security: Only allow lowercase letters, numbers, and hyphens
	const slugPattern = /^[a-z0-9-]+$/;
	if (!slugPattern.test(slug)) {
		return {
			valid: false,
			error: `Error: Invalid slug format '${slug}'\n\nSlug must contain only lowercase letters, numbers, and hyphens\nExample: stripe-billing, user-auth, api-v2`,
		};
	}

	// Security: Prevent path traversal attempts
	if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
		return {
			valid: false,
			error: `Error: Invalid slug '${slug}'\n\nPath traversal not allowed`,
		};
	}

	return { valid: true };
}

/**
 * Validate command arguments
 * @param {string} command - Command name
 * @param {string[]} args - Command arguments
 * @returns {{valid: boolean, error?: string}}
 */
function validateArgs(command, args) {
	const required = REQUIRED_ARGS[command] || [];

	if (required.length > 0 && args.length === 0) {
		const argName = required[0];
		return {
			valid: false,
			error: `Error: ${argName} required\n\nUsage: forge ${command} <${argName}>`,
		};
	}

	// Security: Validate slug format for slug-based commands
	const slugCommands = ['research', 'plan'];
	if (slugCommands.includes(command) && args.length > 0) {
		const slugValidation = validateSlug(args[0]);
		if (!slugValidation.valid) {
			return slugValidation;
		}
	}

	return { valid: true };
}

/**
 * Get help text
 * @returns {string}
 */
function getHelpText() {
	const lines = [
		'',
		'Forge CLI - Executable workflow automation',
		'',
		'Usage: forge <command> [args]',
		'',
		'Commands:',
	];

	for (const command of VALID_COMMANDS) {
		const desc = COMMAND_DESCRIPTIONS[command];
		lines.push(`  ${command.padEnd(12)} ${desc}`);
	}

	lines.push('');
	lines.push('Examples:');
	lines.push('  forge status                    # Check current workflow stage');
	lines.push('  forge research stripe-billing   # Research feature');
	lines.push('  forge plan stripe-billing       # Create implementation plan');
	lines.push('  forge ship                      # Create PR');
	lines.push('  forge review 123                # Aggregate PR feedback');
	lines.push('');

	return lines.join('\n');
}

/**
 * Main dispatcher
 */
async function main() {
	const { command, args } = parseArgs(process.argv);

	// No command - show help
	if (!command) {
		console.log(getHelpText());
		process.exit(0);
	}

	// Invalid command
	if (!isValidCommand(command)) {
		console.error(`Error: Unknown command '${command}'`);
		console.log(getHelpText());
		process.exit(1);
	}

	// Validate arguments
	const validation = validateArgs(command, args);
	if (!validation.valid) {
		console.error(validation.error);
		process.exit(1);
	}

	// Execute command
	try {
		console.log(`Executing: forge ${command}${args.length > 0 ? ' ' + args.join(' ') : ''}`);
		console.log('');

		let result;

		if (command === 'status') {
			// Gather context from git + filesystem
			const branch = (() => {
				try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(); }  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
				catch (_e) { return 'master'; }
			})();
			const context = {
				branch,
				researchDoc: fs.existsSync('docs/research') ? fs.readdirSync('docs/research').find(f => f.endsWith('.md')) : null,
				plan: fs.existsSync('.claude/plans') ? fs.readdirSync('.claude/plans').find(f => f.endsWith('.md')) : null,
				tests: (() => { try { return fs.readdirSync('test').filter(f => f.endsWith('.test.js')); } catch (_e) { return []; } })(),
			};
			const stageResult = HANDLERS.status.detectStage(context);
			console.log(HANDLERS.status.formatStatus(stageResult));
			result = stageResult;

		} else if (command === 'research') {
			result = await HANDLERS.research.executeResearch(args[0]);
			if (result.success) {
				console.log(`✓ Research complete: ${result.researchDocPath || ''}`);
			} else {
				console.error(`✗ Research failed: ${result.error}`);
				process.exit(1);
			}

		} else if (command === 'plan') {
			result = await HANDLERS.plan.executePlan(args[0]);
			if (result.success) {
				console.log(`✓ Plan created: ${result.summary || result.branchName || ''}`);
				if (result.beadsIssueId) console.log(`  Beads: ${result.beadsIssueId}`);
			} else {
				console.error(`✗ Plan failed: ${result.error}`);
				process.exit(1);
			}

		} else if (command === 'dev') {
			const featureName = args[0] || 'feature';
			const phase = args[1] ? args[1].toUpperCase() : undefined;
			result = await HANDLERS.dev.executeDev(featureName, { phase });
			if (result.success) {
				console.log(`✓ TDD Phase: ${result.phase || result.detectedPhase}`);
				if (result.guidance) console.log('\n' + result.guidance);
			} else {
				console.error(`✗ Dev failed: ${result.error}`);
				process.exit(1);
			}

		} else if (command === 'check') {
			result = await HANDLERS.check.executeCheck();
			if (result.success) {
				console.log(`✓ ${result.summary}`);
			} else {
				console.error(`✗ ${result.summary}`);
				if (result.failedChecks) console.error(`  Failed: ${result.failedChecks.join(', ')}`);
				process.exit(1);
			}

		} else if (command === 'ship') {
			const featureSlug = args[0];
			const title = args[1];
			const dryRun = args.includes('--dry-run');
			result = await HANDLERS.ship.executeShip({ featureSlug, title, dryRun });
			if (result.success) {
				console.log(`✓ ${result.message}`);
				if (result.prUrl) console.log(`  PR: ${result.prUrl}`);
			} else {
				console.error(`✗ Ship failed: ${result.error}`);
				process.exit(1);
			}

		} else {
			// review, merge, verify - not yet implemented as automated CLI commands
			// These stages require interactive AI assistance
			console.log(`ℹ️  '${command}' is a guided workflow stage.`);
			console.log(`   Use your AI agent with the /${command} slash command for interactive execution.`);
			console.log(`   See .claude/commands/${command}.md for the full workflow guide.`);
		}

		process.exit(0);
	} catch (error) {
		console.error(`Error executing '${command}':`, error.message);
		process.exit(1);
	}
}

// Export for testing
if (require.main === module) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		process.exit(1);
	});
}

module.exports = {
	parseArgs,
	isValidCommand,
	validateArgs,
	validateSlug,
	getHelpText,
};
