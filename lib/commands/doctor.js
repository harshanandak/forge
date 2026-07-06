'use strict';

// D19 — `forge doctor`: reports the filesystem class of the kernel DB path.
//
// Auto-discovered + routed by lib/commands/_registry.js (no bin/forge.js edit).
// JSON-first, mirrors orient/recap. It is a REPORTER, not the enforcer — the
// default-on gate lives in broker.initialize(). doctor resolves the exact path
// the gate guards (via buildLocalBrokerConfig, which does no I/O) and reports
// whether that path is safe, WITHOUT creating any file.

const { buildLocalBrokerConfig } = require('../kernel/broker');
const { classifyFilesystem, isUnsafeFsOverrideActive, REMEDIATION } = require('../kernel/fs-class');
const memoryRouter = require('../memory/router');

const SCHEMA_VERSION = 1;

/**
 * Best-effort, NON-FATAL memory-backend check. Reports the resolved backend and,
 * when `graphiti` is selected, whether the opt-in config is coherent and the
 * configured MCP server path exists locally. It never gates the overall report
 * (that stays governed by the filesystem-class check) — a memory misconfig warns
 * but does not make `forge doctor` fail.
 *
 * @param {string} projectRoot
 * @param {object} env
 * @returns {{ id: string, ok: boolean, backend: string, detail: string }}
 */
function buildMemoryCheck(projectRoot, env) {
	const fs = require('node:fs');
	try {
		const { backend, graphiti } = memoryRouter.assertMemoryConfigValid({ projectRoot, env });
		if (backend !== 'graphiti') {
			return {
				id: 'memory-backend',
				ok: true,
				backend,
				detail: `memory backend: ${backend} (local JSONL store, offline)`,
			};
		}
		const serverPath = graphiti.mcpServerPath;
		const serverPathExists = fs.existsSync(serverPath);
		const reach = serverPathExists
			? `mcp_server present at ${serverPath}`
			: `mcp_server path not found locally (${serverPath}); run it before agents can use graph memory`;
		return {
			// Reflect reality in the line symbol: a graphiti backend whose MCP server
			// isn't present yet renders as `!` (warn), not a misleading `✓`. This does
			// NOT affect the overall doctor exit — report.ok is governed solely by the
			// filesystem-class check (see buildDoctorReport), so an uninstalled opt-in
			// memory server warns without failing `forge doctor`.
			id: 'memory-backend',
			ok: serverPathExists,
			backend,
			serverPathExists,
			detail: `memory backend: graphiti — served to agents via the graphiti-memory MCP server; ${reach}`,
		};
	} catch (err) {
		const backend = memoryRouter.resolveMemoryBackend({ projectRoot, env, warn: () => {} });
		return { id: 'memory-backend', ok: false, backend, detail: err.message };
	}
}

/**
 * Build the doctor report. Pure-ish: all I/O-bearing deps are injectable.
 * @param {string} projectRoot
 * @param {object} deps - { classifyFilesystem?, env?, gitCommonDir?, execFileSync? }
 */
function buildDoctorReport(projectRoot, deps = {}) {
	const env = deps.env || process.env;
	const classify = deps.classifyFilesystem || classifyFilesystem;

	// Config build does NO I/O (F1): it never opens/creates the DB.
	const config = buildLocalBrokerConfig({
		projectRoot,
		gitCommonDir: deps.gitCommonDir,
		execFileSync: deps.execFileSync,
	});
	const databasePath = config.databasePath;

	const classification = classify(databasePath, deps);
	const overrideActive = isUnsafeFsOverrideActive(env);
	const isRefuse = classification.riskTier === 'refuse';
	const checkOk = !isRefuse || overrideActive;
	const remediation = isRefuse
		? (REMEDIATION[classification.remediationKey] || REMEDIATION.unknown)
		: null;

	const check = {
		id: 'filesystem-class',
		ok: checkOk,
		databasePath,
		class: classification.class,
		riskTier: classification.riskTier,
		signal: classification.signal,
		remediation,
		overrideActive,
	};

	const memoryCheck = buildMemoryCheck(projectRoot, env);

	return {
		command: 'doctor',
		schemaVersion: SCHEMA_VERSION,
		// Overall ok is governed by the filesystem-class check (the enforcer). The
		// memory-backend check is a NON-FATAL reporter and never fails doctor.
		ok: check.ok,
		checks: [check, memoryCheck],
	};
}

function formatCheckLine(check) {
	if (check.id === 'memory-backend') {
		return `${check.ok ? '✓' : '!'} ${check.detail}`;
	}
	if (check.riskTier === 'safe') {
		return `✓ filesystem: ${check.class} (safe) — ${check.databasePath}`;
	}
	if (check.riskTier === 'warn') {
		return `! filesystem: ${check.class} (warn) — ${check.databasePath}`;
	}
	// refuse
	const tag = check.overrideActive ? 'REFUSE, override active' : 'REFUSE';
	return `✗ filesystem: ${check.class} (${tag}) — ${check.databasePath}`;
}

function formatReportText(report) {
	const lines = report.checks.map(formatCheckLine);
	for (const check of report.checks) {
		if (check.remediation) {
			lines.push('', check.remediation);
		}
	}
	lines.push('', report.ok ? 'doctor: OK' : 'doctor: FAILED');
	return `${lines.join('\n')}\n`;
}

async function handler(args, _flags, projectRoot, deps = {}) {
	const report = buildDoctorReport(projectRoot, deps);
	const output = (args || []).includes('--json')
		? `${JSON.stringify(report, null, 2)}\n`
		: formatReportText(report);

	const result = { success: report.ok, output };
	if (!report.ok) {
		result.error = `forge doctor found a refuse-class filesystem for the kernel database (${report.checks[0].class}).`;
	}
	return result;
}

module.exports = {
	name: 'doctor',
	description: 'Report the filesystem class of the kernel database path (cloud/network/local)',
	usage: 'Usage: forge doctor [--json]',
	handler,
	buildDoctorReport,
};
