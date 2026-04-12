#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const BACKUP_FILES = [
  'issues.jsonl',
  'labels.jsonl',
  'dependencies.jsonl',
  'comments.jsonl',
  'events.jsonl',
  'config.jsonl',
];

function sanitizePrefix(value) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function ensureBackupShape(legacyBackupDir) {
  if (!fs.existsSync(legacyBackupDir) || !fs.statSync(legacyBackupDir).isDirectory()) {
    throw new Error(`Legacy backup directory not found: ${legacyBackupDir}`);
  }

  for (const file of BACKUP_FILES) {
    const filePath = path.join(legacyBackupDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing backup file: ${filePath}`);
    }
  }
}

function loadBackupData(backupDir) {
  ensureBackupShape(backupDir);
  return {
    issues: readJsonl(path.join(backupDir, 'issues.jsonl')),
    labels: readJsonl(path.join(backupDir, 'labels.jsonl')),
    dependencies: readJsonl(path.join(backupDir, 'dependencies.jsonl')),
    comments: readJsonl(path.join(backupDir, 'comments.jsonl')),
    events: readJsonl(path.join(backupDir, 'events.jsonl')),
    config: readJsonl(path.join(backupDir, 'config.jsonl')),
  };
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function normalizeRecord(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeRecord(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeRecord(value[key])]),
    );
  }
  return value;
}

function stableSerializeRecord(record) {
  return JSON.stringify(normalizeRecord(record));
}

function arraysEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectParity(data) {
  return {
    counts: {
      issues: data.issues.length,
      labels: data.labels.length,
      dependencies: data.dependencies.length,
      comments: data.comments.length,
      events: data.events.length,
      config: data.config.length,
    },
    issueIds: data.issues.map((issue) => issue.id).sort(),
    dependencyEdges: data.dependencies
      .map((dep) => `${dep.issue_id} ${dep.type} ${dep.depends_on_id}`)
      .sort(),
    commentIds: data.comments.map((comment) => comment.id).sort(),
    configKeys: data.config.map((entry) => entry.key).sort(),
    issueRecords: data.issues.map((issue) => stableSerializeRecord(issue)).sort(),
    labelRecords: data.labels.map((label) => stableSerializeRecord(label)).sort(),
    dependencyRecords: data.dependencies
      .map((dependency) => stableSerializeRecord(dependency))
      .sort(),
    commentRecords: data.comments.map((comment) => stableSerializeRecord(comment)).sort(),
    eventRecords: data.events.map((event) => stableSerializeRecord(event)).sort(),
    configRecords: data.config.map((entry) => stableSerializeRecord(entry)).sort(),
  };
}

function summarizeParityMismatch(parity) {
  const parts = [];
  if (parity.missingIssueIds.length > 0 || parity.extraIssueIds.length > 0) {
    parts.push('issue ids differ');
  }
  if (
    parity.missingDependencyEdges.length > 0 ||
    parity.extraDependencyEdges.length > 0
  ) {
    parts.push('dependency edges differ');
  }
  if (parity.missingCommentIds.length > 0 || parity.extraCommentIds.length > 0) {
    parts.push('comment ids differ');
  }
  if (parity.missingConfigKeys.length > 0 || parity.extraConfigKeys.length > 0) {
    parts.push('config keys differ');
  }
  const recordMismatchMessages = {
    issues: 'issue records differ',
    labels: 'label records differ',
    dependencies: 'dependency records differ',
    comments: 'comment records differ',
    events: 'event records differ',
    config: 'config records differ',
  };
  for (const kind of parity.recordMismatches || []) {
    const message = recordMismatchMessages[kind];
    if (message && !parts.includes(message)) {
      parts.push(message);
    }
  }
  if (parts.length === 0) {
    parts.push('record counts differ');
  }
  return parts.join('; ');
}

export async function verifyMigrationParity({ legacyBackupDir, exportDir }) {
  const source = collectParity(loadBackupData(legacyBackupDir));
  const exported = collectParity(loadBackupData(exportDir));
  const recordMismatches = Object.entries({
    issues: arraysEqual(source.issueRecords, exported.issueRecords),
    labels: arraysEqual(source.labelRecords, exported.labelRecords),
    dependencies: arraysEqual(source.dependencyRecords, exported.dependencyRecords),
    comments: arraysEqual(source.commentRecords, exported.commentRecords),
    events: arraysEqual(source.eventRecords, exported.eventRecords),
    config: arraysEqual(source.configRecords, exported.configRecords),
  })
    .filter(([, match]) => !match)
    .map(([kind]) => kind);

  const parity = {
    ok:
      arraysEqual(source.counts, exported.counts) &&
      arraysEqual(source.issueIds, exported.issueIds) &&
      arraysEqual(source.dependencyEdges, exported.dependencyEdges) &&
      arraysEqual(source.commentIds, exported.commentIds) &&
      arraysEqual(source.configKeys, exported.configKeys) &&
      recordMismatches.length === 0,
    counts: source.counts,
    issueIds: source.issueIds,
    dependencyEdges: source.dependencyEdges,
    commentIds: source.commentIds,
    configKeys: source.configKeys,
    recordMismatches,
    missingIssueIds: setDifference(source.issueIds, exported.issueIds),
    extraIssueIds: setDifference(exported.issueIds, source.issueIds),
    missingDependencyEdges: setDifference(
      source.dependencyEdges,
      exported.dependencyEdges,
    ),
    extraDependencyEdges: setDifference(
      exported.dependencyEdges,
      source.dependencyEdges,
    ),
    missingCommentIds: setDifference(source.commentIds, exported.commentIds),
    extraCommentIds: setDifference(exported.commentIds, source.commentIds),
    missingConfigKeys: setDifference(source.configKeys, exported.configKeys),
    extraConfigKeys: setDifference(exported.configKeys, source.configKeys),
  };

  return parity;
}

function snapshotCurrentBeads(projectRoot, snapshotRoot, now = new Date()) {
  const liveBeadsDir = path.join(projectRoot, '.beads');
  if (!fs.existsSync(liveBeadsDir)) {
    throw new Error(`Beads directory not found: ${liveBeadsDir}`);
  }

  const timestamp = now.toISOString().replaceAll(':', '-');
  const snapshotDir = path.join(snapshotRoot, timestamp);
  const snapshotBeadsDir = path.join(snapshotDir, 'current-beads');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.cpSync(liveBeadsDir, snapshotBeadsDir, { recursive: true });
  return snapshotDir;
}

function materializeLegacyBackupDir({ legacyBackupDir, snapshotDir }) {
  const snapshotBeadsDir = path.join(snapshotDir, 'current-beads');
  const synthesizedBackupDir = path.join(snapshotDir, 'legacy-backup');
  fs.mkdirSync(synthesizedBackupDir, { recursive: true });

  for (const file of BACKUP_FILES) {
    const backupCandidate = path.join(legacyBackupDir, file);
    const liveCandidate = path.join(snapshotBeadsDir, file);
    const sourcePath = fs.existsSync(liveCandidate) ? liveCandidate : backupCandidate;
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing legacy backup file: ${file}`);
    }
    fs.copyFileSync(sourcePath, path.join(synthesizedBackupDir, file));
  }

  return synthesizedBackupDir;
}

