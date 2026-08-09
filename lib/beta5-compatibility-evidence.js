'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectBuiltinSQLiteRuntime } = require('./kernel/sqlite-driver');

const BETA5_VERSION = '0.1.0-beta.5';
const BETA5_RELEASE_COMMIT = 'ebeb4e5b31fc2dacdf23c5936c02fb2656990f49';
const BETA5_CORPUS_ROOT = path.join(__dirname, 'fixtures', 'beta5-corpus', 'v1');
const KERNEL_COUNT_TABLES = Object.freeze({
  issues: 'kernel_issues',
  comments: 'kernel_comments',
  dependencies: 'kernel_dependencies',
  claims: 'kernel_claims',
  runs: 'kernel_stage_runs',
  projections: 'kernel_projections',
  worktrees: 'kernel_worktrees',
  events: 'kernel_events',
});
const REQUIRED_KERNEL_TABLES = Object.freeze(['kernel_migrations', ...Object.values(KERNEL_COUNT_TABLES)]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isSafeRelativePath(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.length > 0
    && !path.isAbsolute(relativePath)
    && !relativePath.split(/[\\/]/).includes('..');
}

function aggregateHash(files) {
  const canonical = [...files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(file => `${file.path}\0${file.sha256}\n`)
    .join('');
  return sha256(canonical);
}

function listCorpusFiles(root, relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCorpusFiles(root, relativePath));
    } else {
      files.push(relativePath.replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function validateCorpusMetadata(manifest) {
  const reasons = [];
  if (manifest.schema_version !== 'forge.beta5-corpus.v1') reasons.push('schema_version_mismatch');
  if (manifest.release_version !== BETA5_VERSION) reasons.push('release_version_mismatch');
  if (manifest.release_commit !== BETA5_RELEASE_COMMIT) reasons.push('release_commit_mismatch');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) reasons.push('file_manifest_empty');
  const sourceBlobs = manifest.source_blobs && typeof manifest.source_blobs === 'object'
    ? Object.entries(manifest.source_blobs)
    : [];
  const invalidSource = sourceBlobs.some(([source, blob]) => !isSafeRelativePath(source)
    || !/^[a-f0-9]{40}$/.test(blob));
  if (sourceBlobs.length !== 4 || invalidSource) reasons.push('source_provenance_invalid');
  return { reasons, sourceBlobs };
}

function observeCorpusEntry(corpusRoot, entry) {
  if (!isSafeRelativePath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
    return { reason: `invalid_entry:${String(entry.path)}` };
  }
  const root = path.resolve(corpusRoot);
  const filePath = path.resolve(root, entry.path);
  if (!filePath.startsWith(`${root}${path.sep}`)) return { reason: `path_escape:${entry.path}` };
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { reason: `not_regular_file:${entry.path}` };
    const observed = { path: entry.path, sha256: sha256(fs.readFileSync(filePath)) };
    return observed.sha256 === entry.sha256
      ? { observed }
      : { observed, reason: `hash_mismatch:${entry.path}` };
  } catch (_error) {
    return { reason: `missing_file:${entry.path}` };
  }
}

function findUnmanifestedFiles(corpusRoot, manifestFiles) {
  try {
    const declared = new Set(manifestFiles.map(entry => entry.path));
    return listCorpusFiles(corpusRoot)
      .filter(relativePath => relativePath !== 'manifest.json' && !declared.has(relativePath))
      .map(relativePath => `unmanifested_file:${relativePath}`);
  } catch (_error) {
    return ['corpus_inventory_unreadable'];
  }
}

function verifyBeta5Corpus(corpusRoot = BETA5_CORPUS_ROOT) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
  } catch (_error) {
    return { status: 'FAIL', reasons: ['manifest_unreadable'] };
  }

  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const metadata = validateCorpusMetadata(manifest);
  const observations = manifestFiles.map(entry => observeCorpusEntry(corpusRoot, entry));
  const observedFiles = observations.flatMap(result => result.observed ? [result.observed] : []);
  const reasons = [
    ...metadata.reasons,
    ...observations.flatMap(result => result.reason ? [result.reason] : []),
    ...findUnmanifestedFiles(corpusRoot, manifestFiles),
  ];

  const observedContentHash = aggregateHash(observedFiles);
  if (observedFiles.length === manifest.files?.length && observedContentHash !== manifest.content_hash) {
    reasons.push('content_hash_mismatch');
  }

  return {
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    version: manifest.release_version || null,
    releaseCommit: manifest.release_commit || null,
    corpusVersion: manifest.corpus_version || null,
    fileCount: observedFiles.length,
    sourceBlobCount: metadata.sourceBlobs.length,
    contentHash: observedContentHash,
    reasons: [...new Set(reasons)].sort(),
  };
}

