const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MEMORY_FILE = path.join('.forge', 'memory', 'entries.jsonl');
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30000;
const DEFAULT_DEAD_LOCK_GRACE_MS = 1000;

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
    const lockStat = fs.statSync(lockPath);
    const metadataPath = lockStat.isDirectory()
      ? path.join(lockPath, 'owner.json')
      : lockPath;
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
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

function isLockDirectory(lockPath) {
  try {
    return fs.statSync(lockPath).isDirectory();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    return false;
  }
}

function lockPathAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    return null;
  }
}

function lockAgeMs(lock) {
  const createdAt = Date.parse(lock?.createdAt);
  if (Number.isNaN(createdAt)) return null;
  return Date.now() - createdAt;
}

function debugSuppressedLockError(message, err) {
  if (process.env.FORGE_DEBUG_LOCKS) {
    console.debug(`${message}: ${err.message}`);
  }
}

function shouldKeepInvalidLock(lockPath, lock, options) {
  if (!lock.invalid) {
    return false;
  }

  const lockDirectory = isLockDirectory(lockPath);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  if (!lockDirectory) {
    return !invalidLockIsOld(lockPath, options);
  }

  const invalidDirectoryGraceMs = Math.max(lockRetryMs * 2, lockTimeoutMs);
  const lockPathAge = lockPathAgeMs(lockPath);
  return lockPathAge !== null && lockPathAge >= 0 && lockPathAge < invalidDirectoryGraceMs;
}

function shouldKeepDeadOwnerLock(lock, options) {
  if (lock.invalid) {
    return false;
  }

  const configuredGraceMs = options.deadLockGraceMs ?? DEFAULT_DEAD_LOCK_GRACE_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadLockGraceMs = lockTimeoutMs <= configuredGraceMs ? 0 : configuredGraceMs;
  const age = lockAgeMs(lock);
  const tokenizedLock = typeof lock?.token === 'string' && lock.token !== '';
  const tokenRecoveryGraceMs = Math.max(deadLockGraceMs, Math.floor(lockTimeoutMs * 0.9));

  if (tokenizedLock && age !== null && age >= 0 && age < tokenRecoveryGraceMs) {
    return true;
  }

  return age !== null && age >= 0 && age < deadLockGraceMs;
}

function removeLockPath(lockPath) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    debugSuppressedLockError(`project memory lock cleanup skipped for ${lockPath}`, err);
    return false;
  }
}

function removeStaleLock(lockPath, options = {}) {
  const lock = readLock(lockPath);
  if (shouldKeepInvalidLock(lockPath, lock, options)) {
    return false;
  }

  if (isProcessAlive(lock?.pid)) {
    return false;
  }

  if (shouldKeepDeadOwnerLock(lock, options)) {
    return false;
  }

  return removeLockPath(lockPath);
}

function acquireLock(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  const startedAt = Date.now();
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  while (true) {
    let lockCreated = false;
    try {
      fs.mkdirSync(lockPath);
      lockCreated = true;
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token,
      }), 'utf8');

      return () => {
        const lock = readLock(lockPath);
        if (!lock.invalid && lock.pid === process.pid && lock.token === token) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      };
    } catch (err) {
      if (lockCreated) {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
      if (err.code !== 'EEXIST') {
        throw err;
      }
      if (removeStaleLock(lockPath, options)) {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw err;
      }
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

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.trim() === '') return [];

  const hasTerminatingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  if (hasTerminatingNewline && lines.at(-1) === '') {
    lines.pop();
  }

  const entries = [];
  lines.forEach((line, index) => {
    const trailingIncompleteLine = !hasTerminatingNewline && index === lines.length - 1;
    if (trailingIncompleteLine) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (trailingIncompleteLine) return;
      throw new Error(`invalid project memory JSONL at line ${index + 1}: ${err.message}`);
    }
    try {
      validateStoredEntry(parsed);
    } catch (err) {
      if (trailingIncompleteLine) return;
      throw new Error(`invalid project memory entry at line ${index + 1}: ${err.message}`);
    }
    entries.push(parsed);
  });

  return dedupeEntries(entries);
}

function dedupeEntries(entries) {
  const positions = new Map();
  const deduped = [];

  for (const entry of entries) {
    const existingIndex = positions.get(entry.key);
    if (existingIndex === undefined) {
      positions.set(entry.key, deduped.length);
      deduped.push(entry);
    } else {
      deduped[existingIndex] = entry;
    }
  }

  return deduped;
}

function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function normalizeJsonlTail(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content === '' || /\r?\n$/.test(content)) {
    return false;
  }

  const lastLineStart = Math.max(content.lastIndexOf('\n'), content.lastIndexOf('\r')) + 1;
  fs.truncateSync(filePath, Buffer.byteLength(content.slice(0, lastLineStart), 'utf8'));
  return false;
}

function appendEntry(projectRoot, entry, options = {}) {
  const filePath = memoryPath(projectRoot, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const needsLineBreak = normalizeJsonlTail(filePath);
  const record = Buffer.from(`${needsLineBreak ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8');
  const fd = fs.openSync(filePath, 'a');
  try {
    writeAllSync(fd, record);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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
    const normalized = toDiskEntry({
      ...entry,
      key: entry.key.trim(),
      sourceAgent: (entry.sourceAgent || entry['source-agent']).trim(),
      tags: entry.tags || [],
    });

    appendEntry(projectRoot, normalized, options);
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