function applyMigratedBeadsState({ projectRoot, migratedDir }) {
  const liveBeadsDir = path.join(projectRoot, '.beads');
  const migratedBeadsDir = path.join(migratedDir, '.beads');
  const stagedBeadsDir = path.join(projectRoot, `.beads.next-${Date.now()}`);

  if (!fs.existsSync(migratedBeadsDir) || !fs.statSync(migratedBeadsDir).isDirectory()) {
    throw new Error(`Migrated Beads directory not found: ${migratedBeadsDir}`);
  }

  fs.rmSync(stagedBeadsDir, { recursive: true, force: true });
  fs.cpSync(migratedBeadsDir, stagedBeadsDir, { recursive: true });
  fs.rmSync(liveBeadsDir, { recursive: true, force: true });
  fs.renameSync(stagedBeadsDir, liveBeadsDir);

  return {
    liveBeadsDir,
    migratedBeadsDir,
  };
}

function defaultCliPaths(projectRoot) {
  return {
    legacyBackupDir: path.join(projectRoot, '.beads', 'backup'),
    snapshotRoot: path.join(projectRoot, '.beads-migration-snapshots'),
    migratedDir: path.join(projectRoot, '.beads-migrated'),
    exportDir: path.join(projectRoot, '.beads-migrated-export'),
  };
}

export async function rollbackLegacyBeadsMigration({ projectRoot, snapshotDir }) {
  const liveBeadsDir = path.join(projectRoot, '.beads');
  const snapshotBeadsDir = path.join(snapshotDir, 'current-beads');

  if (!fs.existsSync(snapshotBeadsDir)) {
    throw new Error(`Snapshot payload not found: ${snapshotBeadsDir}`);
  }

  fs.rmSync(liveBeadsDir, { recursive: true, force: true });
  fs.cpSync(snapshotBeadsDir, liveBeadsDir, { recursive: true });

  return {
    restored: true,
    snapshotDir,
    liveBeadsDir,
  };
}

function resolveBdCommand() {
  return process.env.BD_CMD || 'bd';
}

function inferPrefix(projectRoot) {
  const configPath = path.join(projectRoot, '.beads', 'config.yaml');
  if (fs.existsSync(configPath)) {
    const match = /^issue-prefix:\s*(.+)$/m.exec(fs.readFileSync(configPath, 'utf8'));
    if (match?.[1]) {
      return sanitizePrefix(match[1]);
    }
  }
  return sanitizePrefix(path.basename(projectRoot) || 'beads');
}

