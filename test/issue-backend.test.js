'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveIssueBackend,
  hasExplicitBackendSignal,
} = require('../lib/issue-backend');

function makeTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-backend-'));
  return projectRoot;
}

function writeConfig(projectRoot, contents) {
  const dir = path.join(projectRoot, '.forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), contents);
}

describe('resolveIssueBackend precedence', () => {
  test('explicit deps.issueBackend wins over env and config', () => {
    const projectRoot = makeTempProject();
    writeConfig(projectRoot, 'issueBackend: beads\n');

    const resolved = resolveIssueBackend({
      deps: { issueBackend: 'kernel' },
      env: { FORGE_ISSUE_BACKEND: 'beads' },
      projectRoot,
    });

    expect(resolved).toBe('kernel');
  });

  test('env wins over config when deps is absent', () => {
    const projectRoot = makeTempProject();
    writeConfig(projectRoot, 'issueBackend: beads\n');

    const resolved = resolveIssueBackend({
      env: { FORGE_ISSUE_BACKEND: 'kernel' },
      projectRoot,
    });

    expect(resolved).toBe('kernel');
  });

  test('config wins over default when deps and env are absent', () => {
    const projectRoot = makeTempProject();
    writeConfig(projectRoot, 'issueBackend: kernel\n');

    const resolved = resolveIssueBackend({
      env: {},
      projectRoot,
    });

    expect(resolved).toBe('kernel');
  });

  test('defaults to kernel when nothing is set', () => {
    const projectRoot = makeTempProject();

    const resolved = resolveIssueBackend({
      env: {},
      projectRoot,
    });

    expect(resolved).toBe('kernel');
  });

  test('defaults to kernel when config file is missing', () => {
    const projectRoot = makeTempProject();

    const resolved = resolveIssueBackend({ env: {}, projectRoot });

    expect(resolved).toBe('kernel');
  });

  test('beads is reachable opt-out via config', () => {
    const projectRoot = makeTempProject();
    writeConfig(projectRoot, 'issueBackend: beads\n');

    const resolved = resolveIssueBackend({ env: {}, projectRoot });

    expect(resolved).toBe('beads');
  });

  test('beads is reachable opt-out via env', () => {
    const projectRoot = makeTempProject();

    const resolved = resolveIssueBackend({
      env: { FORGE_ISSUE_BACKEND: 'beads' },
      projectRoot,
    });

    expect(resolved).toBe('beads');
  });
});

describe('resolveIssueBackend validation', () => {
  test('falls back to default with a warning on an unknown env value', () => {
    const projectRoot = makeTempProject();
    const warnings = [];

    const resolved = resolveIssueBackend({
      env: { FORGE_ISSUE_BACKEND: 'mongo' },
      projectRoot,
      warn: (message) => warnings.push(message),
    });

    expect(resolved).toBe('kernel');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('mongo');
  });

  test('falls back to default with a warning on an unknown config value', () => {
    const projectRoot = makeTempProject();
    writeConfig(projectRoot, 'issueBackend: postgres\n');
    const warnings = [];

    const resolved = resolveIssueBackend({
      env: {},
      projectRoot,
      warn: (message) => warnings.push(message),
    });

    expect(resolved).toBe('kernel');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('postgres');
  });

  test('an explicitly invalid deps value falls back to default with a warning', () => {
    const projectRoot = makeTempProject();
    const warnings = [];

    const resolved = resolveIssueBackend({
      deps: { issueBackend: 'sqlite' },
      env: {},
      projectRoot,
      warn: (message) => warnings.push(message),
    });

    expect(resolved).toBe('kernel');
    expect(warnings.length).toBe(1);
  });
});

describe('hasExplicitBackendSignal', () => {
  test('true when deps.issueBackend is set', () => {
    const projectRoot = makeTempProject();
    expect(hasExplicitBackendSignal({
      deps: { issueBackend: 'kernel' },
      env: {},
      projectRoot,
    })).toBe(true);
  });

  test('true when env var is set', () => {
    const projectRoot = makeTempProject();
    expect(hasExplicitBackendSignal({
      env: { FORGE_ISSUE_BACKEND: 'kernel' },
      projectRoot,
    })).toBe(true);
  });

  test('true when config file declares a backend', () => {
    const projectRoot = makeTempProject();
    writeConfig(projectRoot, 'issueBackend: kernel\n');
    expect(hasExplicitBackendSignal({ env: {}, projectRoot })).toBe(true);
  });

  test('false when no signal is present', () => {
    const projectRoot = makeTempProject();
    expect(hasExplicitBackendSignal({ env: {}, projectRoot })).toBe(false);
  });
});