function inspectJsonl(filePath) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false, records: 0 };
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'INCOMPLETE', present: true, reason: 'not_regular_file' };
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(line => line.trim());
    for (const line of lines) JSON.parse(line);
    return { status: 'PASS', present: true, records: lines.length };
  } catch (_error) {
    return { status: 'INCOMPLETE', present: true, reason: 'unreadable_or_malformed' };
  }
}

function inspectPackage(filePath) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false, beta5Declared: false };
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const declared = [value.version, value.dependencies?.['forge-workflow'], value.devDependencies?.['forge-workflow']]
      .filter(Boolean);
    return { status: 'PASS', present: true, beta5Declared: declared.includes(BETA5_VERSION) };
  } catch (_error) {
    return { status: 'INCOMPLETE', present: true, reason: 'unreadable_or_malformed' };
  }
}

function inspectPresence(filePath) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false };
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink()
      ? { status: 'PASS', present: true, bytes: stat.size }
      : { status: 'INCOMPLETE', present: true, reason: 'not_regular_file' };
  } catch (_error) {
    return { status: 'INCOMPLETE', present: true, reason: 'unreadable' };
  }
}

function openReadOnlyDatabase(runtime, databasePath) {
  if (runtime.id === 'bun:sqlite') {
    return new runtime.module.Database(databasePath, { readonly: true, create: false, strict: true });
  }
  if (runtime.id === 'node:sqlite') {
    return new runtime.module.DatabaseSync(databasePath, { readOnly: true });
  }
  throw new Error(`Unsupported builtin SQLite runtime: ${runtime.id}`);
}

function queryAll(runtime, database, sql) {
  return runtime.id === 'bun:sqlite' ? database.query(sql).all() : database.prepare(sql).all();
}

function queryOne(runtime, database, sql) {
  return queryAll(runtime, database, sql)[0] || {};
}

function closeDatabase(database) {
  if (database && typeof database.close === 'function') database.close();
}

function hasSqliteHeader(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(16);
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return header.toString('utf8') === 'SQLite format 3\0';
}

function countKernelRows(runtime, database) {
  return Object.fromEntries(Object.entries(KERNEL_COUNT_TABLES).map(([label, table]) => [
    label,
    Number(queryOne(runtime, database, `SELECT COUNT(*) AS count FROM "${table}";`).count || 0),
  ]));
}

function inspectKernel(filePath) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false, unknowns: [] };
  let database;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'INCOMPLETE', present: true, reason: 'not_regular_file', unknowns: ['kernel_schema'] };
    }
    if (!hasSqliteHeader(filePath)) {
      return { status: 'INCOMPLETE', present: true, reason: 'unrecognized_database', unknowns: ['kernel_schema'] };
    }
    const runtime = selectBuiltinSQLiteRuntime();
    database = openReadOnlyDatabase(runtime, filePath);
    const tableNames = new Set(queryAll(
      runtime,
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    ).map(row => String(row.name)));
    const missingTables = REQUIRED_KERNEL_TABLES.filter(table => !tableNames.has(table));
    const integrity = String(queryOne(runtime, database, 'PRAGMA quick_check;').quick_check || 'unknown');
    const migrationIds = tableNames.has('kernel_migrations')
      ? queryAll(runtime, database, 'SELECT id FROM kernel_migrations ORDER BY id;').map(row => String(row.id))
      : [];
    const unknowns = [];
    if (missingTables.length > 0) unknowns.push('missing_required_tables');
    if (integrity !== 'ok') unknowns.push('integrity_check');
    if (migrationIds.length === 0) unknowns.push('migration_version');
    return {
      status: unknowns.length === 0 ? 'PASS' : 'INCOMPLETE',
      present: true,
      schemaVersion: migrationIds.at(-1) || null,
      migrationCount: migrationIds.length,
      counts: missingTables.length === 0 ? countKernelRows(runtime, database) : null,
      additionalTableCount: Math.max(0, tableNames.size - REQUIRED_KERNEL_TABLES.length),
      unknowns,
    };
  } catch (_error) {
    return { status: 'INCOMPLETE', present: true, reason: 'unreadable_or_unsupported', unknowns: ['kernel_schema'] };
  } finally {
    closeDatabase(database);
  }
}

