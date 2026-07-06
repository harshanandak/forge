'use strict';

const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const doctor = require('../../lib/commands/doctor');
const { validateCommand } = require('../../lib/commands/_registry');

const T = 3000;

// Common injected deps so the git shell-out never runs against a temp dir.
function depsFor(projectRoot, classification) {
	return {
		gitCommonDir: path.join(projectRoot, '.git'),
		classifyFilesystem: () => classification,
		env: {},
	};
}

describe('forge doctor — module contract', () => {
	test('exports a valid command module ({name, description, handler})', () => {
		expect(doctor.name).toBe('doctor');
		expect(typeof doctor.description).toBe('string');
		expect(typeof doctor.handler).toBe('function');
		expect(validateCommand(doctor).valid).toBe(true);
	}, T);
});

describe('forge doctor — buildDoctorReport', () => {
	test('local-ok → ok:true, single filesystem-class check, no remediation', () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-ok');
		const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot, {
			class: 'local-ok', riskTier: 'safe', signal: 'none', remediationKey: 'local-ok',
		}));
		expect(report.command).toBe('doctor');
		expect(report.schemaVersion).toBe(1);
		expect(report.ok).toBe(true);
		expect(Array.isArray(report.checks)).toBe(true);
		// filesystem-class (enforcer) + memory-backend (non-fatal reporter).
		expect(report.checks.length).toBe(2);
		const check = report.checks[0];
		expect(check.id).toBe('filesystem-class');
		expect(report.checks[1].id).toBe('memory-backend');
		expect(check.ok).toBe(true);
		expect(check.class).toBe('local-ok');
		expect(check.riskTier).toBe('safe');
		expect(check.overrideActive).toBe(false);
		expect(check.databasePath).toContain('kernel.sqlite');
	}, T);

	test('refuse class (onedrive) → ok:false and remediation present', () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-refuse');
		const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot, {
			class: 'onedrive', riskTier: 'refuse', signal: 'env OneDrive', remediationKey: 'onedrive',
		}));
		expect(report.ok).toBe(false);
		expect(report.checks[0].ok).toBe(false);
		expect(report.checks[0].class).toBe('onedrive');
		expect(typeof report.checks[0].remediation).toBe('string');
		expect(report.checks[0].remediation.length).toBeGreaterThan(0);
	}, T);

	test('refuse class WITH override env → ok:true and overrideActive:true', () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-override');
		const report = doctor.buildDoctorReport(projectRoot, {
			gitCommonDir: path.join(projectRoot, '.git'),
			classifyFilesystem: () => ({
				class: 'onedrive', riskTier: 'refuse', signal: 'env', remediationKey: 'onedrive',
			}),
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: '1' },
		});
		expect(report.checks[0].overrideActive).toBe(true);
		expect(report.checks[0].ok).toBe(true);
		expect(report.ok).toBe(true);
	}, T);

	test('refuse class WITH override env=0 → overrideActive:false and ok:false (M4)', () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-override-zero');
		const report = doctor.buildDoctorReport(projectRoot, {
			gitCommonDir: path.join(projectRoot, '.git'),
			classifyFilesystem: () => ({
				class: 'onedrive', riskTier: 'refuse', signal: 'env', remediationKey: 'onedrive',
			}),
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: '0' },
		});
		expect(report.checks[0].overrideActive).toBe(false);
		expect(report.checks[0].ok).toBe(false);
		expect(report.ok).toBe(false);
	}, T);

	test('databasePath equals buildLocalBrokerConfig().databasePath and is NOT created', () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-nopath');
		const { buildLocalBrokerConfig } = require('../../lib/kernel/broker');
		const gitCommonDir = path.join(projectRoot, '.git');
		const expected = buildLocalBrokerConfig({ projectRoot, gitCommonDir }).databasePath;
		const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot, {
			class: 'local-ok', riskTier: 'safe', signal: 'none', remediationKey: 'local-ok',
		}));
		expect(report.checks[0].databasePath).toBe(expected);
		expect(fs.existsSync(expected)).toBe(false);
	}, T);
});

describe('forge doctor — handler output', () => {
	test('--json returns success:true with valid parseable JSON report', async () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-json');
		const result = await doctor.handler(['--json'], {}, projectRoot, depsFor(projectRoot, {
			class: 'local-ok', riskTier: 'safe', signal: 'none', remediationKey: 'local-ok',
		}));
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.command).toBe('doctor');
		expect(parsed.checks[0].id).toBe('filesystem-class');
	}, T);

	test('default text for local-ok contains check mark and class', async () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-text-ok');
		const result = await doctor.handler([], {}, projectRoot, depsFor(projectRoot, {
			class: 'local-ok', riskTier: 'safe', signal: 'none', remediationKey: 'local-ok',
		}));
		expect(result.success).toBe(true);
		expect(result.output).toContain('local-ok');
		expect(result.output).toContain('✓');
	}, T);

	test('refuse class sets result.error and success:false; text contains REFUSE', async () => {
		const projectRoot = path.join(os.tmpdir(), 'forge-doctor-text-refuse');
		const result = await doctor.handler([], {}, projectRoot, depsFor(projectRoot, {
			class: 'onedrive', riskTier: 'refuse', signal: 'env', remediationKey: 'onedrive',
		}));
		expect(result.success).toBe(false);
		expect(typeof result.error).toBe('string');
		expect(result.output).toContain('REFUSE');
	}, T);
});
