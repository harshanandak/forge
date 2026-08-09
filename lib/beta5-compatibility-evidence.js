'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
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
const DEFAULT_EVIDENCE_LIMITS = Object.freeze({
  maxDepth: 12,
  maxFiles: 4096,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxJsonlRows: 100000,
  maxSqliteRows: 100000,
  maxSqliteTables: 128,
  maxSqliteContentBytes: 128 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxManifestEntries: 4096,
  maxDurationMs: 30000,
});

class IncompleteEvidenceError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

class SecurityEvidenceError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function resolveLimits(overrides = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_EVIDENCE_LIMITS).map(([key, fallback]) => {
    const candidate = overrides[key];
    return [key, Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback];
  }));
}

function createBudget(options = {}) {
  const limits = resolveLimits(options.limits);
  const now = options.now || Date.now;
  const deadline = now() + limits.maxDurationMs;
  return {
    limits,
    check() {
      if (now() > deadline) throw new IncompleteEvidenceError('evidence_time_limit');
    },
  };
}

function noFollowFlag() {
  return process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
}

function readOnlyOpenFlags() {
  return process.platform === 'win32' ? 'r' : fs.constants.O_RDONLY | noFollowFlag();
}

function exclusiveWriteOpenFlags() {
  return process.platform === 'win32'
    ? 'wx'
    : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function checkRegularFile(filePath, budget, sizeReason = 'state_tree_file_size_limit') {
  budget.check();
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new SecurityEvidenceError('source_link_refused');
  if (!stat.isFile()) throw new IncompleteEvidenceError('state_tree_unsupported_entry');
  if (stat.size > budget.limits.maxFileBytes) throw new IncompleteEvidenceError(sizeReason);
  return stat;
}

function hashFileBounded(filePath, budget, sizeReason = 'state_tree_file_size_limit') {
  const stat = checkRegularFile(filePath, budget, sizeReason);
  const descriptor = fs.openSync(filePath, readOnlyOpenFlags());
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(stat, opened)) {
      throw new SecurityEvidenceError('source_changed_during_read');
    }
    for (;;) {
      budget.check();
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > budget.limits.maxFileBytes) throw new IncompleteEvidenceError(sizeReason);
      hash.update(buffer.subarray(0, read));
    }
    if (total !== opened.size) throw new SecurityEvidenceError('source_changed_during_read');
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function categoryFor(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized === 'package.json') return 'package';
  if (normalized === '.forge/kernel.sqlite') return 'kernel';
  if (normalized === '.forge/config.yaml' || normalized === '.forge/project.json') return 'config';
  if (normalized === '.forge/issues.jsonl') return 'issueProjection';
  if (normalized === '.forge/comments.jsonl') return 'commentProjection';
  if (normalized === '.forge/dependencies.jsonl') return 'dependencyProjection';
  if (normalized === '.forge/worktrees.jsonl') return 'worktreeProjection';
  if (normalized.startsWith('.forge/runs/')) return 'runEvidence';
  if (normalized.startsWith('.forge/projections/')) return 'projection';
  return 'other';
}

function summarizeCategories(files) {
  const counts = {};
  for (const file of files) counts[file.category] = (counts[file.category] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function isSafeRelativePath(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.length > 0
    && !path.isAbsolute(relativePath)
    && !relativePath.split(/[\\/]/).includes('..');
}

function aggregateHash(files) {
  const sortedFiles = [...files];
  sortedFiles.sort((left, right) => left.path.localeCompare(right.path));
  const canonical = sortedFiles
    .map(file => `${file.path}\0${file.sha256}\n`)
    .join('');
  return sha256(canonical);
}

function readFileFullyBounded(filePath, budget, maxBytes, reason) {
  const stat = checkRegularFile(filePath, budget, 'corpus_file_size_limit');
  if (stat.size > maxBytes) throw new IncompleteEvidenceError(reason);
  const descriptor = fs.openSync(filePath, readOnlyOpenFlags());
  const bytes = Buffer.alloc(stat.size);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameFileIdentity(stat, opened)) throw new SecurityEvidenceError('corpus_file_changed');
    let offset = 0;
    while (offset < bytes.length) {
      budget.check();
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length) throw new SecurityEvidenceError('corpus_file_changed');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function scanCorpusEntry(rootIdentity, absolutePath, relativePath, depth, files, totals, budget) {
  budget.check();
  if (depth > budget.limits.maxDepth) throw new IncompleteEvidenceError('corpus_depth_limit');
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new SecurityEvidenceError('corpus_link_refused');
  const identity = fs.realpathSync.native(absolutePath);
  if (!isContained(rootIdentity, identity)) throw new SecurityEvidenceError('corpus_path_escape');
  if (stat.isDirectory()) {
    const directory = fs.opendirSync(absolutePath);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        totals.entries += 1;
        if (totals.entries > budget.limits.maxFiles) throw new IncompleteEvidenceError('corpus_file_limit');
        scanCorpusEntry(
          rootIdentity,
          path.join(absolutePath, entry.name),
          path.join(relativePath, entry.name),
          depth + 1,
          files,
          totals,
          budget,
        );
      }
    } finally {
      directory.closeSync();
    }
    return;
  }
  if (!stat.isFile()) throw new SecurityEvidenceError('corpus_entry_unsupported');
  if (stat.size > budget.limits.maxFileBytes) throw new IncompleteEvidenceError('corpus_file_size_limit');
  totals.files += 1;
  totals.bytes += stat.size;
  if (totals.files > budget.limits.maxFiles) throw new IncompleteEvidenceError('corpus_file_limit');
  if (totals.bytes > budget.limits.maxBytes) throw new IncompleteEvidenceError('corpus_byte_limit');
  files.push(relativePath.replaceAll('\\', '/'));
}

