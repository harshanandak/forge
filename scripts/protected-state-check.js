#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const {
	assertProtectedWriteAllowed,
	recordProtectedStateAuditEvent,
} = require('../lib/protected-state-surfaces');
const { authorizeAndConsumeProtectedStateWrites } = require('../lib/protected-state-authority');

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

function getStagedContent(file) {
	if (process.env.FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON) {
		const contents = JSON.parse(process.env.FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON);
		return Object.prototype.hasOwnProperty.call(contents, file) ? contents[file] : null;
	}

	try {
		return execFileSync('git', ['show', `:${file}`], {
			encoding: null,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (_error) {
		return null;
	}
}

async function main() {
	const actor =
		process.env.FORGE_PROTECTED_STATE_ACTOR ||
		process.env.FORGE_ACTOR ||
		process.env.USER ||
		process.env.USERNAME ||
		'unknown';
	const probes = getStagedFiles()
		.map(file => {
			const probe = assertProtectedWriteAllowed(file, { actor, operation: 'staged_edit' });
			if (!probe.requiredSurface) return { probe };

			const content = getStagedContent(probe.path);
			if (content === null) return { probe };
			return {
				probe,
				request: {
					actor,
					surface: probe.requiredSurface,
					path: probe.path,
					content,
					operation: 'staged_edit',
				},
			};
		});
	const protectedProbes = probes.filter(entry => entry.request);
	const authorization = await authorizeAndConsumeProtectedStateWrites(
		process.cwd(),
		protectedProbes.map(entry => entry.request),
	);
	let authorizationIndex = 0;
	const decisions = probes
		.map(entry => {
			if (!entry.request) return entry.probe;
			const trustedDecision = authorization.decisions[authorizationIndex++];
			return trustedDecision.allowed
				? trustedDecision
				: { ...entry.probe, ...trustedDecision, repairHint: entry.probe.repairHint };
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
		console.error(`    Reason: ${decision.reason}`);
		console.error(`    Repair: ${decision.repairHint}`);
	}
	console.error('');
	console.error('Use the owning Forge API surface, then stage the generated result if that command explicitly owns it.');
	process.exit(1);
}

main().catch(error => {
	console.error(`Protected state check failed: ${error.message}`);
	process.exit(1);
});
