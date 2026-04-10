const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  detectDefaultBranch,
  detectBeadsVersion,
  templateWorkflows,
} = require('../lib/beads-sync-scaffold');

/**
 * Helper: create a unique temp directory for each test and clean up after.
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beads-sync-detect-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// detectDefaultBranch
// ---------------------------------------------------------------------------
describe('detectDefaultBranch', () => {
  test('parses branch from symbolic-ref output (origin/HEAD = main)', () => {
    const mockExec = (cmd, args, _opts) => {
      if (args[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      throw new Error('unexpected call');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('main');
  });

  test('falls back to remote show when symbolic-ref fails, parses develop', () => {
    const mockExec = (cmd, args, _opts) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('not a symbolic ref');
      }
      if (args[0] === 'remote' && args[1] === 'show') {
        return Buffer.from(
          'Remote origin\n  HEAD branch: develop\n  Remote branches:\n'
        );
      }
      throw new Error('unexpected call');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('develop');
  });

  test('falls back to main when all git commands fail', () => {
    const mockExec = (_cmd, _args, _opts) => {
      throw new Error('git not available');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// detectBeadsVersion
// ---------------------------------------------------------------------------
describe('detectBeadsVersion', () => {
  test('parses version from bd --version output', () => {
    const mockExec = (_cmd, _args, _opts) => {
      return Buffer.from('beads version 0.52.0\n');
    };
    const result = detectBeadsVersion({ _exec: mockExec });
    expect(result).toBe('0.52.0');
  });

  test('falls back to 1.0.0 when bd is not installed', () => {
    const mockExec = (_cmd, _args, _opts) => {
      throw new Error('command not found: bd');
    };
    const result = detectBeadsVersion({ _exec: mockExec });
    expect(result).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// templateWorkflows
// ---------------------------------------------------------------------------
describe('templateWorkflows', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('replaces branch and BD_VERSION in YAML files', () => {
    const yamlContent = [
      'name: Beads Sync',
      'on:',
      '  push:',
      '    branches: [master]',
      'jobs:',
      '  sync:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      BD_VERSION="1.0.0"',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, 'sync.yml'), yamlContent);

    templateWorkflows(tmpDir, 'develop', '0.52.0');

    const result = fs.readFileSync(path.join(tmpDir, 'sync.yml'), 'utf8');
    expect(result).toContain('branches: [develop]');
    expect(result).not.toContain('branches: [master]');
    expect(result).toContain('BD_VERSION="0.52.0"');
    expect(result).not.toContain('BD_VERSION="1.0.0"');
  });

  test('only rewrites known Forge-managed BD_VERSION placeholders', () => {
    const yamlContent = [
      'name: Beads Sync',
      'on:',
      '  push:',
      '    branches: [master]',
      'jobs:',
      '  sync:',
      '    env:',
      '      BD_VERSION="2.3.4"',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, 'sync.yml'), yamlContent);

    templateWorkflows(tmpDir, 'develop', '1.0.0');

    const result = fs.readFileSync(path.join(tmpDir, 'sync.yml'), 'utf8');
    expect(result).toContain('branches: [develop]');
    expect(result).toContain('BD_VERSION="2.3.4"');
  });

  test('handles multiple YAML files in the directory', () => {
    const yaml1 = 'on:\n  push:\n    branches: [master]\nenv:\n  BD_VERSION="1.0.0"';
    const yaml2 = 'on:\n  pull_request:\n    branches: [master]\nenv:\n  BD_VERSION="1.0.0"';

    fs.writeFileSync(path.join(tmpDir, 'ci.yml'), yaml1);
    fs.writeFileSync(path.join(tmpDir, 'deploy.yaml'), yaml2);
    // Non-YAML file should be left untouched
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'branches: [master]');

    templateWorkflows(tmpDir, 'main', '0.53.0');

    const r1 = fs.readFileSync(path.join(tmpDir, 'ci.yml'), 'utf8');
    const r2 = fs.readFileSync(path.join(tmpDir, 'deploy.yaml'), 'utf8');
    const r3 = fs.readFileSync(path.join(tmpDir, 'readme.txt'), 'utf8');

    expect(r1).toContain('branches: [main]');
    expect(r1).toContain('BD_VERSION="0.53.0"');
    expect(r2).toContain('branches: [main]');
    expect(r2).toContain('BD_VERSION="0.53.0"');
    // Non-YAML file untouched
    expect(r3).toContain('branches: [master]');
  });
});