function scanCorpusTree(corpusRoot, budget) {
  const rootStat = fs.lstatSync(corpusRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new SecurityEvidenceError('corpus_root_invalid');
  const rootIdentity = fs.realpathSync.native(corpusRoot);
  const files = [];
  const totals = { entries: 0, files: 0, bytes: 0 };
  const directory = fs.opendirSync(corpusRoot);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      totals.entries += 1;
      if (totals.entries > budget.limits.maxFiles) throw new IncompleteEvidenceError('corpus_file_limit');
      scanCorpusEntry(rootIdentity, path.join(corpusRoot, entry.name), entry.name, 1, files, totals, budget);
    }
  } finally {
    directory.closeSync();
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, rootIdentity };
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

function observeCorpusEntry(corpusRoot, rootIdentity, entry, budget) {
  if (!entry || typeof entry !== 'object' || !isSafeRelativePath(entry.path)
    || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
    return { reason: 'corpus_entry_invalid' };
  }
  const lexicalRoot = path.resolve(corpusRoot);
  const filePath = path.resolve(lexicalRoot, entry.path);
  const relative = path.relative(lexicalRoot, filePath);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return { reason: 'corpus_path_escape' };
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { reason: 'corpus_entry_not_regular' };
    const identity = fs.realpathSync.native(filePath);
    if (!isContained(rootIdentity, identity)) return { reason: 'corpus_path_escape' };
    const observed = { path: entry.path, sha256: hashFileBounded(filePath, budget, 'corpus_file_size_limit') };
    return observed.sha256 === entry.sha256
      ? { observed }
      : { observed, reason: 'corpus_hash_mismatch' };
  } catch (error) {
    if (error instanceof IncompleteEvidenceError || error instanceof SecurityEvidenceError) throw error;
    return { reason: 'corpus_file_missing' };
  }
}

function findUnmanifestedFiles(corpusFiles, manifestFiles) {
  const declared = new Set(manifestFiles.map(entry => entry.path));
  return corpusFiles.some(relativePath => relativePath !== 'manifest.json' && !declared.has(relativePath))
    ? ['unmanifested_file']
    : [];
}

function corpusLimitResult(error) {
  return {
    status: error instanceof IncompleteEvidenceError ? 'INCOMPLETE' : 'FAIL',
    reasons: [error.reason || 'corpus_inventory_unreadable'],
  };
}

/** Verify the frozen beta.5 corpus and its declared provenance without mutating it. */
function verifyBeta5Corpus(corpusRoot = BETA5_CORPUS_ROOT, options = {}) {
  const budget = createBudget(options);
  let manifest;
  let corpus;
  try {
    const manifestBytes = readFileFullyBounded(
      path.join(corpusRoot, 'manifest.json'),
      budget,
      budget.limits.maxManifestBytes,
      'corpus_manifest_byte_limit',
    );
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (Array.isArray(manifest.files) && manifest.files.length > budget.limits.maxManifestEntries) {
      throw new IncompleteEvidenceError('corpus_manifest_entry_limit');
    }
    corpus = scanCorpusTree(corpusRoot, budget);
  } catch (error) {
    if (error instanceof IncompleteEvidenceError || error instanceof SecurityEvidenceError) {
      return corpusLimitResult(error);
    }
    return { status: 'FAIL', reasons: ['manifest_unreadable'] };
  }

  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const metadata = validateCorpusMetadata(manifest);
  let observations;
  try {
    observations = manifestFiles.map(entry => observeCorpusEntry(corpusRoot, corpus.rootIdentity, entry, budget));
  } catch (error) {
    return corpusLimitResult(error);
  }
  const observedFiles = observations.flatMap(result => result.observed ? [result.observed] : []);
  const reasons = [
    ...metadata.reasons,
    ...observations.flatMap(result => result.reason ? [result.reason] : []),
    ...findUnmanifestedFiles(corpus.files, manifestFiles),
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
    reasons: [...new Set(reasons)].toSorted((left, right) => left.localeCompare(right)),
  };
}

