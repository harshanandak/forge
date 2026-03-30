#!/usr/bin/env node

/**
 * Forge CLI Command Dispatcher
 * Executable automation for Forge workflow stages
 */

const path = require('node:path');
const { loadCommands } = require('../lib/commands/_registry');

// Load command registry — auto-discovers all command modules in lib/commands/
const COMMANDS_DIR = path.join(__dirname, '..', 'lib', 'commands');
const { commands: _registry } = loadCommands(COMMANDS_DIR);

const VALID_COMMANDS = [
	'status',
	'plan',
	'dev',
	'validate',
	'check', // backward-compat alias for validate
	'ship',
	'review',
	'merge',
	'verify',
];

const COMMAND_DESCRIPTIONS = {
	status: 'Detect current workflow stage (1-7)',
	plan: 'Create branch + Beads + design doc',
	dev: 'Implement with TDD (RED-GREEN-REFACTOR)',
	validate: 'Run type check, lint, security, tests',
	check: 'Alias for validate (deprecated — use validate)',
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
	validate: [],
	check: [], // backward-compat alias
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

		const positionalArgs = args.filter(a => !a.startsWith('--'));

		// Build flags object from --key=value and --flag args
		const flags = {};
		for (const arg of args) {
			if (!arg.startsWith('--')) continue;
			const eqIdx = arg.indexOf('=');
			if (eqIdx !== -1) {
				flags[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
			} else {
				flags[arg] = true;
			}
		}

		// Resolve command name — 'check' is a backward-compat alias for 'validate'
		const resolvedCommand = command === 'check' ? 'validate' : command;
		if (command === 'check') console.warn('⚠ "forge check" is deprecated — use "forge validate"');

		// Look up command in the auto-discovery registry
		const registryEntry = _registry.get(resolvedCommand);

		if (registryEntry) {
			// Dispatch through registry handler
			const result = await registryEntry.handler(positionalArgs, flags, process.cwd());

			// Format output based on result shape
			if (result.output) {
				console.log(result.output);
			} else if (result.success) {
				const message = result.message || result.summary || result.phase || result.detectedPhase || '';
				console.log(`✓ ${message}`);
				if (result.beadsIssueId) console.log(`  Beads: ${result.beadsIssueId}`);
				if (result.prUrl) console.log(`  PR: ${result.prUrl}`);
				if (result.guidance) console.log('\n' + result.guidance);
			} else {
				const errorMsg = result.error || result.summary || 'Unknown error';
				console.error(`✗ ${errorMsg}`);
				if (result.failedChecks) console.error(`  Failed: ${result.failedChecks.join(', ')}`);
				process.exit(1);
			}
		} else {
			// Guided workflow stages (review, merge, verify) — not yet automated
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
