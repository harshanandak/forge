#!/usr/bin/env node

/**
 * Forge CLI Command Dispatcher
 * Executable automation for Forge workflow stages
 */

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

		// TODO: Import and execute command handlers
		// const handler = require(`../lib/commands/${command}.js`);
		// await handler(args);

		console.log(`✓ Command '${command}' executed successfully`);
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
	getHelpText,
};
