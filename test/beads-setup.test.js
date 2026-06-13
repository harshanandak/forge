const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
  sanitizePrefix,
  writeBeadsConfig,
  writeBeadsGitignore,
  ensureBeadsGitExclude,
  isBeadsInitialized,
  preSeedJsonl,
  readBeadsDatabaseName,
  safeBeadsInit
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
    expect(content).toContain('# Beads runtime, export, and backup state is local');
    expect(content).toContain('*');
    expect(content).toContain('!.gitignore');
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
// ensureBeadsGitExclude
// ---------------------------------------------------------------------------
describe('ensureBeadsGitExclude', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('adds local exclude rules for Beads state without touching tracked ignore files', () => {
    ensureBeadsGitExclude(tmpDir);

    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    const content = fs.readFileSync(excludePath, 'utf8');

    expect(content).toContain('# Forge local Beads state');
    expect(content).toContain('.beads/');
    expect(content).toContain('.dolt/');
    expect(content).toContain('.beads-credential-key');
    expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
  });

  test('is idempotent when local exclude rules already exist', () => {
    ensureBeadsGitExclude(tmpDir);
    ensureBeadsGitExclude(tmpDir);

    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    const content = fs.readFileSync(excludePath, 'utf8');

    expect(content.match(/# Forge local Beads state/g)).toHaveLength(1);
    expect(content.match(/\.beads\//g)).toHaveLength(1);
  });

  test('untracks previously committed Beads state without deleting local files', () => {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    const beadsFile = path.join(tmpDir, '.beads', 'issues.jsonl');
    fs.mkdirSync(path.dirname(beadsFile), { recursive: true });
    fs.writeFileSync(beadsFile, '{"id":"forge-test"}\n', 'utf8');
    execFileSync('git', ['add', '.beads/issues.jsonl'], { cwd: tmpDir, stdio: 'pipe' });

    expect(execFileSync('git', ['ls-files', '.beads'], { cwd: tmpDir, encoding: 'utf8' }).trim()).toBe('.beads/issues.jsonl');

    ensureBeadsGitExclude(tmpDir);

    expect(fs.readFileSync(beadsFile, 'utf8')).toBe('{"id":"forge-test"}\n');
    expect(execFileSync('git', ['ls-files', '.beads'], { cwd: tmpDir, encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['status', '--short', '--', '.beads'], { cwd: tmpDir, encoding: 'utf8' }).trim()).toBe('');
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
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns false when config.yaml exists but has no issue-prefix', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(path.join(beadsDir, 'config.yaml'), 'database:\n  backend: dolt\n');
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns false when Dolt config exists without a backend-ready marker', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n'
    );
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns false when only one Dolt marker is present', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n'
    );
    fs.writeFileSync(path.join(beadsDir, 'metadata.json'), '{"version":1}\n');
    expect(isBeadsInitialized(tmpDir)).toBe(false);
  });

  test('returns true when Dolt config and multiple init markers are present', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n'
    );
    fs.writeFileSync(path.join(beadsDir, 'metadata.json'), '{"version":1}\n');
    fs.mkdirSync(path.join(beadsDir, 'hooks'), { recursive: true });
    expect(isBeadsInitialized(tmpDir)).toBe(true);
  });

  test('returns true for a legacy SQLite config so setup does not overwrite existing tracker state', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: legacy-proj\ndatabase:\n  backend: sqlite\n',
    );
    fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '{"id":"legacy-1"}\n');
    expect(isBeadsInitialized(tmpDir)).toBe(true);
  });

  test('returns true for properly configured directory', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n'
    );
    fs.writeFileSync(path.join(beadsDir, 'metadata.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(beadsDir, 'README.md'), 'beads repo marker\n');
    expect(isBeadsInitialized(tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit
// ---------------------------------------------------------------------------
describe('safeBeadsInit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('adds local Beads excludes even when initialization is skipped', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(path.join(beadsDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n',
    );
    fs.writeFileSync(path.join(beadsDir, 'metadata.json'), '{"version":1}\n');

    let initCalls = 0;
    const result = safeBeadsInit(tmpDir, {
      execBdInit: () => {
        initCalls += 1;
      },
    });

    const exclude = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf8');
    expect(result).toMatchObject({ success: true, skipped: true, reason: 'already initialized' });
    expect(initCalls).toBe(0);
    expect(exclude).toContain('.beads/');
    expect(exclude).toContain('.dolt/');
    expect(exclude).toContain('.beads-credential-key');
  });
});

// ---------------------------------------------------------------------------
// preSeedJsonl legacy shim
// ---------------------------------------------------------------------------
describe('preSeedJsonl', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('does not create issues.jsonl if missing', () => {
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true });
    preSeedJsonl(tmpDir);

    const jsonlPath = path.join(tmpDir, '.beads', 'issues.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  test('leaves existing issues.jsonl untouched when present', () => {
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    const jsonlPath = path.join(beadsDir, 'issues.jsonl');
    fs.writeFileSync(jsonlPath, '{"id":"beads-1","title":"existing"}\n');

    preSeedJsonl(tmpDir);

    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe(
      '{"id":"beads-1","title":"existing"}\n'
    );
  });

  test('does not create .beads/ directory if it does not exist', () => {
    preSeedJsonl(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.beads'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readBeadsDatabaseName
// ---------------------------------------------------------------------------
describe('readBeadsDatabaseName', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true });
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('prefers dolt_database from metadata.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.beads', 'metadata.json'),
      JSON.stringify({ database: 'dolt', dolt_database: 'forge-shared' }, null, 2),
    );

    expect(readBeadsDatabaseName(tmpDir)).toBe('forge-shared');
  });

  test('falls back to database when dolt_database is absent', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.beads', 'metadata.json'),
      JSON.stringify({ database: 'forge-fallback' }, null, 2),
    );

    expect(readBeadsDatabaseName(tmpDir)).toBe('forge-fallback');
  });

  test('returns null when metadata.json is missing or malformed', () => {
    expect(readBeadsDatabaseName(tmpDir)).toBeNull();

    fs.writeFileSync(path.join(tmpDir, '.beads', 'metadata.json'), '{not-json');
    expect(readBeadsDatabaseName(tmpDir)).toBeNull();
  });
});