function buildPrivacySafeInventory(projectRoot) {
  const surfaces = {
    package: inspectPackage(path.join(projectRoot, 'package.json')),
    config: inspectPresence(path.join(projectRoot, '.forge', 'config.yaml')),
    project: inspectPresence(path.join(projectRoot, '.forge', 'project.json')),
    issues: inspectJsonl(path.join(projectRoot, '.forge', 'issues.jsonl')),
    kernel: inspectKernel(path.join(projectRoot, '.forge', 'kernel.sqlite')),
  };
  const unknowns = [];
  if (surfaces.package.status === 'INCOMPLETE') unknowns.push('package_contract');
  if (surfaces.package.status === 'PASS' && !surfaces.package.beta5Declared) unknowns.push('beta5_install_contract');
  if (surfaces.config.status === 'INCOMPLETE') unknowns.push('config_shape');
  if (surfaces.project.status === 'INCOMPLETE') unknowns.push('project_marker');
  if (surfaces.issues.status === 'INCOMPLETE') unknowns.push('issue_records');
  if (surfaces.kernel.status === 'INCOMPLETE') unknowns.push(...surfaces.kernel.unknowns);
  return {
    schemaVersion: 'forge.beta5-inventory.v1',
    status: unknowns.length === 0 ? 'PASS' : 'INCOMPLETE',
    surfaces,
    unknowns: [...new Set(unknowns)].sort(),
  };
}

function isContained(rootIdentity, candidateIdentity) {
  const relative = path.relative(rootIdentity, candidateIdentity);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function recordStateEntry(rootIdentity, absolutePath, relativePath, files, reasons) {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    reasons.push('state_tree_contains_link');
    return;
  }
  const identity = fs.realpathSync.native(absolutePath);
  if (!isContained(rootIdentity, identity)) {
    reasons.push('state_tree_outside_root');
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      recordStateEntry(rootIdentity, path.join(absolutePath, entry), path.join(relativePath, entry), files, reasons);
    }
    return;
  }
  if (!stat.isFile()) {
    reasons.push('state_tree_unsupported_entry');
    return;
  }
  files.push({ path: relativePath.replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(absolutePath)) });
}

function buildStateTreeManifest(projectRoot) {
  const reasons = [];
  const files = [];
  try {
    const rootStat = fs.lstatSync(projectRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { status: 'INCOMPLETE', fileCount: 0, hash: sha256(''), files, reasons: ['state_root_not_directory'] };
    }
    const rootIdentity = fs.realpathSync.native(projectRoot);
    for (const relativePath of ['.forge', 'package.json']) {
      const absolutePath = path.join(projectRoot, relativePath);
      if (fs.existsSync(absolutePath)) {
        recordStateEntry(rootIdentity, absolutePath, relativePath, files, reasons);
      }
    }
  } catch (_error) {
    reasons.push('state_tree_unreadable');
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    status: reasons.length === 0 ? 'PASS' : 'INCOMPLETE',
    fileCount: files.length,
    hash: aggregateHash(files),
    files,
    reasons: [...new Set(reasons)].sort(),
  };
}

function isKernelSidecar(relativePath) {
  return /^\.forge\/kernel\.sqlite(?:-(?:wal|shm))?$/.test(relativePath);
}

function copyManifestFiles(sourceRoot, destinationRoot, files) {
  for (const file of files) {
    const target = path.join(destinationRoot, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, file.path), target, fs.constants.COPYFILE_EXCL);
  }
}

function normalizeSqlValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return value;
}

function normalizeSqlRow(row) {
  return Object.fromEntries(Object.keys(row).sort().map(key => [key, normalizeSqlValue(row[key])]));
}

