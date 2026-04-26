const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MEMORY_FILE = path.join('.forge', 'memory', 'entries.jsonl');
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30000;

function assertInsideProjectRoot(root, targetPath) {
  const relative = path.relative(root, targetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('project memory filePath must stay within projectRoot');
  }
}

function nearestExistingPath(targetPath) {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  return current;
}

function assertRealPathInsideProjectRoot(root, targetPath) {
  const realRoot = fs.realpathSync.native(root);
  const existingPath = fs.existsSync(targetPath)
    ? targetPath
    : nearestExistingPath(path.dirname(targetPath));
  const realExistingPath = fs.realpathSync.native(existingPath);

  if (realExistingPath === realRoot) {
    return;
  }

  assertInsideProjectRoot(realRoot, realExistingPath);
}

function memoryPath(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  if (!options.filePath) {
    const defaultPath = path.join(root, DEFAULT_MEMORY_FILE);
    assertRealPathInsideProjectRoot(root, defaultPath);
    return defaultPath;
  }

  const candidate = path.isAbsolute(options.filePath)
    ? options.filePath
    : path.join(root, options.filePath);
  const resolved = path.resolve(candidate);
  assertInsideProjectRoot(root, resolved);
  assertRealPathInsideProjectRoot(root, resolved);

  return resolved;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    return {
      pid: null,
      createdAt: null,
      invalid: true,
      readError: err.message,
    };
  }
}

function invalidLockIsOld(lockPath, options = {}) {
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs >= staleLockMs;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function removeStaleLock(lockPath, options = {}) {
  const lock = readLock(lockPath);
  if (lock.invalid && !invalidLockIsOld(lockPath, options)) {
    return false;
  }

  const ownerAlive = isProcessAlive(lock?.pid);

  if (!ownerAlive) {
    fs.rmSync(lockPath, { force: true });
    return true;
  }

  return false;
}

function acquireLock(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  const startedAt = Date.now();

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  while (true) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }), { flag: 'wx' });

      return () => {
        fs.rmSync(lockPath, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST' || Date.now() - startedAt >= timeoutMs) {
        throw err;
      }
      removeStaleLock(lockPath, options);
      sleep(retryMs);
    }
  }
}

function toApiEntry(entry) {
  const apiEntry = {
    key: entry.key,
    value: entry.value,
    sourceAgent: entry['source-agent'],
    timestamp: entry.timestamp,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
  };

  if (entry.scope !== undefined) apiEntry.scope = entry.scope;
  if (entry.confidence !== undefined) apiEntry.confidence = entry.confidence;
  if (entry.supersedes !== undefined) apiEntry.supersedes = [...entry.supersedes];
  if (entry['beads-refs'] !== undefined) apiEntry.beadsRefs = [...entry['beads-refs']];

  return apiEntry;
}

function toDiskEntry(entry) {
  const diskEntry = {
    key: entry.key,
    value: entry.value,
    'source-agent': entry.sourceAgent || entry['source-agent'],
    timestamp: entry.timestamp || new Date().toISOString(),
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
  };

  if (entry.scope !== undefined) diskEntry.scope = entry.scope;
  if (entry.confidence !== undefined) diskEntry.confidence = entry.confidence;
  if (entry.supersedes !== undefined) diskEntry.supersedes = [...entry.supersedes];
  if (entry.beadsRefs !== undefined || entry['beads-refs'] !== undefined) {
    diskEntry['beads-refs'] = [...(entry.beadsRefs || entry['beads-refs'])];
  }

  return diskEntry;
}

function assertEntryObject(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('project memory entry must be an object');
  }
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`project memory entry ${fieldName} is required`);
  }
}

function assertStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`project memory entry ${fieldName} must be an array of strings`);
  }
}

function validateRequiredFields(entry) {
  if (typeof entry.key !== 'string' || entry.key.trim() === '') {
    throw new TypeError('project memory entry key is required');
  }
  if (!Object.hasOwn(entry, 'value') || entry.value === undefined) {
    throw new TypeError('project memory entry value is required');
  }

  const sourceAgent = entry.sourceAgent || entry['source-agent'];
  assertRequiredString(sourceAgent, 'sourceAgent');
}

