#!/usr/bin/env node

/**
 * Forge CLI Command Dispatcher
 * Executable automation for Forge workflow stages
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Command handlers - connected to lib/commands/
const HANDLERS = {
	status: require('../lib/commands/status'),
	plan: require('../lib/commands/plan'),
	dev: require('../lib/commands/dev'),
	check: require('../lib/commands/check'),
	ship: require('../lib/commands/ship'),
};

const VALID_COMMANDS = [
	'status',
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
	plan: 'Create branch + Beads + OpenSpec proposal',
	dev: 'Implement with TDD (RED-GREEN-REFACTOR)',
	check: 'Run type check, lint, security, tests',
	ship: 'Auto-generate PR body and create PR',
	review: 'Aggregate all review feedback',
	merge: 'Update docs, merge PR, cleanup',
	verify: 'Final documentation verification',
};

const REQUIRED_ARGS = {
	plan: ['feature-slug'],
	ship: ['feature-slug', 'title'],
	review: [],
	merge: [],
	// Other commands don't require arguments
	status: [],
	dev: [],
	check: [],
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

	// Security: Only allow lowercase letters, numbers, and hyphens; must start and end with alphanumeric
	const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;  // NOSONAR S5852 - no backtracking: anchored, alternation is possessive
	if (!slugPattern.test(slug)) {
		return {
			valid: false,
			error: `Error: Invalid slug format '${slug}'\n\nSlug must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number\nExample: stripe-billing, user-auth, api-v2`,
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
	const positionalArgs = args.filter(a => !a.startsWith('--'));

	if (required.length > 0 && positionalArgs.length < required.length) {
		const missing = required.slice(positionalArgs.length);
		return {
			valid: false,
			error: `Error: ${missing[0]} required\n\nUsage: forge ${command} <${required.join('> <')}>`,
		};
	}

	// Security: Validate slug format for slug-based commands
	const slugCommands = ['plan', 'ship'];
	if (slugCommands.includes(command) && positionalArgs.length > 0) {
		const slugValidation = validateSlug(positionalArgs[0]);
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

	lines.push(
		'',
		'Examples:',
		'  forge status                    # Check current workflow stage',
		'  forge plan stripe-billing       # Create implementation plan',
		'  forge ship stripe-billing "feat: add billing"  # Create PR',
		'  forge review 123                # Aggregate PR feedback',
		'',
	);

	return lines.join('\n');
}

/**
 * Main dispatcher
 */
async function main() { // NOSONAR S3776
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
		const quotedArgs = args.map(a => `"${a.replaceAll('"', '\\"')}"`);  // NOSONAR S7780 - intentional backslash escape for console quoting
		console.log(`Executing: forge ${command}${quotedArgs.length > 0 ? ' ' + quotedArgs.join(' ') : ''}`);
		console.log('');

		let result;
		const positionalArgs = args.filter(a => !a.startsWith('--'));

		if (command === 'status') {
			// Gather context from git + filesystem
			const branch = (() => {
				try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(); }  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
				catch (error_) { void error_; return 'master'; } // NOSONAR S2486 - intentional: non-git dirs fallback
			})();
			const context = {
				branch,
				researchDoc: fs.existsSync('docs/research') ? fs.readdirSync('docs/research').find(f => f.endsWith('.md')) : null,
				plan: fs.existsSync('.claude/plans') ? fs.readdirSync('.claude/plans').find(f => f.endsWith('.md')) : null,
				tests: (() => { try { return fs.readdirSync('test').filter(f => f.endsWith('.test.js')); } catch (error_) { void error_; return []; } })(), // NOSONAR S2486 - intentional: missing test dir
			};
			const stageResult = HANDLERS.status.detectStage(context);
			console.log(HANDLERS.status.formatStatus(stageResult));

		} else if (command === 'plan') {
			result = await HANDLERS.plan.executePlan(positionalArgs[0]);
			if (result.success) {
				console.log(`✓ Plan created: ${result.summary || result.branchName || ''}`);
				if (result.beadsIssueId) console.log(`  Beads: ${result.beadsIssueId}`);
			} else {
				console.error(`✗ Plan failed: ${result.error}`);
				process.exit(1);
			}

		} else if (command === 'dev') {
			const featureName = positionalArgs[0] || 'feature';
			const VALID_PHASES = ['RED', 'GREEN', 'REFACTOR'];
			const phase = positionalArgs[1] ? positionalArgs[1].toUpperCase() : undefined;
			if (phase && !VALID_PHASES.includes(phase)) {
				console.error(`✗ Invalid phase '${positionalArgs[1]}'. Valid phases: red, green, refactor`);
				process.exit(1);
			}
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
			const featureSlug = positionalArgs[0];
			const title = positionalArgs[1];
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
			const prRef = positionalArgs[0] ? ` ${positionalArgs[0]}` : '';
			console.log(`ℹ️  '${command}' is a guided workflow stage.`);
			console.log(`   Use your AI agent with the /${command}${prRef} slash command for interactive execution.`);
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
	main().catch((error) => { // NOSONAR S7785 - CJS module, top-level await unavailable
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