function kernelSemanticSignature(databasePath) {
  const runtime = selectBuiltinSQLiteRuntime();
  const database = openReadOnlyDatabase(runtime, databasePath);
  try {
    const integrity = String(queryOne(runtime, database, 'PRAGMA quick_check;').quick_check || 'unknown');
    const schemaRows = queryAll(
      runtime,
      database,
      "SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'kernel_%' ORDER BY type, name;",
    ).map(normalizeSqlRow);
    const presentTables = new Set(schemaRows.filter(row => row.type === 'table').map(row => row.name));
    const content = [];
    const counts = {};
    for (const table of REQUIRED_KERNEL_TABLES) {
      if (!presentTables.has(table)) continue;
      const rows = queryAll(runtime, database, `SELECT * FROM "${table}";`)
        .map(normalizeSqlRow)
        .map(row => JSON.stringify(row))
        .sort();
      counts[table] = rows.length;
      content.push(`${table}\0${rows.join('\n')}\n`);
    }
    return {
      integrity,
      schemaHash: sha256(JSON.stringify(schemaRows)),
      contentHash: sha256(content.join('')),
      counts,
    };
  } finally {
    closeDatabase(database);
  }
}

async function createKernelBackup(sourcePath, backupPath) {
  const runtime = selectBuiltinSQLiteRuntime();
  const database = openReadOnlyDatabase(runtime, sourcePath);
  try {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    if (runtime.id === 'bun:sqlite') {
      if (typeof database.serialize !== 'function') throw new Error('bun sqlite backup unavailable');
      fs.writeFileSync(backupPath, database.serialize(), { flag: 'wx' });
      return;
    }
    if (typeof runtime.module.backup === 'function') {
      await runtime.module.backup(database, backupPath);
      return;
    }
    if (typeof database.backup === 'function') {
      await database.backup(backupPath);
      return;
    }
    throw new Error('node sqlite backup unavailable');
  } finally {
    closeDatabase(database);
  }
}

function validateProofRoots(sourceRoot, proofRoot) {
  try {
    const sourceStat = fs.lstatSync(sourceRoot);
    const proofStat = fs.lstatSync(proofRoot);
    const tempStat = fs.lstatSync(os.tmpdir());
    if (sourceStat.isSymbolicLink() || proofStat.isSymbolicLink() || tempStat.isSymbolicLink()) {
      return 'proof_root_link_refused';
    }
    if (!sourceStat.isDirectory() || !proofStat.isDirectory() || !tempStat.isDirectory()) {
      return 'proof_root_unavailable';
    }
    const source = fs.realpathSync.native(sourceRoot);
    const proof = fs.realpathSync.native(proofRoot);
    const temporary = fs.realpathSync.native(os.tmpdir());
    if (!isContained(temporary, proof) || proof === temporary) return 'proof_root_not_temporary';
    if (isContained(source, proof) || isContained(proof, source)) return 'proof_root_overlaps_source';
    if (fs.readdirSync(proofRoot).length > 0) return 'proof_destination_not_empty';
    return null;
  } catch (_error) {
    return 'proof_root_unavailable';
  }
}

function compareKernelSignatures(source, restored) {
  return {
    integrity: source.integrity === 'ok' && restored.integrity === 'ok' ? 'ok' : 'failed',
    schemaHashMatched: source.schemaHash === restored.schemaHash,
    contentHashMatched: source.contentHash === restored.contentHash,
    countsMatched: JSON.stringify(source.counts) === JSON.stringify(restored.counts),
  };
}

