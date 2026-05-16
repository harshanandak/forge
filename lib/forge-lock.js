'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCKFILE_NAME = 'forge.lock';
const AUDIT_LOG_PATH = path.join('.forge', 'log.jsonl');
const REMOTE_SOURCE_PATTERN = /^(?:https?:|gh:|gist:|npm:)/i;

function toPosixPath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function normalizeRelativePath(projectRoot, fullPath) {
  return toPosixPath(path.relative(projectRoot, fullPath));
}

function isInsideRoot(projectRoot, fullPath) {
  const relative = path.relative(projectRoot, fullPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lockPath(projectRoot) {
  return path.join(projectRoot, LOCKFILE_NAME);
}

function defaultLock() {
  return {
    version: 1,
    generatedBy: 'forge',
    extensions: [],
  };
}

function readForgeLock(projectRoot) {
  const filePath = lockPath(projectRoot);
  if (!fs.existsSync(filePath)) return defaultLock();
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    ...defaultLock(),
    ...parsed,
    extensions: Array.isArray(parsed.extensions) ? parsed.extensions : [],
  };
}

function writeForgeLock(projectRoot, lock) {
  fs.writeFileSync(lockPath(projectRoot), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

function appendAuditEvent(projectRoot, event) {
  const logPath = path.join(projectRoot, AUDIT_LOG_PATH);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({
    kind: 'forge.lock',
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    ...event,
  })}\n`, 'utf8');
}

function isRemoteSource(source) {
  return REMOTE_SOURCE_PATTERN.test(String(source || ''));
}

function resolveLocalSource(projectRoot, source) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, source);
  if (!isInsideRoot(root, resolved)) {
    throw new Error(`Source must stay inside project root: ${source}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Local source does not exist: ${source}`);
  }
  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  if (!isInsideRoot(realRoot, realResolved)) {
    throw new Error(`Source must stay inside project root: ${source}`);
  }
  if (!fs.statSync(realResolved).isFile()) {
    throw new Error(`Local source does not exist: ${source}`);
  }
  return realResolved;
}

function sourceIntegrity(filePath) {
  const digest = crypto
    .createHash('sha512')
    .update(fs.readFileSync(filePath))
    .digest('base64');
  return `sha512-${digest}`;
}

function verifyUnsupportedRemoteEntry(entry) {
  if (!isRemoteSource(entry.source)) {
    return {
      name: entry.name,
      status: 'fail',
      reason: 'unsupported remote verification requires a remote source locator',
    };
  }
  if (entry.resolvedPath || entry.integrity || entry.trust?.allowUntrusted !== true) {
    return {
      name: entry.name,
      status: 'fail',
      reason: 'unsupported remote entry has inconsistent lock metadata',
    };
  }
  return {
    name: entry.name,
    status: 'warn',
    reason: 'remote source integrity cannot be rechecked by this foundation',
  };
}

function classifySource(projectRoot, source, options = {}) {
  if (!source) {
    throw new Error('Source is required');
  }

  if (isRemoteSource(source)) {
    if (!options.allowUntrusted) {
      throw new Error(`Untrusted source refused: ${source}. Re-run with --allow-untrusted to record it explicitly.`);
    }
    return {
      trusted: false,
      allowUntrusted: true,
      resolvedPath: null,
      integrity: null,
      verification: 'unsupported-remote',
      reason: 'remote locator requires explicit --allow-untrusted',
    };
  }

  const resolvedPath = resolveLocalSource(projectRoot, source);
  return {
    trusted: true,
    allowUntrusted: false,
    resolvedPath,
    integrity: sourceIntegrity(resolvedPath),
    verification: 'sri',
    reason: 'local file inside project root',
  };
}

function upsertExtension(extensions, entry) {
  const next = extensions.filter(existing => existing.name !== entry.name);
  next.push(entry);
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

function addLockEntry(projectRoot, options) {
  const root = path.resolve(projectRoot);
  const realRoot = fs.realpathSync(root);
  const sourceInfo = classifySource(root, options.source, {
    allowUntrusted: Boolean(options.allowUntrusted),
  });
  const lock = readForgeLock(root);
  const entry = {
    name: options.name,
    source: options.source,
    resolvedPath: sourceInfo.resolvedPath ? normalizeRelativePath(realRoot, sourceInfo.resolvedPath) : null,
    integrity: sourceInfo.integrity,
    verification: sourceInfo.verification,
    trust: {
      trusted: sourceInfo.trusted,
      allowUntrusted: sourceInfo.allowUntrusted,
      reason: sourceInfo.reason,
    },
    lockedAt: new Date().toISOString(),
  };

  lock.extensions = upsertExtension(lock.extensions, entry);
  writeForgeLock(root, lock);
  appendAuditEvent(root, {
    action: 'add',
    name: entry.name,
    source: entry.source,
    trusted: entry.trust.trusted,
    verification: entry.verification,
    integrity: entry.integrity,
  });

  return { lock, entry };
}

function verifyEntry(projectRoot, entry) {
  if (entry.verification === 'unsupported-remote') {
    return verifyUnsupportedRemoteEntry(entry);
  }

  const relativePath = entry.resolvedPath || entry.source;
  const root = path.resolve(projectRoot);
  const realRoot = fs.realpathSync(root);
  const fullPath = path.resolve(realRoot, relativePath);
  if (!isInsideRoot(realRoot, fullPath)) {
    return {
      name: entry.name,
      status: 'fail',
      reason: `source escapes project root: ${relativePath}`,
    };
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return {
      name: entry.name,
      status: 'fail',
      reason: `source missing: ${relativePath}`,
    };
  }
  const realFullPath = fs.realpathSync(fullPath);
  if (!isInsideRoot(realRoot, realFullPath)) {
    return {
      name: entry.name,
      status: 'fail',
      reason: `source escapes project root: ${relativePath}`,
    };
  }

  const actual = sourceIntegrity(realFullPath);
  if (actual !== entry.integrity) {
    return {
      name: entry.name,
      status: 'fail',
      reason: `integrity mismatch: expected ${entry.integrity}, got ${actual}`,
    };
  }

  return {
    name: entry.name,
    status: 'pass',
    reason: 'integrity verified',
  };
}

function verifyForgeLock(projectRoot) {
  const lock = readForgeLock(projectRoot);
  const results = lock.extensions.map(entry => verifyEntry(projectRoot, entry));
  return {
    ok: results.every(result => result.status !== 'fail'),
    path: LOCKFILE_NAME,
    results,
    lock,
  };
}

module.exports = {
  LOCKFILE_NAME,
  AUDIT_LOG_PATH,
  addLockEntry,
  classifySource,
  readForgeLock,
  sourceIntegrity,
  verifyForgeLock,
  writeForgeLock,
};