export function defaultImportBackup({
  projectRoot,
  sourceDir,
  migratedDir,
  exportDir,
}) {
  const bd = resolveBdCommand();
  fs.mkdirSync(migratedDir, { recursive: true });
  fs.rmSync(exportDir, { recursive: true, force: true });

  const prefix = inferPrefix(projectRoot);
  const execOpts = {
    cwd: migratedDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      BEADS_DIR: path.join(migratedDir, '.beads'),
    },
  };

  execFileSync(
    bd,
    ['init', '--force', '--prefix', prefix, '--skip-hooks', '--skip-agents'],
    execOpts,
  );
  execFileSync(bd, ['backup', 'restore', sourceDir], execOpts);
  execFileSync(bd, ['backup', '--force'], execOpts);

  const exportedBackupDir = path.join(migratedDir, '.beads', 'backup');
  ensureBackupShape(exportedBackupDir);
  fs.cpSync(exportedBackupDir, exportDir, { recursive: true });

  return {
    strategy: 'bd-backup-restore',
    prefix,
  };
}

function writeManifest(manifestPath, payload) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function runLegacyBeadsMigration(options) {
  const {
    projectRoot,
    legacyBackupDir,
    snapshotRoot,
    migratedDir,
    exportDir,
    importBackup = defaultImportBackup,
    now = new Date(),
  } = options;

  if (!projectRoot || !legacyBackupDir || !snapshotRoot || !migratedDir || !exportDir) {
    throw new Error('projectRoot, legacyBackupDir, snapshotRoot, migratedDir, and exportDir are required');
  }

  const manifestPath = path.join(migratedDir, 'migration-manifest.json');
  if (fs.existsSync(manifestPath)) {
    return {
      status: 'skipped',
      reason: 'already migrated',
      migratedDir,
    };
  }

  const snapshotDir = snapshotCurrentBeads(projectRoot, snapshotRoot, now);
  const resolvedLegacyBackupDir = materializeLegacyBackupDir({
    legacyBackupDir,
    snapshotDir,
  });
  let rolledBack = false;

  try {
    const importResult = await importBackup({
      projectRoot,
      sourceDir: resolvedLegacyBackupDir,
      migratedDir,
      exportDir,
      snapshotDir,
    });

    const parity = await verifyMigrationParity({
      legacyBackupDir: resolvedLegacyBackupDir,
      exportDir,
    });

    if (!parity.ok) {
      await rollbackLegacyBeadsMigration({ projectRoot, snapshotDir });
      rolledBack = true;

      const error = new Error(
        `Parity verification failed: ${summarizeParityMismatch(parity)}`,
      );
      error.parity = parity;
      throw error;
    }

    const appliedState = applyMigratedBeadsState({
      projectRoot,
      migratedDir,
    });

    writeManifest(manifestPath, {
      status: 'migrated',
      createdAt: now.toISOString(),
      snapshotDir,
      legacyBackupDir: resolvedLegacyBackupDir,
      parity,
      appliedState,
      importResult: importResult || null,
    });

    return {
      status: 'migrated',
      snapshotDir,
      migratedDir,
      exportDir,
      legacyBackupDir: resolvedLegacyBackupDir,
      appliedState,
      parity,
      importResult: importResult || null,
    };
  } catch (error) {
    if (!rolledBack) {
      await rollbackLegacyBeadsMigration({ projectRoot, snapshotDir });
    }
    throw error;
  }
}

export function parseCliArgs(argv, cwd = process.cwd()) {
  const options = {
    projectRoot: cwd,
    ...defaultCliPaths(cwd),
  };
  const explicitPathFlags = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--project-root':
        options.projectRoot = path.resolve(argv[++i]);
        for (const [key, value] of Object.entries(defaultCliPaths(options.projectRoot))) {
          if (!explicitPathFlags.has(key)) {
            options[key] = value;
          }
        }
        break;
      case '--legacy-backup-dir':
        options.legacyBackupDir = path.resolve(argv[++i]);
        explicitPathFlags.add('legacyBackupDir');
        break;
      case '--snapshot-root':
        options.snapshotRoot = path.resolve(argv[++i]);
        explicitPathFlags.add('snapshotRoot');
        break;
      case '--migrated-dir':
        options.migratedDir = path.resolve(argv[++i]);
        explicitPathFlags.add('migratedDir');
        break;
      case '--export-dir':
        options.exportDir = path.resolve(argv[++i]);
        explicitPathFlags.add('exportDir');
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage: beads-migrate-to-dolt [options]

Options:
  --project-root <path>       Project root containing .beads/
  --legacy-backup-dir <path>  Legacy JSONL backup directory
  --snapshot-root <path>      Where rollback snapshots are stored
  --migrated-dir <path>       Working directory for migrated Beads state
  --export-dir <path>         Export directory used for parity verification
  -h, --help                  Show this help message
`);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const result = await runLegacyBeadsMigration(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    if (error.parity) {
      console.error(JSON.stringify(error.parity, null, 2));
    }
    process.exitCode = 1;
  });
}
