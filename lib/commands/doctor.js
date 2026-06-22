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

const SCHEMA_VERSION = 1;

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

	return {
		command: 'doctor',
		schemaVersion: SCHEMA_VERSION,
		ok: check.ok,
		checks: [check],
	};
}

function formatCheckLine(check) {
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
			lines.push('');
			lines.push(check.remediation);
		}
	}
	lines.push('');
	lines.push(report.ok ? 'doctor: OK' : 'doctor: FAILED');
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