function validateTimestamp(entry) {
  if (entry.timestamp !== undefined) {
    const parsed = Date.parse(entry.timestamp);
    if (typeof entry.timestamp !== 'string' || Number.isNaN(parsed)) {
      throw new TypeError('project memory entry timestamp must be an ISO-compatible string');
    }
  }
}

function validateScope(entry) {
  if (entry.scope !== undefined && (typeof entry.scope !== 'string' || entry.scope.trim() === '')) {
    throw new TypeError('project memory entry scope must be a non-empty string');
  }
}

function validateConfidence(entry) {
  if (entry.confidence !== undefined) {
    if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
      throw new TypeError('project memory entry confidence must be a number from 0 to 1');
    }
  }
}

function validateOptionalArrays(entry) {
  if (entry.tags !== undefined) assertStringArray(entry.tags, 'tags');
  if (entry.supersedes !== undefined) assertStringArray(entry.supersedes, 'supersedes');
  const beadsRefs = entry.beadsRefs || entry['beads-refs'];
  if (beadsRefs !== undefined) assertStringArray(beadsRefs, 'beadsRefs');
}

function validateEntry(entry) {
  assertEntryObject(entry);
  validateRequiredFields(entry);
  validateTimestamp(entry);
  validateScope(entry);
  validateConfidence(entry);
  validateOptionalArrays(entry);
}

function validateStoredEntry(entry) {
  validateEntry(entry);
  assertRequiredString(entry['source-agent'], 'source-agent');
  assertStringArray(entry.tags, 'tags');
}

function readEntries(projectRoot, options = {}) {
  const filePath = memoryPath(projectRoot, options);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (content === '') return [];

  return content.split(/\r?\n/).map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`invalid project memory JSONL at line ${index + 1}: ${err.message}`);
    }
    try {
      validateStoredEntry(parsed);
    } catch (err) {
      throw new Error(`invalid project memory entry at line ${index + 1}: ${err.message}`);
    }
    return parsed;
  });
}

function writeEntries(projectRoot, entries, options = {}) {
  const filePath = memoryPath(projectRoot, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(tempPath, content ? `${content}\n` : '', 'utf8');
  fs.renameSync(tempPath, filePath);
}

function list(projectRoot, options = {}) {
  return readEntries(projectRoot, options).map(toApiEntry);
}

function read(projectRoot, key, options = {}) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('project memory read key is required');
  }
  const normalizedKey = key.trim();

  const entry = readEntries(projectRoot, options).find((candidate) => candidate.key === normalizedKey);
  return entry ? toApiEntry(entry) : null;
}

function write(projectRoot, entry, options = {}) {
  validateEntry(entry);
  const filePath = memoryPath(projectRoot, options);
  const releaseLock = acquireLock(filePath, options);

  try {
    const entries = readEntries(projectRoot, options);
    const normalized = toDiskEntry({
      ...entry,
      key: entry.key.trim(),
      sourceAgent: (entry.sourceAgent || entry['source-agent']).trim(),
      tags: entry.tags || [],
    });

    const existingIndex = entries.findIndex((candidate) => candidate.key === normalized.key);
    const nextEntries = entries.filter((candidate) => candidate.key !== normalized.key);
    if (existingIndex === -1) {
      nextEntries.push(normalized);
    } else {
      nextEntries.splice(existingIndex, 0, normalized);
    }

    writeEntries(projectRoot, nextEntries, options);
    return toApiEntry(normalized);
  } finally {
    releaseLock();
  }
}

function searchableText(entry) {
  return [
    entry.key,
    JSON.stringify(entry.value),
    entry['source-agent'],
    entry.scope,
    String(entry.confidence ?? ''),
    ...(Array.isArray(entry.tags) ? entry.tags : []),
    ...(Array.isArray(entry.supersedes) ? entry.supersedes : []),
    ...(Array.isArray(entry['beads-refs']) ? entry['beads-refs'] : []),
  ].join('\n').toLowerCase();
}

function search(projectRoot, query, options = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    return [];
  }

  const needle = query.trim().toLowerCase();
  return readEntries(projectRoot, options)
    .filter((entry) => searchableText(entry).includes(needle))
    .map(toApiEntry);
}

module.exports = {
  read,
  write,
  search,
  list,
};
