'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctor = require('../../lib/commands/doctor');

const tempDirs = [];

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memory-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(projectRoot, yaml) {
  const dir = path.join(projectRoot, '.forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml, 'utf8');
}

function memoryCheck(report) {
  return report.checks.find(c => c.id === 'memory-backend');
}

// Inject deps so the git shell-out and fs classification never touch the temp dir.
function depsFor(projectRoot) {
  return {
    env: {},
    gitCommonDir: path.join(projectRoot, '.git'),
    classifyFilesystem: () => ({
      class: 'local-ok', riskTier: 'safe', signal: 'none', remediationKey: 'local-ok',
    }),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('forge doctor: memory backend check', () => {
  test('reports the default local backend and stays ok (non-fatal)', () => {
    const projectRoot = makeProjectRoot();
    const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot));
    const check = memoryCheck(report);
    expect(check).toBeDefined();
    expect(check.backend).toBe('local');
    expect(check.ok).toBe(true);
  });

  test('graphiti selected but unconfigured is reported (ok:false) but does not fail the overall report', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, 'memory:\n  backend: graphiti\n');
    const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot));
    const check = memoryCheck(report);
    expect(check.backend).toBe('graphiti');
    expect(check.ok).toBe(false);
    expect(typeof check.detail).toBe('string');
    // Non-fatal: the memory backend must never fail doctor overall.
    // (Overall ok is governed by the filesystem-class check only.)
    expect(report.checks[0].id).toBe('filesystem-class');
    expect(report.ok).toBe(true);
  });

  test('report.ok stays true even when the memory check reports a problem (locks non-fatality)', () => {
    const projectRoot = makeProjectRoot();
    // Misconfigured graphiti → memory check ok:false, but filesystem is safe.
    writeConfig(projectRoot, 'memory:\n  backend: graphiti\n');
    const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot));

    const fsCheck = report.checks.find(c => c.id === 'filesystem-class');
    const memCheck = memoryCheck(report);
    // Precondition: filesystem is the healthy gate, memory is the unhealthy reporter.
    expect(fsCheck.ok).toBe(true);
    expect(memCheck.ok).toBe(false);
    // The unhealthy memory check must NOT drag the overall report to failure.
    expect(report.ok).toBe(true);
    expect(report.ok).toBe(fsCheck.ok);
  });

  test('graphiti fully configured reports ok and the configured server path', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(
      projectRoot,
      'memory:\n  backend: graphiti\n  graphiti:\n    mcpServerPath: /opt/graphiti/mcp_server\n',
    );
    const report = doctor.buildDoctorReport(projectRoot, depsFor(projectRoot));
    const check = memoryCheck(report);
    expect(check.backend).toBe('graphiti');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('/opt/graphiti/mcp_server');
  });
});
