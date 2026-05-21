#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const {
	assertProtectedWriteAllowed,
	recordProtectedStateAuditEvent,
} = require('../lib/protected-state-surfaces');

function parseNameStatus(output) {
	const files = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split('\t').filter(Boolean);
		const status = parts[0] || '';
		if (/^[RC]/.test(status)) {
			files.push(...parts.slice(1, 3));
		} else {
			files.push(parts[1]);
		}
	}
	return [...new Set(files.filter(Boolean))];
}

function getStagedFiles() {
	if (process.env.FORGE_PROTECTED_STATE_STAGED_NAME_STATUS !== undefined) {
		return parseNameStatus(process.env.FORGE_PROTECTED_STATE_STAGED_NAME_STATUS);
	}

	if (process.env.FORGE_PROTECTED_STATE_STAGED_FILES !== undefined) {
		return process.env.FORGE_PROTECTED_STATE_STAGED_FILES
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
	}

	const output = execFileSync('git', ['diff', '--cached', '--name-status', '--diff-filter=ACMRDT'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return parseNameStatus(output);
}

function getAllowedSurfaces() {
	return new Set(
		String(process.env.FORGE_PROTECTED_STATE_ALLOWED_SURFACES || '')
			.split(',')
			.map(surface => surface.trim())
			.filter(Boolean),
	);
}

function main() {
	const actor =
		process.env.FORGE_PROTECTED_STATE_ACTOR ||
		process.env.FORGE_ACTOR ||
		process.env.USER ||
		process.env.USERNAME ||
		'unknown';
	const allowedSurfaces = getAllowedSurfaces();
	const decisions = getStagedFiles()
		.map(file => {
			const probe = assertProtectedWriteAllowed(file, { actor, operation: 'staged_edit' });
			if (probe.requiredSurface && allowedSurfaces.has(probe.requiredSurface)) {
				return assertProtectedWriteAllowed(file, {
					actor,
					operation: 'staged_edit',
					viaForgeApi: true,
					surface: probe.requiredSurface,
				});
			}
			return probe;
		})
		.filter(decision => !decision.allowed);

	for (const decision of decisions) {
		const audit = recordProtectedStateAuditEvent(decision, { cwd: process.cwd() });
		if (!audit.success) {
			console.error(`WARN: Failed to record protected-state audit for ${decision.path}: ${audit.error}`);
		}
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
