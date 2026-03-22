const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  sanitizePrefix,
  writeBeadsConfig,
  writeBeadsGitignore,
  isBeadsInitialized,
  preSeedJsonl
} = require('../lib/beads-setup');

/**
 * Helper: create a unique temp directory for each test and clean up after.
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beads-setup-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// sanitizePrefix
// ---------------------------------------------------------------------------
describe('sanitizePrefix', () => {
  test('lowercases and replaces underscores with hyphens', () => {
    expect(sanitizePrefix('UPPER_CASE')).toBe('upper-case');
  });

  test('strips special characters and collapses hyphens', () => {
    expect(sanitizePrefix('My-Project_v2!')).toBe('my-project-v2');
  });

  test('trims surrounding whitespace', () => {
    expect(sanitizePrefix('  Spaces  ')).toBe('spaces');
  });

  test('returns already-clean input unchanged', () => {
    expect(sanitizePrefix('forge-workflow')).toBe('forge-workflow');
  });

  test('returns empty string for empty input', () => {
    expect(sanitizePrefix('')).toBe('');
  });

  test('collapses consecutive hyphens from multiple special chars', () => {
    expect(sanitizePrefix('a---b___c!!!d')).toBe('a-b-c-d');
  });

  test('trims leading/trailing hyphens after sanitization', () => {
    expect(sanitizePrefix('---leading')).toBe('leading');
    expect(sanitizePrefix('trailing---')).toBe('trailing');
    expect(sanitizePrefix('--both--')).toBe('both');
  });
});

// ---------------------------------------------------------------------------
// writeBeadsConfig
// ---------------------------------------------------------------------------
describe('writeBeadsConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('creates .beads/ directory and config.yaml with correct prefix', () => {
    writeBeadsConfig(tmpDir, { prefix: 'my-project' });

    const configPath = path.join(tmpDir, '.beads', 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('issue-prefix: my-project');
  });

  test('config.yaml includes Dolt database configuration', () => {
    writeBeadsConfig(tmpDir, { prefix: 'test-proj' });

    const content = fs.readFileSync(
      path.join(tmpDir, '.beads', 'config.yaml'),
      'utf8'
    );
    expect(content).toContain('database:');
    expect(content).toContain('backend: dolt');
  });

  test('sanitizes prefix before writing', () => {
    writeBeadsConfig(tmpDir, { prefix: 'My Project!!' });

    const content = fs.readFileSync(
      path.join(tmpDir, '.beads', 'config.yaml'),
      'utf8'
    );
    expect(content).toContain('issue-prefix: my-project');
  });

  test('does not overwrite .beads/ dir if it already exists', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    // Place a marker file to prove directory survives
    fs.writeFileSync(path.join(beadsDir, 'marker.txt'), 'keep');

    writeBeadsConfig(tmpDir, { prefix: 'proj' });

    expect(fs.existsSync(path.join(beadsDir, 'marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(beadsDir, 'config.yaml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeBeadsGitignore
// ---------------------------------------------------------------------------
describe('writeBeadsGitignore', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('creates .beads/.gitignore with Dolt binary file entries', () => {
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true });
    writeBeadsGitignore(tmpDir);

    const gitignorePath = path.join(tmpDir, '.beads', '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    expect(content).toContain('dolt/');
    expect(content).toContain('*.db');
    expect(content).toContain('*.lock');
  });

  test('creates .beads/ directory if it does not exist', () => {
    writeBeadsGitignore(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.beads', '.gitignore'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBeadsInitialized
// ---------------------------------------------------------------------------
describe('isBeadsInitialized', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('returns false for empty directory', () => {
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns false when .beads/ exists but config.yaml is missing', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '');
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns false when config.yaml exists but has no issue-prefix', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(path.join(beadsDir, 'config.yaml'), 'database:\n  backend: dolt\n');
    fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '');
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns false when issues.jsonl is missing', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\n'
    );
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns true for properly configured directory', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n'
    );
    fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '');
    expect(isBeadsInitialized(tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preSeedJsonl
// ---------------------------------------------------------------------------
describe('preSeedJsonl', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('creates issues.jsonl if missing', () => {
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true });
    preSeedJsonl(tmpDir);

    const jsonlPath = path.join(tmpDir, '.beads', 'issues.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe('');
  });

  test('leaves existing issues.jsonl untouched', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    const jsonlPath = path.join(beadsDir, 'issues.jsonl');
    fs.writeFileSync(jsonlPath, '{"id":"beads-1","title":"existing"}\n');

    preSeedJsonl(tmpDir);

    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe(
      '{"id":"beads-1","title":"existing"}\n'
    );
  });

  test('creates .beads/ directory if it does not exist', () => {
    preSeedJsonl(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.beads', 'issues.jsonl'))).toBe(
      true
    );
  });
});