function countJsonlRecords(filePath, budget) {
  const descriptor = fs.openSync(filePath, readOnlyOpenFlags());
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = '';
  let records = 0;
  let bytes = 0;
  const consume = (line) => {
    if (!line.trim()) return;
    records += 1;
    if (records > budget.limits.maxJsonlRows) throw new IncompleteEvidenceError('issue_row_limit');
    JSON.parse(line);
  };
  try {
    for (;;) {
      budget.check();
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > budget.limits.maxFileBytes) throw new IncompleteEvidenceError('issue_file_size_limit');
      pending += decoder.write(buffer.subarray(0, read));
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach(consume);
    }
    consume(pending + decoder.end());
    return records;
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectJsonl(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false, records: 0 };
  const budget = options.budget || createBudget(options);
  try {
    checkRegularFile(filePath, budget, 'issue_file_size_limit');
    const records = countJsonlRecords(filePath, budget);
    return { status: 'PASS', present: true, records };
  } catch (error) {
    return { status: 'INCOMPLETE', present: true, reason: error.reason || 'unreadable_or_malformed' };
  }
}

function inspectPackage(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false, beta5Declared: false };
  const budget = options.budget || createBudget(options);
  try {
    const stat = checkRegularFile(filePath, budget, 'package_file_size_limit');
    const descriptor = fs.openSync(filePath, readOnlyOpenFlags());
    const bytes = Buffer.alloc(stat.size);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        budget.check();
        const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== bytes.length) throw new SecurityEvidenceError('source_changed_during_read');
    } finally {
      fs.closeSync(descriptor);
    }
    const value = JSON.parse(bytes.toString('utf8'));
    const declared = [value.version, value.dependencies?.['forge-workflow'], value.devDependencies?.['forge-workflow']]
      .filter(Boolean);
    return { status: 'PASS', present: true, beta5Declared: declared.includes(BETA5_VERSION) };
  } catch (error) {
    return { status: 'INCOMPLETE', present: true, reason: error.reason || 'unreadable_or_malformed' };
  }
}

