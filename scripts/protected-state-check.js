#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const {
	assertProtectedWriteAllowed,
	recordProtectedStateAuditEvent,
} = require('../lib/protected-state-surfaces');

function getStagedFiles() {
	if (process.env.FORGE_PROTECTED_STATE_STAGED_FILES !== undefined) {
		return process.env.FORGE_PROTECTED_STATE_STAGED_FILES
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
	}

	const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function main() {
	const actor =
		process.env.FORGE_PROTECTED_STATE_ACTOR ||
		process.env.FORGE_ACTOR ||
		process.env.USER ||
		process.env.USERNAME ||
		'unknown';
	const decisions = getStagedFiles()
		.map(file => assertProtectedWriteAllowed(file, { actor, operation: 'staged_edit' }))
		.filter(decision => !decision.allowed);

	for (const decision of decisions) {
		recordProtectedStateAuditEvent(decision, { cwd: process.cwd() });
	}

	if (decisions.length === 0) {
		console.log('OK: No protected state edits detected.');
		process.exit(0);
	}

	console.error('ERROR: Protected state edit detected. Direct edits to these paths are blocked:');
	for (const decision of decisions) {
		console.error(`  - ${decision.path} [${decision.requiredSurface}]`);
		console.error(`    Decision: ${decision.decision}`);
		console.error(`    Repair: ${decision.repairHint}`);
	}
	console.error('');
	console.error('Use the owning Forge or Beads API surface, then stage the generated result if that command explicitly owns it.');
	process.exit(1);
}

try {
	main();
} catch (error) {
	console.error(`Protected state check failed: ${error.message}`);
	process.exit(1);
}
