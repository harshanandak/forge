const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const SUBJECT_PATH = path.join(
  __dirname,
  '..',
  'scripts',
  'lib',
  'beads-migrate-to-dolt.mjs',
);
const FIXTURE_ROOT = path.join(
  __dirname,
  'fixtures',
  'beads-migrate',
  'legacy-backup',
);
const BACKUP_FILES = [
  'issues.jsonl',
  'labels.jsonl',
  'dependencies.jsonl',
  'comments.jsonl',
  'events.jsonl',
  'config.jsonl',
];

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beads-migrate-to-dolt-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedLegacyRepo(projectRoot, options = {}) {
  const {
    withBackup = true,
    mirrorLiveBackupFiles = false,
  } = options;
  const beadsDir = path.join(projectRoot, '.beads');
  const backupDir = path.join(beadsDir, 'backup');
  fs.mkdirSync(beadsDir, { recursive: true });

  if (withBackup) {
    fs.mkdirSync(backupDir, { recursive: true });

    for (const file of BACKUP_FILES) {
      fs.copyFileSync(path.join(FIXTURE_ROOT, file), path.join(backupDir, file));
    }
  }

  if (mirrorLiveBackupFiles) {
    for (const file of BACKUP_FILES) {
      fs.copyFileSync(path.join(FIXTURE_ROOT, file), path.join(beadsDir, file));
    }
  }

  fs.writeFileSync(
    path.join(beadsDir, 'issues.jsonl'),
    fs.readFileSync(path.join(FIXTURE_ROOT, 'issues.jsonl'), 'utf8'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(beadsDir, 'config.yaml'),
    'issue-prefix: forge\ndatabase:\n  backend: sqlite\n',
    'utf8',
  );
  fs.writeFileSync(path.join(beadsDir, 'beads.db'), 'legacy-sqlite-cache', 'utf8');
  fs.writeFileSync(path.join(beadsDir, 'README.md'), 'legacy beads state', 'utf8');

  return {
    beadsDir,
    legacyBackupDir: backupDir,
    snapshotRoot: path.join(projectRoot, '.beads-migration-snapshots'),
    migratedDir: path.join(projectRoot, '.beads-migrated'),
    exportDir: path.join(projectRoot, '.beads-migrated-export'),
  };
}

function copyBackupSet(sourceDir, destDir, overrides = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of BACKUP_FILES) {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(destDir, file);
    if (Object.hasOwn(overrides, file)) {
      fs.writeFileSync(destPath, overrides[file], 'utf8');
      continue;
    }
    fs.copyFileSync(sourcePath, destPath);
  }
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeImportStub({ mismatchIssue = false } = {}) {
  return async ({ sourceDir, migratedDir, exportDir }) => {
    fs.mkdirSync(migratedDir, { recursive: true });
    fs.mkdirSync(path.join(migratedDir, '.beads'), { recursive: true });
    copyBackupSet(sourceDir, exportDir, mismatchIssue
      ? {
          'issues.jsonl':
            fs
              .readFileSync(path.join(sourceDir, 'issues.jsonl'), 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .slice(0, 1)
              .join('\n') + '\n',
        }
      : {});
    fs.writeFileSync(
      path.join(migratedDir, '.beads', 'config.yaml'),
      'issue-prefix: forge\ndatabase:\n  backend: dolt\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(migratedDir, '.beads', 'MIGRATED.txt'),
      'migrated-state\n',
      'utf8',
    );

    fs.writeFileSync(
      path.join(migratedDir, 'migration-manifest.json'),
      JSON.stringify({ status: 'migrated' }, null, 2),
      'utf8',
    );

    return {
      importedFiles: [...BACKUP_FILES],
    };
  };
}

async function loadSubject() {
  return import(`${pathToFileURL(SUBJECT_PATH).href}?t=${Date.now()}`);
}

describe('beads migrate to dolt contract', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTmpDir();
  });

  afterEach(() => {
    rmrf(projectRoot);
  });

  test('runLegacyBeadsMigration preserves issue ids, dependency edges, comments, and config via verifyMigrationParity', async () => {
    const subject = await loadSubject();
    const seeded = seedLegacyRepo(projectRoot);

    const result = await subject.runLegacyBeadsMigration({
      projectRoot,
      legacyBackupDir: seeded.legacyBackupDir,
      snapshotRoot: seeded.snapshotRoot,
      migratedDir: seeded.migratedDir,
      exportDir: seeded.exportDir,
      importBackup: makeImportStub(),
    });

    expect(result.status).toBe('migrated');
    expect(result.snapshotDir.startsWith(seeded.snapshotRoot)).toBe(true);
    expect(result.parity.ok).toBe(true);
    expect(result.parity.counts).toEqual({
      issues: 2,
      labels: 2,
      dependencies: 1,
      comments: 2,
      events: 3,
      config: 2,
    });
    expect(result.parity.issueIds).toEqual(['forge-aa1', 'forge-bb2']);
    expect(result.parity.dependencyEdges).toEqual([
      'forge-bb2 blocks forge-aa1',
    ]);
    expect(result.parity.commentIds).toEqual([
      'comment-forge-aa1-1',
      'comment-forge-bb2-1',
    ]);
    expect(result.parity.configKeys).toEqual([
      'auto_compact_enabled',
      'compact_batch_size',
    ]);

    const directParity = await subject.verifyMigrationParity({
      legacyBackupDir: result.legacyBackupDir,
      exportDir: seeded.exportDir,
    });
    expect(directParity).toEqual(result.parity);
  });

  test('runLegacyBeadsMigration replaces the live .beads state after a verified migration', async () => {
    const subject = await loadSubject();
    const seeded = seedLegacyRepo(projectRoot);

    const result = await subject.runLegacyBeadsMigration({
      projectRoot,
      legacyBackupDir: seeded.legacyBackupDir,
      snapshotRoot: seeded.snapshotRoot,
      migratedDir: seeded.migratedDir,
      exportDir: seeded.exportDir,
      importBackup: makeImportStub(),
    });

    expect(result.status).toBe('migrated');
    expect(fs.readFileSync(path.join(seeded.beadsDir, 'config.yaml'), 'utf8')).toContain(
      'backend: dolt',
    );
    expect(fs.readFileSync(path.join(seeded.beadsDir, 'MIGRATED.txt'), 'utf8')).toBe(
      'migrated-state\n',
    );
    expect(fs.existsSync(path.join(seeded.beadsDir, 'beads.db'))).toBe(false);
  });

  test('runLegacyBeadsMigration restores the original .beads state when parity verification fails after import', async () => {
    const subject = await loadSubject();
    const seeded = seedLegacyRepo(projectRoot);
    const originalConfig = fs.readFileSync(
      path.join(seeded.beadsDir, 'config.yaml'),
      'utf8',
    );
    const originalIssues = fs.readFileSync(
      path.join(seeded.beadsDir, 'issues.jsonl'),
      'utf8',
    );

    await expect(
      subject.runLegacyBeadsMigration({
        projectRoot,
        legacyBackupDir: seeded.legacyBackupDir,
        snapshotRoot: seeded.snapshotRoot,
        migratedDir: seeded.migratedDir,
        exportDir: seeded.exportDir,
        importBackup: makeImportStub({ mismatchIssue: true }),
      }),
    ).rejects.toThrow(/parity verification failed/i);

    expect(fs.readFileSync(path.join(seeded.beadsDir, 'config.yaml'), 'utf8')).toBe(
      originalConfig,
    );
    expect(fs.readFileSync(path.join(seeded.beadsDir, 'issues.jsonl'), 'utf8')).toBe(
      originalIssues,
    );
    expect(fs.existsSync(seeded.snapshotRoot)).toBe(true);

    const snapshotEntries = fs.readdirSync(seeded.snapshotRoot);
    expect(snapshotEntries.length).toBeGreaterThan(0);
  });

  test('runLegacyBeadsMigration is rerun-safe and skips when a prior migration manifest already exists', async () => {
    const subject = await loadSubject();
    const seeded = seedLegacyRepo(projectRoot);
    fs.mkdirSync(seeded.migratedDir, { recursive: true });
    fs.writeFileSync(
      path.join(seeded.migratedDir, 'migration-manifest.json'),
      JSON.stringify({ status: 'migrated', issueIds: ['forge-aa1', 'forge-bb2'] }),
      'utf8',
    );

    let importerCalled = false;
    const result = await subject.runLegacyBeadsMigration({
      projectRoot,
      legacyBackupDir: seeded.legacyBackupDir,
      snapshotRoot: seeded.snapshotRoot,
      migratedDir: seeded.migratedDir,
      exportDir: seeded.exportDir,
      importBackup: async () => {
        importerCalled = true;
      },
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'already migrated',
      migratedDir: seeded.migratedDir,
    });
    expect(importerCalled).toBe(false);
  });

  test('runLegacyBeadsMigration falls back to live legacy JSONL when the backup directory is missing', async () => {
    const subject = await loadSubject();
    const seeded = seedLegacyRepo(projectRoot, {
      withBackup: false,
      mirrorLiveBackupFiles: true,
    });
    let importSourceDir = null;

    const result = await subject.runLegacyBeadsMigration({
      projectRoot,
      legacyBackupDir: seeded.legacyBackupDir,
      snapshotRoot: seeded.snapshotRoot,
      migratedDir: seeded.migratedDir,
      exportDir: seeded.exportDir,
      importBackup: async ({ sourceDir, migratedDir, exportDir }) => {
        importSourceDir = sourceDir;
        return makeImportStub()({ sourceDir, migratedDir, exportDir });
      },
    });

    expect(result.status).toBe('migrated');
    expect(importSourceDir).not.toBeNull();
    expect(importSourceDir).not.toBe(seeded.legacyBackupDir);
    expect(fs.existsSync(path.join(importSourceDir, 'issues.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(importSourceDir, 'config.jsonl'))).toBe(true);
    expect(result.parity.ok).toBe(true);
  });

  test('fixtures stay parseable and match the expected legacy counts', () => {
    const counts = {
      issues: readJsonl(path.join(FIXTURE_ROOT, 'issues.jsonl')).length,
      labels: readJsonl(path.join(FIXTURE_ROOT, 'labels.jsonl')).length,
      dependencies: readJsonl(path.join(FIXTURE_ROOT, 'dependencies.jsonl')).length,
      comments: readJsonl(path.join(FIXTURE_ROOT, 'comments.jsonl')).length,
      events: readJsonl(path.join(FIXTURE_ROOT, 'events.jsonl')).length,
      config: readJsonl(path.join(FIXTURE_ROOT, 'config.jsonl')).length,
    };

    expect(counts).toEqual({
      issues: 2,
      labels: 2,
      dependencies: 1,
      comments: 2,
      events: 3,
      config: 2,
    });
  });

  test('cli help still runs when the script path contains spaces', () => {
    const dirWithSpace = makeTmpDir().replace(/beads-migrate-to-dolt-/, 'beads migrate to dolt ');
    fs.renameSync(projectRoot, dirWithSpace);
    projectRoot = dirWithSpace;

    const copiedScript = path.join(projectRoot, 'beads-migrate-to-dolt.mjs');
    fs.copyFileSync(SUBJECT_PATH, copiedScript);

    const stdout = execFileSync(process.execPath, [copiedScript, '--help'], {
      encoding: 'utf8',
      cwd: projectRoot,
    });

    expect(stdout).toContain('Usage: beads-migrate-to-dolt');
  });
});