function inspectPresence(filePath) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false };
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink()
      ? { status: 'PASS', present: true, bytes: stat.size }
      : { status: 'INCOMPLETE', present: true, reason: 'not_regular_file' };
  } catch (_error) { // NOSONAR S2486 -- unreadable input is intentionally reported as incomplete.
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
  const statement = database.prepare(sql);
  try {
    return statement.all();
  } finally {
    if (typeof statement.finalize === 'function') statement.finalize();
  }
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

function inspectKernel(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return { status: 'PASS', present: false, unknowns: [] };
  const budget = options.budget || createBudget(options);
  let database;
  try {
    checkRegularFile(filePath, budget, 'kernel_file_size_limit');
    if (!hasSqliteHeader(filePath)) {
      return { status: 'INCOMPLETE', present: true, reason: 'unrecognized_database', unknowns: ['kernel_schema'] };
    }
    const runtime = selectBuiltinSQLiteRuntime();
    database = openReadOnlyDatabase(runtime, filePath);
    const tableNames = new Set(queryAll(
      runtime,
      database,
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT ${budget.limits.maxSqliteTables + 1};`,
    ).map(row => String(row.name)));
    if (tableNames.size > budget.limits.maxSqliteTables) {
      return { status: 'INCOMPLETE', present: true, reason: 'kernel_table_limit', unknowns: ['kernel_table_limit'] };
    }
    const missingTables = REQUIRED_KERNEL_TABLES.filter(table => !tableNames.has(table));
    const integrity = String(queryOne(runtime, database, 'PRAGMA quick_check;').quick_check || 'unknown');
    const counts = missingTables.length === 0 ? countKernelRows(runtime, database) : null;
    if (counts && Object.values(counts).some(count => count > budget.limits.maxSqliteRows)) {
      return { status: 'INCOMPLETE', present: true, reason: 'kernel_row_limit', unknowns: ['kernel_row_limit'] };
    }
    const migrationCount = tableNames.has('kernel_migrations')
      ? Number(queryOne(runtime, database, 'SELECT COUNT(*) AS count FROM kernel_migrations;').count || 0)
      : 0;
    if (migrationCount > budget.limits.maxSqliteRows) {
      return { status: 'INCOMPLETE', present: true, reason: 'kernel_row_limit', unknowns: ['kernel_row_limit'] };
    }
    const migrationIds = migrationCount > 0
      ? queryAll(runtime, database, `SELECT id FROM kernel_migrations ORDER BY id LIMIT ${budget.limits.maxSqliteRows + 1};`)
        .map(row => String(row.id))
      : [];
    const unknowns = [];
    if (missingTables.length > 0) unknowns.push('missing_required_tables');
    if (integrity !== 'ok') unknowns.push('integrity_check');
    if (migrationIds.length === 0) unknowns.push('migration_version');
    return {
      status: unknowns.length === 0 ? 'PASS' : 'INCOMPLETE',
      present: true,
      schemaVersion: migrationIds.at(-1) || null,
      migrationCount,
      counts,
      additionalTableCount: Math.max(0, tableNames.size - (REQUIRED_KERNEL_TABLES.length - missingTables.length)),
      unknowns,
    };
  } catch (error) {
    return {
      status: 'INCOMPLETE',
      present: true,
      reason: error.reason || 'unreadable_or_unsupported',
      unknowns: ['kernel_schema'],
    };
  } finally {
    closeDatabase(database);
  }
}

/** Inventory supported beta.5 state surfaces without returning user-controlled values. */
function buildPrivacySafeInventory(projectRoot, options = {}) {
  const budget = createBudget(options);
  const surfaces = {
    package: inspectPackage(path.join(projectRoot, 'package.json'), { budget }),
    config: inspectPresence(path.join(projectRoot, '.forge', 'config.yaml')),
    project: inspectPresence(path.join(projectRoot, '.forge', 'project.json')),
    issues: inspectJsonl(path.join(projectRoot, '.forge', 'issues.jsonl'), { budget }),
    kernel: inspectKernel(path.join(projectRoot, '.forge', 'kernel.sqlite'), { budget }),
  };
  const unknowns = [];
  if (surfaces.package.status === 'INCOMPLETE') unknowns.push('package_contract');
  if (surfaces.package.status === 'PASS' && !surfaces.package.beta5Declared) unknowns.push('beta5_install_contract');
  if (surfaces.config.status === 'INCOMPLETE') unknowns.push('config_shape');
  if (surfaces.project.status === 'INCOMPLETE') unknowns.push('project_marker');
  if (surfaces.issues.status === 'INCOMPLETE') unknowns.push('issue_records');
  if (surfaces.issues.reason === 'issue_row_limit') unknowns.push('issue_row_limit');
  if (surfaces.kernel.status === 'INCOMPLETE') unknowns.push(...surfaces.kernel.unknowns);
  return {
    schemaVersion: 'forge.beta5-inventory.v1',
    status: unknowns.length === 0 ? 'PASS' : 'INCOMPLETE',
    surfaces,
    unknowns: [...new Set(unknowns)].toSorted((left, right) => left.localeCompare(right)),
  };
}

function isContained(rootIdentity, candidateIdentity) {
  const relative = path.relative(rootIdentity, candidateIdentity);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function recordStateEntry(rootIdentity, absolutePath, relativePath, depth, files, totals, budget) {
  budget.check();
  if (depth > budget.limits.maxDepth) throw new IncompleteEvidenceError('state_tree_depth_limit');
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new IncompleteEvidenceError('state_tree_contains_link');
  const identity = fs.realpathSync.native(absolutePath);
  if (!isContained(rootIdentity, identity)) throw new IncompleteEvidenceError('state_tree_outside_root');
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      recordStateEntry(
        rootIdentity,
        path.join(absolutePath, entry),
        path.join(relativePath, entry),
        depth + 1,
        files,
        totals,
        budget,
      );
    }
    return;
  }
  if (!stat.isFile()) throw new IncompleteEvidenceError('state_tree_unsupported_entry');
  if (stat.size > budget.limits.maxFileBytes) throw new IncompleteEvidenceError('state_tree_file_size_limit');
  totals.files += 1;
  totals.bytes += stat.size;
  if (totals.files > budget.limits.maxFiles) throw new IncompleteEvidenceError('state_tree_file_limit');
  if (totals.bytes > budget.limits.maxBytes) throw new IncompleteEvidenceError('state_tree_byte_limit');
  const normalizedPath = relativePath.replaceAll('\\', '/');
  files.push({ path: normalizedPath, category: categoryFor(normalizedPath), sha256: hashFileBounded(absolutePath, budget) });
}

function scanStateTree(projectRoot, options = {}) {
  const reasons = [];
  const files = [];
  const budget = options.budget || createBudget(options);
  try {
    const rootStat = fs.lstatSync(projectRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new IncompleteEvidenceError('state_root_not_directory');
    }
    const rootIdentity = fs.realpathSync.native(projectRoot);
    const totals = { files: 0, bytes: 0 };
    for (const relativePath of ['.forge', 'package.json']) {
      const absolutePath = path.join(projectRoot, relativePath);
      if (fs.existsSync(absolutePath)) {
        recordStateEntry(rootIdentity, absolutePath, relativePath, 1, files, totals, budget);
      }
    }
  } catch (error) {
    reasons.push(error.reason || 'state_tree_unreadable');
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    status: reasons.length === 0 ? 'PASS' : 'INCOMPLETE',
    fileCount: files.length,
    hash: aggregateHash(files),
    categories: summarizeCategories(files),
    files,
    reasons: [...new Set(reasons)].toSorted((left, right) => left.localeCompare(right)),
  };
}

/** Build a bounded content manifest for the supported project state tree. */
function buildStateTreeManifest(projectRoot, options = {}) {
  const tree = scanStateTree(projectRoot, options);
  return {
    status: tree.status,
    fileCount: tree.fileCount,
    hash: tree.hash,
    categories: tree.categories,
    reasons: tree.reasons,
  };
}

function isKernelSidecar(relativePath) {
  return /^\.forge\/kernel\.sqlite(?:-(?:wal|shm))?$/.test(relativePath);
}

function validateContainedDirectory(rootIdentity, directoryPath, reason) {
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SecurityEvidenceError(reason);
  const identity = fs.realpathSync.native(directoryPath);
  if (!isContained(rootIdentity, identity)) throw new SecurityEvidenceError(reason);
  return identity;
}

function validateBoundDirectory(directoryPath, expectedIdentity, reason) {
  const identity = validateContainedDirectory(expectedIdentity, directoryPath, reason);
  if (identity !== expectedIdentity) throw new SecurityEvidenceError(reason);
  return identity;
}

function ensureSecureParent(rootPath, rootIdentity, relativePath) {
  validateBoundDirectory(rootPath, rootIdentity, 'destination_root_changed');
  let current = rootPath;
  for (const part of path.dirname(relativePath).split(/[\\/]/).filter(part => part && part !== '.')) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    validateContainedDirectory(rootIdentity, current, 'destination_link_refused');
  }
  return rootIdentity;
}

function assertDestinationContext(context) {
  validateBoundDirectory(context.proofRoot, context.proofIdentity, 'proof_root_changed');
  validateBoundDirectory(context.destinationRoot, context.destinationIdentity, 'destination_root_changed');
  if (!isContained(context.proofIdentity, context.destinationIdentity)) {
    throw new SecurityEvidenceError('destination_root_changed');
  }
}

function copyOpenDescriptors(sourceDescriptor, targetDescriptor, expectedSize, budget) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    budget.check();
    const read = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > budget.limits.maxFileBytes) throw new IncompleteEvidenceError('state_tree_file_size_limit');
    let written = 0;
    while (written < read) written += fs.writeSync(targetDescriptor, buffer, written, read - written);
  }
  if (total !== expectedSize) throw new SecurityEvidenceError('source_changed_during_copy');
  fs.fsyncSync(targetDescriptor);
}

function sameFileIdentity(before, after) {
  return before.size === after.size && before.dev === after.dev && before.ino === after.ino;
}

function copyFileSecure(sourceRoot, destinationContext, file, budget, testHooks = {}) {
  budget.check();
  if (!isSafeRelativePath(file.path)) throw new SecurityEvidenceError('source_path_refused');
  const sourceIdentity = validateContainedDirectory(
    fs.realpathSync.native(sourceRoot),
    sourceRoot,
    'source_root_changed',
  );
  const sourcePath = path.join(sourceRoot, file.path);
  testHooks.beforeSourceOpen?.({ sourcePath });
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) throw new SecurityEvidenceError('source_link_refused');
  const sourceRealPath = fs.realpathSync.native(sourcePath);
  if (!isContained(sourceIdentity, sourceRealPath)) throw new SecurityEvidenceError('source_link_refused');
  if (!sourceStat.isFile()) throw new SecurityEvidenceError('source_not_regular');
  if (sourceStat.size > budget.limits.maxFileBytes) throw new IncompleteEvidenceError('state_tree_file_size_limit');

  testHooks.beforeDestinationOpen?.();
  assertDestinationContext(destinationContext);
  const destinationIdentity = ensureSecureParent(
    destinationContext.destinationRoot,
    destinationContext.destinationIdentity,
    file.path,
  );
  const target = path.join(destinationContext.destinationRoot, file.path);
  let sourceDescriptor;
  let targetDescriptor;
  try {
    sourceDescriptor = fs.openSync(sourcePath, readOnlyOpenFlags());
    const openedSource = fs.fstatSync(sourceDescriptor);
    const currentSourceStat = fs.lstatSync(sourcePath);
    const currentSourceIdentity = currentSourceStat.isSymbolicLink() ? null : fs.realpathSync.native(sourcePath);
    if (!openedSource.isFile() || !sameFileIdentity(sourceStat, openedSource)
      || !sameFileIdentity(sourceStat, currentSourceStat) || currentSourceIdentity !== sourceRealPath) {
      throw new SecurityEvidenceError('source_changed_during_copy');
    }
    assertDestinationContext(destinationContext);
    validateContainedDirectory(destinationIdentity, path.dirname(target), 'destination_link_refused');
    targetDescriptor = fs.openSync(target, exclusiveWriteOpenFlags(), 0o600);
    copyOpenDescriptors(sourceDescriptor, targetDescriptor, openedSource.size, budget);
  } finally {
    if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

function copyManifestFiles(sourceRoot, destinationContext, files, budget, testHooks) {
  for (const file of files) {
    copyFileSecure(sourceRoot, destinationContext, file, budget, testHooks);
  }
}

function normalizeSqlValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return value;
}

function normalizeSqlRow(row) {
  const keys = Object.keys(row);
  keys.sort((left, right) => left.localeCompare(right));
  return Object.fromEntries(keys.map(key => [key, normalizeSqlValue(row[key])]));
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function boundedTableRows(runtime, database, table, count, budget) {
  const columns = queryAll(runtime, database, `PRAGMA table_info(${quoteIdentifier(table)});`)
    .slice(0, budget.limits.maxSqliteTables + 1)
    .map(row => String(row.name));
  if (columns.length > budget.limits.maxSqliteTables) throw new IncompleteEvidenceError('kernel_column_limit');
  const selection = columns.map(quoteIdentifier).join(', ');
  const rowHashes = [];
  let contentBytes = 0;
  for (let offset = 0; offset < count; offset += 256) {
    budget.check();
    const limit = Math.min(256, count - offset);
    const page = queryAll(
      runtime,
      database,
      `SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY rowid LIMIT ${limit} OFFSET ${offset};`,
    );
    for (const row of page) {
      const encoded = JSON.stringify(normalizeSqlRow(row));
      contentBytes += Buffer.byteLength(encoded);
      if (contentBytes > budget.limits.maxSqliteContentBytes) {
        throw new IncompleteEvidenceError('kernel_content_byte_limit');
      }
      rowHashes.push(sha256(encoded));
    }
  }
  rowHashes.sort((left, right) => left.localeCompare(right));
  return { contentBytes, rowHashes };
}

function appendTableSignature(runtime, database, table, budget, contentHash, counts, totals) {
  const count = Number(queryOne(
    runtime,
    database,
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)};`,
  ).count || 0);
  if (count > budget.limits.maxSqliteRows) throw new IncompleteEvidenceError('kernel_row_limit');
  counts[table] = count;
  const bounded = boundedTableRows(runtime, database, table, count, budget);
  totals.contentBytes += bounded.contentBytes;
  if (totals.contentBytes > budget.limits.maxSqliteContentBytes) {
    throw new IncompleteEvidenceError('kernel_content_byte_limit');
  }
  contentHash.update(`${table}\0${bounded.rowHashes.join('\n')}\n`);
}

function kernelSemanticSignature(databasePath, options = {}) {
  const budget = options.budget || createBudget(options);
  checkRegularFile(databasePath, budget, 'kernel_file_size_limit');
  const runtime = selectBuiltinSQLiteRuntime();
  const database = openReadOnlyDatabase(runtime, databasePath);
  try {
    budget.check();
    const integrity = String(queryOne(runtime, database, 'PRAGMA quick_check;').quick_check || 'unknown');
    const schemaRows = queryAll(
      runtime,
      database,
      `SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'kernel_%' `
        + `ORDER BY type, name LIMIT ${budget.limits.maxSqliteTables + 1};`,
    ).map(normalizeSqlRow);
    if (schemaRows.length > budget.limits.maxSqliteTables) {
      throw new IncompleteEvidenceError('kernel_table_limit');
    }
    const presentTables = new Set(schemaRows.filter(row => row.type === 'table').map(row => row.name));
    const counts = {};
    const contentHash = crypto.createHash('sha256');
    const totals = { contentBytes: 0 };
    for (const table of REQUIRED_KERNEL_TABLES) {
      budget.check();
      if (!presentTables.has(table)) continue;
      appendTableSignature(runtime, database, table, budget, contentHash, counts, totals);
    }
    return {
      integrity,
      schemaHash: sha256(JSON.stringify(schemaRows)),
      contentHash: contentHash.digest('hex'),
      counts,
    };
  } finally {
    closeDatabase(database);
  }
}

function writeBufferSecure(destinationContext, relativePath, bytes, budget, testHooks) {
  if (bytes.length > budget.limits.maxFileBytes) throw new IncompleteEvidenceError('kernel_file_size_limit');
  testHooks.beforeKernelBackupWrite?.();
  assertDestinationContext(destinationContext);
  const destinationIdentity = ensureSecureParent(
    destinationContext.destinationRoot,
    destinationContext.destinationIdentity,
    relativePath,
  );
  const target = path.join(destinationContext.destinationRoot, relativePath);
  assertDestinationContext(destinationContext);
  validateContainedDirectory(destinationIdentity, path.dirname(target), 'destination_link_refused');
  const descriptor = fs.openSync(target, exclusiveWriteOpenFlags(), 0o600);
  try {
    let written = 0;
    while (written < bytes.length) {
      budget.check();
      written += fs.writeSync(descriptor, bytes, written, bytes.length - written);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function createKernelBackup(sourcePath, destinationContext, relativePath, budget, options = {}) {
  checkRegularFile(sourcePath, budget, 'kernel_file_size_limit');
  const runtime = options.backupRuntime || selectBuiltinSQLiteRuntime();
  const testHooks = options.testHooks || {};
  const database = openReadOnlyDatabase(runtime, sourcePath);
  try {
    if (runtime.id === 'bun:sqlite') {
      if (typeof database.serialize !== 'function') throw new Error('bun sqlite backup unavailable');
      writeBufferSecure(destinationContext, relativePath, Buffer.from(database.serialize()), budget, testHooks);
      return;
    }
    testHooks.beforeKernelBackupWrite?.();
    assertDestinationContext(destinationContext);
    const backupPath = path.join(destinationContext.destinationRoot, relativePath);
    ensureSecureParent(destinationContext.destinationRoot, destinationContext.destinationIdentity, relativePath);
    assertDestinationContext(destinationContext);
    testHooks.beforeNodeBackupTargetCheck?.({ backupPath });
    if (fs.lstatSync(backupPath, { throwIfNoEntry: false })) {
      throw new SecurityEvidenceError('destination_link_refused');
    }
    if (typeof runtime.module.backup === 'function') {
      await runtime.module.backup(database, backupPath);
    } else if (typeof database.backup === 'function') {
      await database.backup(backupPath);
    } else {
      throw new TypeError('node sqlite backup unavailable');
    }
    const targetStat = fs.lstatSync(backupPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new SecurityEvidenceError('destination_link_refused');
    assertDestinationContext(destinationContext);
    validateContainedDirectory(destinationContext.destinationIdentity, path.dirname(backupPath), 'destination_link_refused');
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
      return { error: 'proof_root_link_refused' };
    }
    if (!sourceStat.isDirectory() || !proofStat.isDirectory() || !tempStat.isDirectory()) {
      return { error: 'proof_root_unavailable' };
    }
    const source = fs.realpathSync.native(sourceRoot);
    const proof = fs.realpathSync.native(proofRoot);
    const temporary = fs.realpathSync.native(os.tmpdir());
    if (!isContained(temporary, proof) || proof === temporary) return { error: 'proof_root_not_temporary' };
    if (isContained(source, proof) || isContained(proof, source)) return { error: 'proof_root_overlaps_source' };
    if (fs.readdirSync(proofRoot).length > 0) return { error: 'proof_destination_not_empty' };
    return { proofIdentity: proof };
  } catch (_error) { // NOSONAR S2486 -- invalid proof roots fail closed to a stable reason.
    return { error: 'proof_root_unavailable' };
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

function createSecureProofChild(proofRoot, proofIdentity, name) {
  validateBoundDirectory(proofRoot, proofIdentity, 'proof_root_changed');
  const child = path.join(proofRoot, name);
  fs.mkdirSync(child);
  const destinationIdentity = validateContainedDirectory(proofIdentity, child, 'proof_root_changed');
  validateBoundDirectory(proofRoot, proofIdentity, 'proof_root_changed');
  return { proofRoot, proofIdentity, destinationRoot: child, destinationIdentity };
}

function privateEvidenceSummary(files) {
  return {
    fileCount: files.length,
    categories: summarizeCategories(files),
  };
}

/** Prove isolated byte and semantic restoration while leaving the source untouched. */
async function proveBackupRestore(sourceRoot, proofRoot, options = {}) {
  const proofValidation = validateProofRoots(sourceRoot, proofRoot);
  if (proofValidation.error) {
    return { status: 'FAIL', reason: proofValidation.error, fileCount: 0, categories: {} };
  }
  const budget = createBudget(options);
  const sourceManifest = scanStateTree(sourceRoot, { budget });
  const summary = privateEvidenceSummary(sourceManifest.files);
  if (sourceManifest.status !== 'PASS') {
    return { status: 'INCOMPLETE', reason: sourceManifest.reasons[0] || 'source_tree_incomplete', ...summary };
  }
  if (sourceManifest.fileCount === 0) return { status: 'INCOMPLETE', reason: 'no_known_state_files', ...summary };
  const ordinaryFiles = sourceManifest.files.filter(file => !isKernelSidecar(file.path));
  const kernelRelativePath = '.forge/kernel.sqlite';
  const hasKernel = sourceManifest.files.some(file => file.path === kernelRelativePath);
  try {
    const backup = createSecureProofChild(proofRoot, proofValidation.proofIdentity, 'backup');
    const restore = createSecureProofChild(proofRoot, proofValidation.proofIdentity, 'restore');
    copyManifestFiles(sourceRoot, backup, ordinaryFiles, budget, options.testHooks);
    let sourceKernelSignature = null;
    if (hasKernel) {
      sourceKernelSignature = kernelSemanticSignature(path.join(sourceRoot, kernelRelativePath), { budget });
      await createKernelBackup(
        path.join(sourceRoot, kernelRelativePath),
        backup,
        kernelRelativePath,
        budget,
        options,
      );
    }
    const backupFiles = [...ordinaryFiles];
    if (hasKernel) backupFiles.push({ path: kernelRelativePath, category: 'kernel' });
    copyManifestFiles(backup.destinationRoot, restore, backupFiles, budget);
    const sourceHash = aggregateHash(ordinaryFiles);
    const backupHash = aggregateHash(ordinaryFiles.map(file => ({
      path: file.path,
      sha256: hashFileBounded(path.join(backup.destinationRoot, file.path), budget),
    })));
    const restoreHash = aggregateHash(ordinaryFiles.map(file => ({
      path: file.path,
      sha256: hashFileBounded(path.join(restore.destinationRoot, file.path), budget),
    })));
    const kernel = hasKernel
      ? compareKernelSignatures(
        sourceKernelSignature,
        kernelSemanticSignature(path.join(restore.destinationRoot, kernelRelativePath), { budget }),
      )
      : null;
    const kernelMatches = !kernel || (kernel.integrity === 'ok' && kernel.schemaHashMatched
      && kernel.contentHashMatched && kernel.countsMatched);
    const fileBytesMatched = sourceHash === backupHash && backupHash === restoreHash;
    return {
      status: fileBytesMatched && kernelMatches ? 'PASS' : 'FAIL',
      reason: fileBytesMatched && kernelMatches ? null : 'backup_restore_mismatch',
      ...summary,
      fileBytesMatched,
      backupHash,
      restoreHash,
      kernel,
    };
  } catch (error) {
    return {
      status: error instanceof IncompleteEvidenceError ? 'INCOMPLETE' : 'FAIL',
      reason: error.reason || 'backup_restore_io_failure',
      ...summary,
    };
  }
}

function summarizeTreeManifest(manifest) {
  return {
    status: manifest.status,
    fileCount: manifest.fileCount,
    hash: manifest.hash,
    categories: manifest.categories,
    reasons: manifest.reasons,
  };
}

/** Produce a deterministic compatibility verdict from inventory and restore evidence. */
async function runBeta5MigrationDryRun(projectRoot, options = {}) {
  const before = buildStateTreeManifest(projectRoot, options);
  const corpus = verifyBeta5Corpus(options.corpusRoot || BETA5_CORPUS_ROOT, options);
  const inventory = buildPrivacySafeInventory(projectRoot, options);
  const backup = options.proofRoot
    ? await proveBackupRestore(projectRoot, options.proofRoot, options)
    : { status: 'INCOMPLETE', reason: 'proof_root_not_provided', fileCount: 0, categories: {} };
  const after = buildStateTreeManifest(projectRoot, options);
  const sourceMutated = before.hash !== after.hash || before.fileCount !== after.fileCount;
  const reasons = [];
  if (corpus.status === 'FAIL') reasons.push('corpus_integrity_failed');
  if (corpus.status === 'INCOMPLETE') reasons.push('corpus_verification_incomplete');
  if (inventory.status === 'INCOMPLETE') reasons.push('inventory_incomplete');
  if (before.status === 'INCOMPLETE' || after.status === 'INCOMPLETE') reasons.push('source_tree_incomplete');
  if (backup.status === 'FAIL') reasons.push('backup_restore_failed');
  if (backup.status === 'INCOMPLETE') reasons.push('backup_restore_incomplete');
  if (sourceMutated) reasons.push('source_mutated');
  const failed = corpus.status === 'FAIL' || backup.status === 'FAIL' || sourceMutated;
  const incomplete = corpus.status === 'INCOMPLETE' || inventory.status === 'INCOMPLETE' || backup.status === 'INCOMPLETE'
    || before.status === 'INCOMPLETE' || after.status === 'INCOMPLETE';
  let status = 'PASS';
  if (failed) status = 'FAIL';
  else if (incomplete) status = 'INCOMPLETE';
  return {
    schemaVersion: 'forge.beta5-migration-dry-run.v1',
    status,
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