async function proveBackupRestore(sourceRoot, proofRoot) {
  const rootError = validateProofRoots(sourceRoot, proofRoot);
  if (rootError) return { status: 'FAIL', reason: rootError, files: [] };
  const sourceManifest = buildStateTreeManifest(sourceRoot);
  if (sourceManifest.status !== 'PASS') {
    return { status: 'INCOMPLETE', reason: 'source_tree_incomplete', files: [] };
  }
  if (sourceManifest.fileCount === 0) return { status: 'INCOMPLETE', reason: 'no_known_state_files', files: [] };
  const backupRoot = path.join(proofRoot, 'backup');
  const restoreRoot = path.join(proofRoot, 'restore');
  const ordinaryFiles = sourceManifest.files.filter(file => !isKernelSidecar(file.path));
  const kernelRelativePath = '.forge/kernel.sqlite';
  const hasKernel = sourceManifest.files.some(file => file.path === kernelRelativePath);
  try {
    copyManifestFiles(sourceRoot, backupRoot, ordinaryFiles);
    let sourceKernelSignature = null;
    if (hasKernel) {
      sourceKernelSignature = kernelSemanticSignature(path.join(sourceRoot, kernelRelativePath));
      await createKernelBackup(path.join(sourceRoot, kernelRelativePath), path.join(backupRoot, kernelRelativePath));
    }
    const backupFiles = ordinaryFiles.map(file => file.path);
    if (hasKernel) backupFiles.push(kernelRelativePath);
    copyManifestFiles(backupRoot, restoreRoot, backupFiles.map(filePath => ({ path: filePath })));
    const sourceHash = aggregateHash(ordinaryFiles);
    const backupHash = aggregateHash(ordinaryFiles.map(file => ({
      path: file.path,
      sha256: sha256(fs.readFileSync(path.join(backupRoot, file.path))),
    })));
    const restoreHash = aggregateHash(ordinaryFiles.map(file => ({
      path: file.path,
      sha256: sha256(fs.readFileSync(path.join(restoreRoot, file.path))),
    })));
    const kernel = hasKernel
      ? compareKernelSignatures(sourceKernelSignature, kernelSemanticSignature(path.join(restoreRoot, kernelRelativePath)))
      : null;
    const kernelMatches = !kernel || (kernel.integrity === 'ok' && kernel.schemaHashMatched
      && kernel.contentHashMatched && kernel.countsMatched);
    const fileBytesMatched = sourceHash === backupHash && backupHash === restoreHash;
    return {
      status: fileBytesMatched && kernelMatches ? 'PASS' : 'FAIL',
      reason: fileBytesMatched && kernelMatches ? null : 'backup_restore_mismatch',
      files: ordinaryFiles.map(file => file.path),
      fileBytesMatched,
      backupHash,
      restoreHash,
      kernel,
    };
  } catch (_error) {
    return { status: 'FAIL', reason: 'backup_restore_io_failure', files: ordinaryFiles.map(file => file.path) };
  }
}

function summarizeTreeManifest(manifest) {
  return {
    status: manifest.status,
    fileCount: manifest.fileCount,
    hash: manifest.hash,
    reasons: manifest.reasons,
  };
}

async function runBeta5MigrationDryRun(projectRoot, options = {}) {
  const before = buildStateTreeManifest(projectRoot);
  const corpus = verifyBeta5Corpus(options.corpusRoot || BETA5_CORPUS_ROOT);
  const inventory = buildPrivacySafeInventory(projectRoot);
  const backup = options.proofRoot
    ? await proveBackupRestore(projectRoot, options.proofRoot)
    : { status: 'INCOMPLETE', reason: 'proof_root_not_provided', files: [] };
  const after = buildStateTreeManifest(projectRoot);
  const sourceMutated = before.hash !== after.hash || before.fileCount !== after.fileCount;
  const reasons = [];
  if (corpus.status === 'FAIL') reasons.push('corpus_integrity_failed');
  if (inventory.status === 'INCOMPLETE') reasons.push('inventory_incomplete');
  if (before.status === 'INCOMPLETE' || after.status === 'INCOMPLETE') reasons.push('source_tree_incomplete');
  if (backup.status === 'FAIL') reasons.push('backup_restore_failed');
  if (backup.status === 'INCOMPLETE') reasons.push('backup_restore_incomplete');
  if (sourceMutated) reasons.push('source_mutated');
  const failed = corpus.status === 'FAIL' || backup.status === 'FAIL' || sourceMutated;
  const incomplete = inventory.status === 'INCOMPLETE' || backup.status === 'INCOMPLETE'
    || before.status === 'INCOMPLETE' || after.status === 'INCOMPLETE';
  return {
    schemaVersion: 'forge.beta5-migration-dry-run.v1',
    status: failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS',
    corpus,
    inventory,
    backup,
    sourceTree: { before: summarizeTreeManifest(before), after: summarizeTreeManifest(after) },
    sourceMutated,
    reasons,
  };
}

module.exports = {
  BETA5_CORPUS_ROOT,
  BETA5_RELEASE_COMMIT,
  BETA5_VERSION,
  buildPrivacySafeInventory,
  buildStateTreeManifest,
  proveBackupRestore,
  runBeta5MigrationDryRun,
  verifyBeta5Corpus,
};
